'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/**
 * 可执行文件定位：绿色版优先使用 exe 同级 bin/ 目录，其次开发目录 tools/ffmpeg。
 */
function findBinary(rootDir, name, extraDirs = []) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  for (const dir of extraDirs) candidates.push(path.join(dir, exe));
  candidates.push(path.join(rootDir, 'bin', exe));
  candidates.push(path.join(rootDir, 'ffmpeg', exe));
  candidates.push(path.join(rootDir, 'tools', 'ffmpeg', exe));
  candidates.push(path.join(rootDir, 'resources', 'bin', exe));
  candidates.push(exe); // PATH
  for (const c of candidates) {
    if (!c.includes(path.sep)) {
      const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' });
      if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0];
      continue;
    }
    try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* next */ }
  }
  return null;
}

class Ffmpeg {
  constructor(rootDir, logger, { extraDirs = [] } = {}) {
    this.rootDir = rootDir;
    this.logger = logger;
    this.extraDirs = extraDirs;
    this.ffmpegPath = findBinary(rootDir, 'ffmpeg', extraDirs);
    this.ffprobePath = findBinary(rootDir, 'ffprobe', extraDirs);
    this.version = '';
    this.encoders = [];
    this.hwaccels = [];
    this.hwEncoders = [];   // 可用的硬件编码器（探测通过）
    this.hwDecoders = [];
    this.detected = false;
  }

  get available() { return !!(this.ffmpegPath && this.ffprobePath); }

  async detect() {
    if (!this.available) {
      this.logger.error('未找到 ffmpeg/ffprobe，请将 ffmpeg.exe 放入程序目录的 bin/ 下');
      return this.info();
    }
    const run = (args) => new Promise((resolve) => {
      const p = spawn(this.ffmpegPath, args, { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('close', () => resolve(out));
      p.on('error', () => resolve(''));
    });
    const banner = await run(['-hide_banner', '-version']);
    const m = banner.match(/ffmpeg version (\S+)/i);
    this.version = m ? m[1] : 'unknown';
    const enc = await run(['-hide_banner', '-encoders']);
    this.encoders = enc.split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z.]{6})\s+(\S+)/))
      .filter(Boolean)
      .map((mm) => ({ flags: mm[1], name: mm[2] }));
    const hw = await run(['-hide_banner', '-hwaccels']);
    this.hwaccels = hw.split(/\r?\n/).slice(1).map((s) => s.trim()).filter(Boolean);
    this.detected = true;
    this.logger.info(`ffmpeg ${this.version} 已检测（${this.ffmpegPath}）`);
    await this.probeHardware();
    return this.info();
  }

  hasEncoder(name) {
    return this.encoders.some((e) => e.name === name);
  }

  /**
   * 真实试转一小段，确认硬件编码器在当前机器可用（仅有编码器不等于有 GPU）。
   * 注意甄别真假硬件：h264_mf 在无 GPU 机器上会命中微软自带的「H264 Encoder MFT」
   * 软件编码器（跑 CPU），必须用 verbose 日志里的 MFT name 判别——
   *   微软软编 MFT 名固定为「H264 Encoder MFT」（HEVC/AV1 同理），真 GPU MFT 是厂商名。
   */
  async probeHardware() {
    if (!this.available) return;
    const candidates = [
      { name: 'h264_nvenc', label: 'NVIDIA NVENC H.264', codec: 'h264' },
      { name: 'hevc_nvenc', label: 'NVIDIA NVENC HEVC', codec: 'hevc' },
      { name: 'h264_qsv', label: 'Intel QuickSync H.264', codec: 'h264' },
      { name: 'hevc_qsv', label: 'Intel QuickSync HEVC', codec: 'hevc' },
      { name: 'h264_amf', label: 'AMD AMF H.264', codec: 'h264' },
      { name: 'hevc_amf', label: 'AMD AMF HEVC', codec: 'hevc' },
      { name: 'h264_mf', label: 'MediaFoundation H.264', codec: 'h264', vendorMft: true },
      { name: 'hevc_mf', label: 'MediaFoundation HEVC', codec: 'hevc', vendorMft: true }
    ].filter((c) => this.hasEncoder(c.name));
    const results = [];
    for (const c of candidates) {
      const probe = await this.testEncoder(c.name, !!c.vendorMft);
      results.push(Object.assign({ available: probe.ok, softwareMft: !!probe.softwareMft }, c));
    }
    // 真 GPU 编码器 = 试转成功 且 不是微软软件 MFT
    this.hwEncoders = results.filter((r) => r.available && !r.softwareMft);
    // 微软软件 MFT（h264_mf 无 GPU 机器上常见）：不算硬件，但可作为 libx264 之外的软编备选
    this.softwareMfEncoders = results.filter((r) => r.available && r.softwareMft);
    this.hwDecoders = this.hwaccels.filter((h) => ['cuda', 'qsv', 'd3d11va', 'dxva2', 'd3d12va', 'amf'].includes(h));
    if (this.hwEncoders.length) {
      this.logger.success(`硬件编码可用：${this.hwEncoders.map((e) => e.label).join('、')}`);
    } else {
      this.logger.warn('未检测到可用硬件编码器，将使用 CPU 软编码（libx264）');
    }
    if (this.softwareMfEncoders.length) {
      this.logger.info(`软件编码备选：${this.softwareMfEncoders.map((e) => e.label).join('、')}（微软系统编码器，CPU 承担）`);
    }
  }

  /**
   * 试转探测。mftCheck=true 时用 verbose 日志解析 MFT 名称，
   * 识别「H264 Encoder MFT」这类微软系统软编（返回 softwareMft=true）。
   */
  testEncoder(name, mftCheck = false) {
    return new Promise((resolve) => {
      const args = [
        '-hide_banner', '-loglevel', mftCheck ? 'verbose' : 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=0.4',
        '-c:v', name, '-f', 'null', '-'
      ];
      const p = spawn(this.ffmpegPath, args, { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} resolve({ ok: false }); }, 12000);
      const done = (ok) => {
        clearTimeout(timer);
        if (!ok || !mftCheck) return resolve({ ok });
        // verbose 日志形如：Using auto hw_type ... 'H264 Encoder MFT'
        // 或 MFT name: 'H264 Encoder MFT'——微软软编 MFT 名固定「<Codec> Encoder MFT」
        const mMft = err.match(/MFT name[^]*?'([^']+)'/) || err.match(/'((?:H264|HEVC|AV1|MPEG2|H264\s)Encoder[^']*MFT)'/i);
        const mftName = mMft ? mMft[1] : '';
        const softwareMft = /^((H264|HEVC|AV1|MPEG2)[\s]?Encoder\s?MFT|Microsoft[^']*)$/i.test(mftName);
        resolve({ ok, softwareMft, mftName });
      };
      p.on('close', (code) => done(code === 0));
      p.on('error', () => done(false));
    });
  }

  info() {
    return {
      available: this.available,
      ffmpeg: this.ffmpegPath,
      ffprobe: this.ffprobePath,
      version: this.version,
      hwEncoders: this.hwEncoders,
      softwareMfEncoders: this.softwareMfEncoders,
      hwaccels: this.hwaccels
    };
  }

  probe(file) {
    return new Promise((resolve, reject) => {
      if (!this.available) return reject(new Error('ffprobe 不可用'));
      const args = [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
        '-show_chapters', file
      ];
      const p = spawn(this.ffprobePath, args, { windowsHide: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(err.trim() || `ffprobe 退出码 ${code}`));
        try {
          const json = JSON.parse(out);
          resolve(this.normalize(json));
        } catch (e) { reject(e); }
      });
    });
  }

  normalize(json) {
    const streams = json.streams || [];
    const fmt = json.format || {};
    const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const audios = streams.filter((s) => s.codec_type === 'audio');
    const subs = streams.filter((s) => s.codec_type === 'subtitle');
    const toNum = (v) => (v === undefined || v === null || v === 'N/A' ? 0 : Number(v));
    const duration = toNum(fmt.duration) || toNum(video && video.duration) || 0;
    return {
      duration,
      size: toNum(fmt.size),
      bitrate: toNum(fmt.bit_rate),
      format: fmt.format_name || '',
      container: path.extname(fmt.filename || '').slice(1),
      video: video ? {
        index: video.index,
        codec: video.codec_name,
        profile: video.profile,
        width: video.width,
        height: video.height,
        startPts: toNum(video.start_time),
        fps: this.parseFps(video.avg_frame_rate || video.r_frame_rate),
        pixFmt: video.pix_fmt,
        bitrate: toNum(video.bit_rate),
        colorTransfer: video.color_transfer,
        hdr: /smpte2084|arib-std-b67/i.test(video.color_transfer || '')
      } : null,
      audio: audios.map((a) => ({
        index: a.index,
        codec: a.codec_name,
        startPts: toNum(a.start_time),
        channels: a.channels,
        layout: a.channel_layout,
        bitrate: toNum(a.bit_rate),
        language: (a.tags && (a.tags.language || a.tags.LANGUAGE)) || '',
        title: (a.tags && (a.tags.title || a.tags.TITLE)) || '',
        default: !!(a.disposition && a.disposition.default)
      })),
      subtitles: subs.map((s, i) => ({
        index: s.index,
        subIndex: i,
        codec: s.codec_name,
        language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
        title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
        forced: !!(s.disposition && s.disposition.forced),
        default: !!(s.disposition && s.disposition.default),
        text: ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(s.codec_name)
      })),
      chapters: (json.chapters || []).map((c) => ({ start: toNum(c.start_time), end: toNum(c.end_time), title: c.tags && c.tags.title }))
    };
  }

  parseFps(rate) {
    if (!rate || rate === '0/0') return 0;
    const [a, b] = String(rate).split('/').map(Number);
    if (!b) return a || 0;
    return Math.round((a / b) * 1000) / 1000;
  }
}

module.exports = { Ffmpeg, findBinary };
