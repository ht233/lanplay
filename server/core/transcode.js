'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { uid, ensureDir, clamp, humanSize, formatDuration, safeFileName } = require('./util');

const SPEEDS = [1, 1.25, 1.5, 2];

/**
 * ffmpeg 滤镜里的路径转义。
 *
 * libass 的 `ass`/`subtitles` 滤镜把 `:` 当作参数分隔符，Windows 的 `C:\...`
 * 会被误解析成 `original_size` 之类的参数（实测报错
 * `Unable to parse "original_size" option value "C:\..."`）。
 * 因此这里只取文件名（配合 spawn 的 cwd 切到字幕目录），
 * 并把滤镜里仍有特殊含义的字符转义掉。
 */
function escapeFilterPath(p) {
  const name = path.basename(p);
  return name
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * 单个转码会话：一个 ffmpeg 进程 + 一份 HLS 输出目录（generation 递增）。
 * seek / 切换字幕 / 切换音轨 / 变速 都通过重启 ffmpeg 并切换 generation 实现，
 * 客户端只需在 gen 变化时重新加载播放列表，实现简单且稳定。
 */
class TranscodeSession extends EventEmitter {
  constructor(manager, opts) {
    super();
    this.manager = manager;
    this.id = uid('s', 8);
    this.createdAt = Date.now();
    // 播放端活跃度：每次客户端拉播放列表（index.m3u8）都会刷新。
    // 播放器（浏览器/Android）每隔几秒必拉一次；没人拉 = 没人在看，
    // 空转的 ffmpeg 会一直占着 CPU/并发名额（实测：不关弹窗直接关浏览器，会话永不结束）。
    this.lastPlaylistAt = Date.now();
    this.client = opts.client || null;      // {id, name, ip, model}
    this.file = opts.file;
    this.title = opts.title || path.basename(opts.file);
    this.mediaInfo = opts.mediaInfo || null;
    this.duration = (opts.mediaInfo && opts.mediaInfo.duration) || 0;
    this.settings = Object.assign({}, manager.defaults(), opts.settings || {});
    this.state = 'STARTING';
    this.gen = 0;
    this.offset = 0;
    this.position = 0;
    this.speed = 1;
    this.audioIndex = 0;             // 第 N 条音频流（相对）
    this.subtitle = opts.subtitle || null;  // {mode:'off'|'burn'|'side', index, path, format, name}
    this.proc = null;
    this.procStartedAt = 0;
    this.lastProgressAt = 0;
    this.outTime = 0;
    this.error = '';
    this.encoderUsed = '';
    this.hardware = false;
    this.stderrTail = [];
    this.dir = path.join(manager.hlsDir, this.id);
    this.fallbackTried = false;
    this.stats = { segments: 0, bytes: 0 };
    // 源流起点取证：v/a start_time 差值大（如视频 0 / 音频 6s）= 起播时钟冻结
    //（旧 Chromium 音频时钟无数据不走 → currentTime 冻结 → nudge 跳秒）的实锤证据。
    const vi = (opts.mediaInfo && opts.mediaInfo.video) || {};
    const a0 = ((opts.mediaInfo && opts.mediaInfo.audio) || [])[0] || {};
    this.srcStartLog = `v.start_time=${Number(vi.startPts || 0).toFixed(3)} a.start_time=${Number(a0.startPts || 0).toFixed(3)}`;
    // 音频洞由服务端滤镜 aresample=async=1:first_pts=0 前置静音填充治本（见 buildArgs
    // 音频注释），不再探测/下发 audioHole，客户端也不需要跳洞。
    // 生命周期纪元：每次 start()/fallback 重启 +1；旧进程的 close 事件若属于
    // 旧纪元（epoch 不匹配），一律忽略 —— 防止「stop 后旧 ffmpeg 的 close 回调
    // 把新进程误判为异常退出」以及「stop 与 seek 竞争时旧回调触发 fallback 重启
    // 产生孤儿 ffmpeg」。
    this.epoch = 0;
    // stop() 已调用标记：置位后一切 close/error 回调不再触发重启/回退/ERROR 标记
    this.stopRequested = false;
  }

  get playlistPath() { return path.join(this.dir, `g${this.gen}`, 'index.m3u8'); }

  playlistUrl(baseUrl) { return `${baseUrl}/hls/${this.id}/g${this.gen}/index.m3u8`; }

  /** 播放端仍在拉流（serveHls 对 index.m3u8 的每次请求都会调用） */
  markPlaylistFetch() {
    this.lastPlaylistAt = Date.now();
  }

  label() {
    return `${this.id} ${this.title}`;
  }

  publicState() {
    return {
      id: this.id,
      title: this.title,
      file: this.file,
      fileName: path.basename(this.file),
      state: this.state,
      gen: this.gen,
      position: Math.round(this.position * 10) / 10,
      offset: Math.round(this.offset * 10) / 10,
      duration: this.duration,
      speed: this.speed,
      audioIndex: this.audioIndex,
      subtitle: this.subtitle ? { mode: this.subtitle.mode, index: this.subtitle.index, name: this.subtitle.name } : null,
      encoder: this.encoderUsed,
      hardware: this.hardware,
      directPlay: !!this.directPlay,
      settings: this.settings,
      client: this.client,
      error: this.error,
      createdAt: this.createdAt,
      segments: this.stats.segments
    };
  }

  async start(seconds = 0) {
    this.stopRequested = false;
    this.epoch += 1;
    const myEpoch = this.epoch;
    this._spawnEpoch = myEpoch;
    this.offset = Math.max(0, Math.min(seconds, Math.max(0, this.duration - 1)));
    this.position = this.offset;
    this.gen += 1;
    this.state = 'STARTING';
    this.error = '';
    this.outTime = 0;
    this.procStartedAt = Date.now();
    const genDir = path.join(this.dir, `g${this.gen}`);
    ensureDir(genDir);
    // 清理旧 generation 目录（保留最近一代用于客户端回退）
    this.cleanupOldGenerations();
    const args = this.buildArgs(genDir);
    this.lastArgs = args;
    this.manager.logger.info(`[${this.id}] ffmpeg: ${this.manager.ffmpeg.ffmpegPath} ${args.join(' ')} | ${this.srcStartLog}`);
    await this.spawnProc(args);
    // spawn 后如果纪元已变（期间发生了 stop/新 seek），立即杀掉这个刚起来的进程，
    // 避免它成为写已删除目录的孤儿。
    if (this._spawnEpoch !== myEpoch || this.stopRequested) {
      await this.killProc();
    }
  }

  cleanupOldGenerations() {
    try {
      const keep = new Set([`g${this.gen}`, `g${this.gen - 1}`]);
      for (const name of fs.readdirSync(this.dir)) {
        if (!keep.has(name)) fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * 选择编码器：优先硬件（同 codec），失败自动回退 CPU。
   */
  pickEncoder(codec) {
    const want = codec === 'hevc' ? 'hevc' : 'h264';
    if (this.settings.encoder === 'cpu' || !this.manager.ffmpeg) {
      return { name: want === 'hevc' ? 'libx265' : 'libx264', hardware: false, label: 'CPU 软编' };
    }
    const hw = (this.manager.ffmpeg.hwEncoders || []).find((e) => e.codec === want);
    if (hw) return { name: hw.name, hardware: true, label: hw.label };
    return { name: want === 'hevc' ? 'libx265' : 'libx264', hardware: false, label: 'CPU 软编' };
  }

  /**
   * 直通（direct play）判定：格式 + 分辨率 + 码率 三重约束，全部满足才直通。
   * 目标是「投影仪能原生硬解、网络带宽够」的源不做视频转码，只重封装 HLS：
   *   - 格式：H.264/HEVC（Android TV 硬解必支持；AV1/VP9/VC-1/MPEG2 等不保证）
   *   - 分辨率：≤ 1080p（4K 直通对低端投影仪风险高，且我们默认就是压到 1080p 的策略）
   *   - 码率：≤ 8 Mbps（高于常规 1080p 片源的 2~4 倍余量，局域网 WiFi 也稳）
   * 帧率自适应（auto）时无 fps 缩放需求；用户显式指定 fps/分辨率/码率则必须转码。
   * 字幕烧录、非 1x 倍速、HDR→SDR 一律不直通（需要重编码才能满足）。
   */
  pickDirectPlay() {
    if (this.settings.directPlay === 'off') return false;
    const info = this.mediaInfo;
    if (!info || !info.video) return false;
    const v = info.video;
    // 倍速/字幕烧录会改变时间轴或画面，必须转码
    if (this.speed !== 1) return false;
    if (this.subtitle && this.subtitle.mode === 'burn') return false;
    // 用户显式要求输出参数（非 auto/源生）时必须转码满足
    const s = this.settings;
    if (s.fps && s.fps !== 'auto' && Number(s.fps) > 0) return false;
    if (s.resolution && s.resolution !== 'auto' && s.resolution !== 'source') return false;
    // 约束 1：格式。仅 H.264 可直通——HEVC 虽然投影仪能硬解，
    // 但我们的 HLS 分片是 mpegts 容器，客户端 hls.js 不支持 TS 里的 HEVC
    // （demux 阶段直接 fatal，表现为「播放出错」），所以 HEVC 一律转码到 h264。
    const fmtOk = /^(h264)$/.test(v.codec || '');
    // 约束 2：分辨率（≤1920x1080）
    const resOk = !v.height || !v.width || (v.height <= 1088 && v.width <= 1920);
    // 约束 3：码率（≤8Mbps；流码率缺省用容器码率兜底）
    const br = v.bitrate || info.bitrate || 0;
    const brOk = !br || br <= 8 * 1000 * 1000;
    return fmtOk && resOk && brOk;
  }

  buildArgs(outDir) {
    const s = this.settings;
    const info = this.mediaInfo || {};
    const video = info.video || {};
    const audioStreams = info.audio || [];
    const hasVideo = !!video.index || video.index === 0;
    // 直通判定：三重约束（格式 h264/hevc + ≤1080p + ≤8Mbps）全过 → 只重封装不转码
    const direct = hasVideo && !this.fallbackTried && this.pickDirectPlay();
    const enc = direct
      ? { name: 'copy', hardware: false, label: '直通' }
      : this.fallbackTried || !hasVideo
        ? { name: 'libx264', hardware: false, label: 'CPU 软编' }
        : this.pickEncoder(s.codec);
    this.encoderUsed = hasVideo ? enc.name : 'audio-copy';
    this.hardware = hasVideo ? enc.hardware : false;
    this.directPlay = hasVideo && direct;
    if (this.directPlay) {
      this.manager.logger.info(`[${this.id}] 满足直通条件（${video.codec} ${video.width}x${video.height} ${Math.round((video.bitrate || info.bitrate || 0) / 1000)}kbps ≤8M），视频流直接复制，仅重封装 HLS`);
    }

    const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
    // 缩短探测时间：默认 ffmpeg 要分析 5 秒画面才确定流参数，
    // 对本地文件纯属浪费 —— 起播会因此白等 1 秒以上。
    args.push('-probesize', '2000000', '-analyzeduration', '2000000');
    // 实时读取，避免一次转完整部片；倍速时按倍速读
    args.push('-readrate', String(this.speed));
    // 起播突发：先快速转出几十秒内容，让客户端一上来就有足够分片可播，
    // 否则必须等 ffmpeg 按 1x 读满一个分片时长才能起播。
    // 首次冷启动若存货太少，播放器会在追上实时速度前断流（表现为开头反复重播）。
    // 20→30：冷读大文件（OS 文件缓存未命中）+ NVENC 初始化时首片产出慢。
    // 30→40：R6-R10 实验定案「冻结时长 = 等第一段音频数据到达渲染管线的时长」，
    // 服务端越早产出音频数据，客户端起播等待越短（客户端现为 ExoPlayer 自有缓冲策略）。
    // 实验链针对的 Chromium MSE 缺陷已随试播功能移除（补充 16），40 保留无害且改善冷读。
    args.push('-readrate_initial_burst', String(Math.max(40, (s.hlsTime || 1) * 10)));
    if (this.offset > 0.05) args.push('-ss', this.offset.toFixed(3));
    args.push('-i', this.file);

    // 图形字幕烧录（内嵌 PGS/DVD/VobSub）：overlay 保持原时间轴。
    // 必须确认文件真的有对应下标的字幕流：客户端在「字幕轨列表」里选了内嵌轨，
    // 但文件被重新封装/探测缓存过期时流可能不存在，直接引用 [0:s:N] 会让 ffmpeg
    // 报 "Stream specifier ':s:N' matches no streams" 而整个转码失败。
    const embeddedSubs = (info.subtitles || []).filter((x) => !x.external);
    const burnIndex = this.subtitle && this.subtitle.mode === 'burn' && Number.isInteger(this.subtitle.index)
      && this.subtitle.index >= 0 && this.subtitle.index < embeddedSubs.length
      ? this.subtitle.index : null;
    // 外挂字幕烧录（ASS/SSA/SRT…）：走 libass，能完整还原特效与字体
    const burnPath = this.subtitle && this.subtitle.mode === 'burn' && this.subtitle.path
      && fs.existsSync(this.subtitle.path) ? this.subtitle.path : null;
    const aidx = clamp(this.audioIndex, 0, Math.max(0, audioStreams.length - 1));

    if (!hasVideo) {
      args.push('-map', `0:a:${aidx}`, '-vn', '-c:a', 'aac', '-b:a', `${Number(s.audioBitrate) || 128}k`, '-ac', '2');
    } else if (enc.name === 'copy') {
      // 直通：视频流原样复制进 HLS（仅重封装，无解码无编码，CPU ~1-3%）。
      // copy 模式不能加滤镜/强制帧率/强制关键帧——分片时长跟随源 GOP，
      // 这是直通换性能的已知代价（源 GOP 通常 1~5s，可接受）。
      args.push('-map', '0:v:0');
      if (audioStreams.length) args.push('-map', `0:a:${aidx}`);
      else args.push('-an');
      args.push('-c:v', 'copy');
      // 音频一律重编 aac（不用 copy）：源音频流 start_time 带大偏移时（视频 0 /
      // 音频 6s），播放时钟（跟音频走）前几秒无数据 → currentTime 冻结、nudge 跳秒
      //（用户实测 0→2.1→6.1 冻 6 秒）。-af aresample=async=1:first_pts=0 用前置
      // 静音填充把音轨起点补到 0（保内容时间轴与音画同步，实测末包 PTS 与源一致），
      // 音频时钟从 0 就有数据 → 治本。无音轨时不加。
      if (audioStreams.length) {
        args.push('-c:a', 'aac', '-b:a', `${Number(s.audioBitrate) || 128}k`, '-ac', '2', '-af', 'aresample=async=1:first_pts=0');
      }
    } else {
      // 视频滤镜链
      const vf = [];
      let maxH = 0;
      const res = s.resolution;
      if (res && res !== 'auto' && res !== 'source') maxH = Number(res) || 0;
      else if (video.height && video.height > 1080) maxH = 1080;
      if (maxH) vf.push(`scale=-2:'min(${maxH},ih)'`);

      if (burnIndex !== null) {
        // 内嵌图形字幕（PGS/DVD/VobSub）：overlay 保持原时间轴
        const fc = `[0:v]${vf.length ? vf.join(',') + ',' : ''}setsar=1[base];[base][0:s:${burnIndex}]overlay=eof_action=pass[vout]`;
        if (this.speed !== 1) {
          args.push('-filter_complex', fc.replace('[vout]', `,setpts=PTS/${this.speed}[vout]`));
        } else {
          args.push('-filter_complex', fc);
        }
        args.push('-map', '[vout]');
      } else if (burnPath) {
        // 外挂字幕烧录：ASS/SSA 走 libass 完整渲染（特效/字体/位置都对），
        // SRT/VTT 等同理由 libass 按纯文本渲染。
        // 注意：libass 的 ass/subtitles 滤镜在 Windows 上不能用绝对路径
        // （盘符里的冒号会被当成滤镜参数分隔符），必须切到字幕目录后传相对文件名。
        const vfAss = vf.slice();
        vfAss.push(`ass=${escapeFilterPath(burnPath)}`);
        if (this.speed !== 1) vfAss.push(`setpts=PTS/${this.speed}`);
        args.push('-vf', vfAss.join(','));
        args.push('-map', '0:v:0');
      } else {
        if (this.speed !== 1) vf.push(`setpts=PTS/${this.speed}`);
        if (vf.length) args.push('-vf', vf.join(','));
        args.push('-map', '0:v:0');
      }
      if (audioStreams.length) args.push('-map', `0:a:${aidx}`);
      else args.push('-an');
    }

    // 视频编码参数
    if (hasVideo && enc.name !== 'copy') args.push('-c:v', enc.name);
    const quality = s.quality || 'balanced';
    const bitrate = Number(s.bitrate) || 4000;
    if (enc.name === 'libx264') {
      const preset = quality === 'quality' ? 'slow' : quality === 'speed' ? 'veryfast' : 'faster';
      args.push('-preset', preset);
      args.push('-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.4)}k`, '-bufsize', `${bitrate * 2}k`);
      args.push('-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1');
    } else if (enc.name === 'libx265') {
      args.push('-preset', 'faster', '-b:v', `${bitrate}k`, '-pix_fmt', 'yuv420p');
    } else if (enc.hardware) {
      args.push('-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.4)}k`, '-bufsize', `${bitrate * 2}k`);
      if (enc.name === 'h264_qsv' || enc.name === 'hevc_qsv') args.push('-preset', 'veryfast');
      if (enc.name === 'h264_amf' || enc.name === 'hevc_amf') args.push('-quality', 'balanced');
      if (enc.name === 'h264_nvenc' || enc.name === 'hevc_nvenc') args.push('-preset', 'p5');
      args.push('-pix_fmt', 'yuv420p');
    }

    // 帧率
    if (enc.name !== 'copy' && s.fps && s.fps !== 'auto' && Number(s.fps) > 0) args.push('-r', String(Number(s.fps)));

    // 强制关键帧对齐 HLS 分片时长。
    // HLS 只能在关键帧处切分片：如果源片 GOP 很长（动画/网剧常见 10s 一个关键帧），
    // 不强制的话分片会变成 10s 一段 ——
    //   ① 起播要等满一个分片才出画面（实测 0.6s → 10s+）
    //   ② seek 精度被拉到 10s，快进快退手感变差
    // 这里按 hlsTime 周期强制 I 帧，让分片稳定在目标时长。
    // （直通 copy 模式不能改 GOP，分片跟随源关键帧。）
    const hlsTime = Number(s.hlsTime) || 2;
    if (hasVideo && enc.name !== 'copy') args.push('-force_key_frames', `expr:gte(t,n_forced*${hlsTime})`);

    // 音频
    if (audioStreams.length && enc.name !== 'copy') {
      args.push('-c:a', 'aac', '-b:a', `${Number(s.audioBitrate) || 128}k`, '-ac', '2');
      if (this.speed !== 1) {
        const chain = ['aresample=async=1:first_pts=0'];
        let rest = this.speed;
        while (rest > 2) { chain.push('atempo=2'); rest /= 2; }
        chain.push(`atempo=${rest}`);
        args.push('-af', chain.join(','));
      }
    }
    // 音轨起点补零（1x 时）：部分源音频流 start_time 带大偏移（视频 0 / 音频 6s）。
    // 浏览器/Chromium 的播放时钟跟着音频走，音频前几秒无数据 → currentTime 冻结、
    // 画面静止 → hls.js nudge 跳秒（用户实测 0→2.1→6.1 冻 6 秒、rvfc 帧照常呈现）。
    // aresample=async=1:first_pts=0 以前置静音填充把音轨起点补到 0：音频时钟从 0
    // 就有数据（治本）；对正常源（音频本就从 0 开始）是无操作；与 asetpts 不同，
    // 它保留内容时间轴（洞内静音、内容位置不变），VTT/进度条/时长均不受影响。
    // 倍速路径上面已把 aresample 放进 atempo 链首；直通 copy 分支在上方单独处理。
    if (audioStreams.length && enc.name !== 'copy' && this.speed === 1) {
      args.push('-af', 'aresample=async=1:first_pts=0');
    }

    // HLS
    // force_key_frames（下方 -c:v 分支已加）：按 hlsTime 强制切关键帧。
    // 部分片源 GOP 很长（关键帧间隔 8-10s），ffmpeg 只能在关键帧处切分片 →
    // 首个分片可能长达 9 秒且迟迟不产出，播放端（hls.js）在 EVENT 列表增长时
    // 会对齐/重缓冲，表现为「播 3 秒跳回开头」。
    // muxdelay/muxpreload 归零：TS 分片首视频帧 PTS 默认带 ~1.4s 偏移（AAC priming
    // + B 帧重排，实测 start_time=1.423），播放端从 0 起播时找不到任何可呈现帧 →
    // bufferStalledError → bufferNudgeOnStall 连续前推（用户看到的「开头重复/跳秒」）。
    // 归零后 start_time≈0.02，起播即有帧（第二十一轮用户日志+本地复现实证）。
    // 注意：补充 5 曾加 -fflags +genpts/-copyts/-start_at_zero/-mpegts_copyts 0，
    // 用户复测（m15454）行为完全不变且帧呈现正常（rvfc 触发），证明空洞不在此处 —— 回退。
    args.push(
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-f', 'hls',
      '-hls_time', String(hlsTime),
      '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(outDir, 'seg%05d.ts'),
      '-progress', 'pipe:1',
      '-y',
      path.join(outDir, 'index.m3u8')
    );
    return args;
  }

  spawnProc(args) {
    return new Promise((resolve) => {
      const proc = spawn(this.manager.ffmpeg.ffmpegPath, args, {
      windowsHide: true,
      // 外挂字幕烧录时切到字幕目录：libass 在 Windows 上无法解析含冒号的绝对路径
      cwd: this.subtitle && this.subtitle.path ? path.dirname(this.subtitle.path) : undefined
    });
      this.proc = proc;
      this.stderrTail = [];
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      proc.stdout.on('data', (buf) => this.onProgress(buf.toString()));
      proc.stderr.on('data', (buf) => {
        const text = buf.toString().trim();
        if (!text) return;
        for (const line of text.split(/\r?\n/)) {
          this.stderrTail.push(line);
          if (this.stderrTail.length > 40) this.stderrTail.shift();
        }
      });
      proc.on('error', (err) => {
        if (this._spawnEpoch !== this.epoch || this.stopRequested) { finish(false); return; }
        this.error = `无法启动 ffmpeg：${err.message}`;
        this.setState('ERROR');
        finish(false);
      });
      proc.on('close', (code, signal) => {
        if (this.proc !== proc) return;
        // 旧纪元的进程退出：当前 proc 已被 seek/stop 换掉，这次 close 是迟到事件，
        // 不能改状态/触发回退（否则误报 ERROR 或产生孤儿重启）。
        if (this._spawnEpoch !== this.epoch) return;
        const wasPlaying = ['PLAYING', 'STARTING', 'PAUSED'].includes(this.state);
        if (this.stopRequested) return;
        if (code === 0) {
          if (this.position >= this.duration - 3 && this.duration > 0) {
            this.position = this.duration;
            this.setState('ENDED');
            this.manager.logger.success(`[${this.id}] 转码正常结束（播放到片尾）`);
          } else {
            this.setState('ENDED');
            this.manager.logger.info(`[${this.id}] 转码进程结束`);
          }
        } else if (wasPlaying && this.state !== 'STOPPED') {
          const tail = this.stderrTail.slice(-4).join(' | ');
          // 硬件编码失败：自动回退软编重试一次
          if (this.hardware && !this.fallbackTried) {
            this.fallbackTried = true;
            this.manager.logger.warn(`[${this.id}] 硬件编码失败，回退 CPU 软编重试：${tail}`);
            this.restartWithFallback().then(() => finish(false));
            return;
          }
          this.error = tail || `ffmpeg 退出码 ${code}`;
          this.setState('ERROR');
          this.manager.logger.error(`[${this.id}] 转码异常：${this.error}`);
        }
        finish(code === 0);
      });

      // 等播放列表出现再标记 PLAYING。
      // 轮询要够密：这里每多等一档，客户端起播/快进就白等一档（原来 200ms）。
      const startedAt = Date.now();
      const check = setInterval(() => {
        if (!this.proc || this.proc !== proc) { clearInterval(check); return; }
        if (fs.existsSync(this.playlistPath)) {
          clearInterval(check);
          if (this.state === 'STARTING') this.setState('PLAYING');
          finish(true);
        } else if (Date.now() - startedAt > 20000) {
          clearInterval(check);
          if (this.state === 'STARTING') {
            this.error = this.stderrTail.slice(-6).join(' | ') || '转码超时';
            this.setState('ERROR');
          }
          finish(false);
        }
      }, 50);
    });
  }

  async restartWithFallback() {
    // stop() 已调用或纪元已变：不再回退重启（否则产生写已删目录的孤儿 ffmpeg）
    if (this.stopRequested || this._spawnEpoch !== this.epoch) return;
    this.epoch += 1;
    this._spawnEpoch = this.epoch;
    const genDir = path.join(this.dir, `g${this.gen + 1}`);
    ensureDir(genDir);
    this.gen += 1;
    this.state = 'STARTING';
    const args = this.buildArgs(genDir);
    this.manager.logger.info(`[${this.id}] 使用 ${this.encoderUsed} 重新开始`);
    await this.spawnProc(args);
  }

  onProgress(text) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const key = line.slice(0, idx);
      const value = line.slice(idx + 1);
      if (key === 'out_time_us' || key === 'out_time_ms') {
        const us = Number(value);
        if (Number.isFinite(us) && us >= 0) {
          this.outTime = us / 1e6;
          this.position = clamp(this.offset + this.outTime, 0, this.duration || 1e9);
          this.lastProgressAt = Date.now();
        }
      } else if (key === 'speed') {
        const sp = parseFloat(value);
        if (Number.isFinite(sp)) this.stats.speed = sp;
      }
    }
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', this.publicState());
    this.manager.emit('session', this.publicState());
  }

  /** 暂停仅影响客户端拉流；服务端继续按实时速度生成，避免复杂进程挂起 */
  pause() {
    if (this.state === 'PLAYING') this.setState('PAUSED');
    return this.publicState();
  }

  resume() {
    if (this.state === 'PAUSED') this.setState('PLAYING');
    return this.publicState();
  }

  async seek(seconds, opts = {}) {
    const target = clamp(Number(seconds) || 0, 0, Math.max(0, this.duration - 0.5));
    this.manager.logger.info(`[${this.id}] 请求跳转至 ${formatDuration(target)}`);
    this.epoch += 1; // 旧进程 close 回调失效
    await this.killProc();
    this.state = 'STARTING';
    await this.start(target);
    return this.publicState();
  }

  async setSpeed(speed) {
    const sp = SPEEDS.includes(Number(speed)) ? Number(speed) : 1;
    if (sp === this.speed) return this.publicState();
    const pos = this.position;
    this.epoch += 1;
    await this.killProc();
    this.speed = sp;
    await this.start(pos);
    this.manager.logger.info(`[${this.id}] 倍速切换为 ${sp}x`);
    return this.publicState();
  }

  async setAudio(index) {
    const pos = this.position;
    this.epoch += 1;
    await this.killProc();
    this.audioIndex = Number(index) || 0;
    await this.start(pos);
    return this.publicState();
  }

  async setSubtitle(subtitle) {
    const pos = this.position;
    this.epoch += 1;
    await this.killProc();
    this.subtitle = subtitle;
    await this.start(pos);
    return this.publicState();
  }

  killProc() {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc || proc.exitCode !== null) { this.proc = null; return resolve(); }
      this.proc = null;
      // Windows 上 proc.kill('SIGKILL') 只是发 TerminateProcess，遇到 ffmpeg 正在
      // 写分片/解码时可能拖到秒级才真正退出；旧进程不死，新进程又起来，两个 ffmpeg
      // 抢 CPU —— 这就是「快进几次后整个后台卡成幻灯片」的直接原因。
      // 这里用 taskkill /T /F 强杀整棵进程树，并把等待上限压到 600ms。
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, 600);
      proc.once('close', finish);
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
            .on('close', finish)
            .on('error', () => { try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ } });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (_) {
        try { proc.kill('SIGKILL'); } catch (__) { /* ignore */ }
      }
    });
  }

  async stop(reason = '用户停止') {
    this.stopRequested = true;
    this.epoch += 1; // 让迟到的旧进程 close 回调全部失效
    await this.killProc();
    this.setState('STOPPED');
    this.manager.logger.info(`[${this.id}] 会话停止：${reason}`);
    this.manager.finalize(this);
    this.cleanup();
  }

  cleanup() {
    setTimeout(() => {
      try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }, 30000);
  }

  /** 摘要行，供 GUI 与客户端显示 */
  summary() {
    return {
      id: this.id,
      file: path.basename(this.file),
      title: this.title,
      mode: 'transcode',
      state: this.state,
      position: this.position,
      duration: this.duration,
      client: this.client ? this.client.name : '本机',
      encoder: this.encoderUsed || '-',
      hardware: this.hardware,
      directPlay: !!this.directPlay
    };
  }
}

module.exports = { TranscodeSession, SPEEDS };
