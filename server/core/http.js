'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const {
  mimeType, readJson, writeJson, ensureDir, isSubPath, formatDuration, humanSize, shortHash
} = require('./util');

const AUDIO_EXT = ['.mp3', '.flac', '.aac', '.m4a', '.wav', '.ogg', '.opus'];
const IMAGE_THUMB_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif']);

/** 正在生成的缩略图任务（同一张图并发请求只跑一次 ffmpeg） */
const thumbJobs = new Map();

/**
 * HTTP 服务：GUI 静态资源 + REST API + HLS 流 + 字幕转换
 */
function createHttpServer(ctx) {
  const { config, logger, library, sessions, ffmpeg, clients, guiDir, watcher } = ctx;

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsed.pathname);
    const q = parsed.query || {};
    try {
      if (pathname.startsWith('/api/gui/')) {
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        const handled = await ctx.guiApi.handle(req, res, pathname, q, body);
        if (handled) return;
      }
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, q, parsed);
      if (pathname.startsWith('/hls/')) return await serveHls(req, res, pathname, q);
      if (pathname.startsWith('/thumb/')) return await serveThumb(req, res, pathname, q);
      if (pathname.startsWith('/raw/')) return await serveRaw(req, res, pathname, q);
      if (pathname.startsWith('/media/')) return await serveMedia(req, res, pathname, q);
      if (pathname.startsWith('/subs/')) return await serveSubtitle(req, res, pathname, q);
      return await serveStatic(req, res, pathname, guiDir);
    } catch (err) {
      // 4xx 是客户端可理解的错误（未授权、路径越权、文件不存在等），
      // 必须原样返回状态码；只有真正的内部异常才是 500。
      // 否则客户端只能显示"服务器内部错误"，用户无从判断。
      const status = Number(err.status) >= 400 && Number(err.status) < 600 ? Number(err.status) : 500;
      if (status >= 500) logger.error(`HTTP ${req.method} ${pathname} -> ${err.message}`);
      else logger.warn(`HTTP ${req.method} ${pathname} -> ${status} ${err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else try { res.end(); } catch (_) { /* ignore */ }
    }
  });

  server.keepAliveTimeout = 5000;
  server.headersTimeout = 20000;

  function sendJson(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  }

  function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
      });
      req.on('error', reject);
    });
  }

  function requireAuth(req, q) {
    const token = req.headers['x-lanplay-token'] || q.token;
    const auth = clients.authenticate(token);
    if (!auth.ok) {
      const err = new Error('未授权：请先配对');
      err.status = 401;
      throw err;
    }
    if (auth.clientId && auth.clientId !== 'guest') clients.touch(token, { ip: clientIp(req) });
    return auth;
  }

  function clientIp(req) {
    // 不信任 x-forwarded-for：局域网客户端可伪造该头把非本机来源伪装成 loopback，
    // 影响 /api/subtitle/vtt 免 token 例外与 /raw/ 免 token 判定（内网直连场景用不上该头）。
    let ip = req.socket.remoteAddress || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip === '::1') ip = '127.0.0.1';
    return ip;
  }

  async function handleApi(req, res, pathname, q, parsed) {
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const ip = clientIp(req);

    // ---- 无需鉴权 ----
    if (pathname === '/api/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, name: config.get('serverName'), serverId: config.get('serverId'), ts: Date.now() });
    }
    if (pathname === '/api/info' && req.method === 'GET') {
      return sendJson(res, 200, publicInfo());
    }
    if (pathname === '/api/pair' && req.method === 'POST') {
      if (!clients.verifyPin(body.pin)) {
        logger.warn(`配对失败（PIN 错误）：${ip} ${body.name || ''}`);
        return sendJson(res, 403, { error: '配对码错误' });
      }
      const issued = clients.issueTicket({
        id: body.clientId,
        name: body.name,
        model: body.model,
        platform: body.platform,
        appVersion: body.appVersion
      }, ip);
      return sendJson(res, 200, {
        token: issued.token,
        clientId: issued.clientId,
        server: publicInfo()
      });
    }
    if (pathname === '/api/resume' && req.method === 'POST') {
      const auth = clients.authenticate(body.token);
      if (!auth.ok) return sendJson(res, 401, { error: 'token 已失效，请重新配对' });
      const rec = clients.touch(body.token, { ip, appVersion: body.appVersion });
      return sendJson(res, 200, { ok: true, client: rec, server: publicInfo() });
    }

    // ---- 需要鉴权 ----
    // 例外：本机回环拉字幕 VTT 免 token（GUI 管理页/本机调试用；Android 客户端带 token 走 requireAuth）。
    // 只放行这两个只读接口，其余 /api/* 仍要求配对，避免把管理能力敞开给本机浏览器。
    const isLoopbackReq = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
    const loopbackReadable = isLoopbackReq
      && (pathname === '/api/subtitle/vtt' || pathname === '/api/subtitle/extract');
    const auth = loopbackReadable ? { ok: true, client: null, clientId: 'local' } : requireAuth(req, q);

    if (pathname === '/api/discover-info') {
      return sendJson(res, 200, publicInfo());
    }

    if (pathname === '/api/roots' && req.method === 'GET') {
      // 带上 version：客户端轮询 /api/sync 时用它判断要不要重拉列表
      return sendJson(res, 200, library.snapshot());
    }

    // 客户端添加媒体源（与 GUI 共用同一份引用列表，双向同步）
    if (pathname === '/api/roots' && req.method === 'POST') {
      const paths = Array.isArray(body.paths) ? body.paths : [body.path];
      const added = [];
      const failed = [];
      for (const p of paths) {
        try { added.push(library.addRoot(p, { name: body.name })); } catch (e) { failed.push({ path: p, error: e.message }); }
      }
      for (const r of added) {
        try { if (r.type === 'dir') watcher?.watch(r.path); } catch (_) { /* ignore */ }
      }
      logger.info(`客户端 ${auth.client ? auth.client.name : ip} 添加媒体源 ${added.length} 个`);
      return sendJson(res, 200, { added, failed, version: library.version });
    }

    // 客户端批量操作：enable / disable / remove / purge（全部移除）
    if (pathname === '/api/roots/batch' && req.method === 'POST') {
      const action = String(body.action || '');
      const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
      let result;
      if (action === 'remove' || action === 'purge') {
        result = library.removeMany(ids, { all: action === 'purge' });
        logger.info(`客户端 ${auth.client ? auth.client.name : ip} ${action === 'purge' ? '清空' : '移除'}媒体源 ${result.length} 个`);
        return sendJson(res, 200, { removed: result.map((r) => r.id), version: library.version });
      }
      if (action === 'enable' || action === 'disable') {
        result = library.updateMany(ids, { enabled: action === 'enable' });
        return sendJson(res, 200, { updated: result.map((r) => r.id), version: library.version });
      }
      return sendJson(res, 400, { error: '不支持的操作' });
    }

    // 单条：重命名 / 启用禁用
    if (pathname === '/api/roots' && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const id = body.id || q.id;
      const root = library.findRoot(id);
      if (!root) return sendJson(res, 404, { error: '引用不存在' });
      if (req.method === 'DELETE') {
        library.removeRoot(id);
        return sendJson(res, 200, { ok: true, version: library.version, roots: library.rootsForClient() });
      }
      const updated = library.updateRoot(id, { name: body.name, enabled: body.enabled });
      return sendJson(res, 200, { root: updated, version: library.version });
    }

    // 轻量同步：客户端定时轮询，version 变了才去重拉列表
    if (pathname === '/api/sync' && req.method === 'GET') {
      const since = Number(q.since) || 0;
      const changed = since > 0 ? since !== library.version : true;
      const payload = {
        version: library.version,
        changed,
        changedAt: library.lastChangeAt,
        reason: library.lastChangeReason,
        roots: library.rootsForClient(),
        sessions: sessions.active().length,
        maxSessions: sessions.maxSessions
      };
      return sendJson(res, 200, payload);
    }

    if (pathname === '/api/browse' && req.method === 'GET') {
      const rootId = q.rootId || (library.roots[0] && library.roots[0].id);
      if (!rootId) return sendJson(res, 404, { error: '尚未添加任何媒体源' });
      const result = await library.browse(rootId, q.path || '', { sort: q.sort, order: q.order });
      // 有人看这个目录 → 开始监听它的增删（客户端列表跟着实时变）
      try {
        if (!result.isFile) {
          const root = library.findRoot(rootId);
          if (root) {
            const dir = q.path ? path.resolve(root.path, q.path) : path.resolve(root.path);
            watcher?.watch(dir);
          }
        }
      } catch (_) { /* 监听失败不影响浏览 */ }
      return sendJson(res, 200, Object.assign(result, {
        version: library.version,
        sort: q.sort || '',
        order: q.order || ''
      }));
    }

    if (pathname === '/api/library' && req.method === 'GET') {
      const rootId = q.rootId || (library.roots[0] && library.roots[0].id);
      if (!rootId) return sendJson(res, 404, { error: '尚未添加任何媒体源' });
      const result = await library.listAll(rootId, {
        offset: Number(q.offset) || 0,
        limit: Math.min(Number(q.limit) || 200, 500)
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/media' && req.method === 'GET') {
      const file = resolveMediaPath(q.rootId, q.path);
      const info = await library.mediaInfo(file);
      const subs = library.findExternalSubs(file);
      // 一并下发字幕轨列表：客户端可在起播前就决定「同名字幕自动烧录」，
      // 避免先起一次转码再切换（那样会白等 1-2 秒）。
      return sendJson(res, 200, {
        file, name: path.basename(file), info, externalSubtitles: subs,
        subtitleTracks: buildSubtitleTracks(info, file)
      });
    }

    if (pathname === '/api/play' && req.method === 'POST') {
      const file = resolveMediaPath(body.rootId, body.path);
      const info = await library.mediaInfo(file);
      const client = auth.client || { name: '未知设备', ip };
      const settings = Object.assign({}, config.get('transcode'), body.settings || {});
      if (body.resolution) settings.resolution = body.resolution;
      if (body.bitrate) settings.bitrate = body.bitrate;
      if (body.codec) settings.codec = body.codec;
      let subtitle = null;
      if (body.subtitle) {
        if (body.subtitle.mode === 'burn' && Number.isInteger(body.subtitle.index)) {
          subtitle = { mode: 'burn', index: body.subtitle.index, name: body.subtitle.name || `内嵌字幕 #${body.subtitle.index}` };
        } else if (body.subtitle.mode === 'burn' && body.subtitle.path) {
          subtitle = { mode: 'burn', path: body.subtitle.path, name: body.subtitle.name || '外挂字幕' };
        }
      }
      // 同一客户端重新点播时自动替换旧会话，避免旧会话占满 maxSessions
      // 导致"已达最大并发转码会话数"（连续快进/切换片源场景）。
      let replaced = 0;
      for (const s of sessions.list()) {
        const d = sessions.detail(s.id);
        if (d && d.client && d.client.id === (client.id || 'guest')) {
          await sessions.stop(s.id, '客户端重新点播').catch(() => {});
          replaced++;
        }
      }
      // 刚强杀过 ffmpeg（taskkill /T /F 等待上限 600ms 可能没等到 close）：
      // 停 250ms 让旧进程真正退出，避免新旧 ffmpeg 并发初始化 ——
      // 两个 h264_mf 同时分配 MFT 资源会 "Cannot allocate memory" 崩掉。
      if (replaced > 0) await new Promise((r) => setTimeout(r, 250));
      const session = await sessions.create({
        file,
        mediaInfo: info,
        client: { id: client.id || 'guest', name: client.name, ip: client.ip || ip, model: client.model },
        settings,
        startAt: Number(body.startAt) || 0,
        subtitle
      });
      return sendJson(res, 200, buildPlayPayload(session, req));
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      const s = sessions.detail(q.id);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, Object.assign(s.publicState(), { playlist: s.playlistUrl(baseUrl(req)) }));
    }

    if (pathname === '/api/session/seek' && req.method === 'POST') {
      const s = needSession(body.id);
      const st = await s.seek(body.position);
      return sendJson(res, 200, Object.assign(st, { playlist: s.playlistUrl(baseUrl(req)) }));
    }

    if (pathname === '/api/session/speed' && req.method === 'POST') {
      const s = needSession(body.id);
      const st = await s.setSpeed(body.speed);
      return sendJson(res, 200, Object.assign(st, { playlist: s.playlistUrl(baseUrl(req)) }));
    }

    if (pathname === '/api/session/audio' && req.method === 'POST') {
      const s = needSession(body.id);
      const st = await s.setAudio(body.index);
      return sendJson(res, 200, Object.assign(st, { playlist: s.playlistUrl(baseUrl(req)) }));
    }

    if (pathname === '/api/session/subtitle' && req.method === 'POST') {
      const s = needSession(body.id);
      const st = await s.setSubtitle(body.subtitle || null);
      return sendJson(res, 200, Object.assign(st, { playlist: s.playlistUrl(baseUrl(req)) }));
    }

    if (pathname === '/api/session/pause' && req.method === 'POST') {
      const s = needSession(body.id);
      return sendJson(res, 200, s.pause());
    }
    if (pathname === '/api/session/resume' && req.method === 'POST') {
      const s = needSession(body.id);
      return sendJson(res, 200, s.resume());
    }
    if (pathname === '/api/session/stop' && req.method === 'POST') {
      const s = needSession(body.id);
      await sessions.stop(s.id, '客户端停止');
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/session/state' && req.method === 'GET') {
      const s = sessions.detail(q.id);
      if (!s) return sendJson(res, 404, { error: '会话不存在' });
      return sendJson(res, 200, s.publicState());
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      return sendJson(res, 200, { sessions: sessions.list() });
    }

    if (pathname === '/api/subtitle/vtt' && req.method === 'GET') {
      let file = null;
      try { file = resolveMediaPath(q.rootId, q.path); } catch (err) { return sendJson(res, err.status || 403, { error: err.message }); }
      const index = Number(q.index) || 0;
      // `start`：流时间轴原点（会话 seek 后的 offset）。字幕按此重新对齐，
      // 否则新流的 0 秒对应原片 start 秒，而 cue 还是原片绝对时间 → 全片错位。
      const start = Math.max(0, Number(q.start) || 0);
      let got = null;
      if (q.external === '1') {
        const ext = library.findExternalSubs(file);
        const vttPath = ext[index] ? await externalSubtitleToVtt(ext[index].path) : null;
        got = vttPath ? { parts: [{ path: vttPath, base: 0 }], from: 0, full: true } : null;
      } else {
        got = await ensureSubtitleRange(file, await library.mediaInfo(file), index, start);
      }
      if (!got || !got.parts.length) return sendJson(res, 404, { error: '字幕转换失败' });
      // 把各窗口拼成一份 VTT，再统一平移到当前流时间轴 + 抬高字幕位置。
      // 分片时间轴从分片起点算，所以要加 `分片起点 - 流起点`。
      const chunks = got.parts
        .filter((p) => fs.existsSync(p.path))
        .map((p) => rebaseVtt(fs.readFileSync(p.path, 'utf8'), p.base - start, Number(q.line) || 0, Number(q.speed) || 1));
      if (!chunks.length) return sendJson(res, 404, { error: '字幕转换失败' });
      const body = Buffer.from(chunks[0].replace(/^WEBVTT[^\n]*\n/, 'WEBVTT\n') + chunks.slice(1).map((c) => c.replace(/^WEBVTT[^\n]*\n/, '')).join(''), 'utf8');
      // 排障用：字幕是不是被客户端真的拉走了、按什么时间轴（以前这里没有任何日志，
      // 「字幕不显示」只能靠猜）
      logger.info(`字幕下发 ${auth.client ? auth.client.name : ip} ${path.basename(file)} #${index} start=${start.toFixed(1)}s ${got.parts.length}段 ${body.length}B`);
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(body);
    }

    if (pathname === '/api/subtitle/extract' && req.method === 'GET') {
      const file = resolveMediaPath(q.rootId, q.path);
      const info = await library.mediaInfo(file);
      // 第四个参数是「当前流起点」，用于挑字幕窗口分片（不是格式！）
      const got = await ensureSubtitleRange(file, info, Number(q.index) || 0, Number(q.start) || 0);
      if (!got || !got.parts.length) return sendJson(res, 500, { error: '字幕抽取失败' });
      return sendJson(res, 200, { url: `/subs/${path.basename(got.parts[0].path)}` });
    }

    return sendJson(res, 404, { error: '未知接口' });
  }

  // ---------- GUI 专用管理接口（本机回环 + 独立前缀）----------
  const guiApi = {
    state() {
      return {
        server: publicInfo(),
        sessions: sessions.list(),
        clients: clients.list(),
        roots: library.listRoots(),
        ffmpeg: ffmpeg.info(),
        hardware: { encoders: ffmpeg.hwEncoders },
        logs: logger.list({ limit: 400 }),
        history: sessions.history
      };
    }
  };

  function needSession(id) {
    const s = sessions.detail(id);
    if (!s) { const e = new Error('会话不存在'); e.status = 404; throw e; }
    return s;
  }

  function resolveMediaPath(rootId, relPathRaw) {
    const relPath = decodeURIComponent(String(relPathRaw || ''));
    const root = rootId ? library.findRoot(rootId) : null;
    // 单文件引用根本没有「相对路径」这一说，路径就是 root.path 本身。
    // 必须放在 relPath 校验之前，否则客户端传空路径会直接 400。
    if (root && root.type === 'file') {
      if (!fs.existsSync(root.path)) { const e = new Error('文件不存在'); e.status = 404; throw e; }
      return root.path;
    }
    if (!relPath) { const e = new Error('缺少文件路径'); e.status = 400; throw e; }
    let file = null;
    if (root) {
      const candidate = path.resolve(root.path, relPath);
      if (isSubPath(root.path, candidate)) file = candidate;
    } else if (path.isAbsolute(relPath)) {
      const hit = library.resolveWithinRoots(relPath);
      if (hit) file = hit.path;
    } else {
      const hit = library.resolveWithinRoots(relPath);
      if (hit) file = hit.path;
    }
    if (!file) { const e = new Error('文件不在已引用范围内'); e.status = 403; throw e; }
    if (!fs.existsSync(file)) { const e = new Error('文件不存在'); e.status = 404; throw e; }
    return file;
  }

  function publicInfo() {
    return {
      name: config.get('serverName'),
      serverId: config.get('serverId'),
      version: '1.0.0',
      port: ctx.port || config.get('port'),
      requirePin: !!config.get('requirePin'),
      discoveryPort: config.get('discoveryPort'),
      maxSessions: sessions.maxSessions,
      // hardware 是给客户端做能力协商用的可读标签（如「MediaFoundation H.264」）；
      // ffmpeg / ffprobe 是排障时最常要问的两个事实，一并下发省得让用户翻日志。
      hardware: ffmpeg.hwEncoders.map((e) => e.label),
      ffmpeg: { available: !!ffmpeg.available, version: ffmpeg.version || '', encoders: ffmpeg.hwEncoders.map((e) => e.name) }
    };
  }

  function baseUrl(req) {
    const host = req.headers.host || `${ctx.localIp}:${ctx.port}`;
    return `http://${host}`;
  }

  function buildPlayPayload(session, req) {
    const st = session.publicState();
    return Object.assign(st, {
      playlist: session.playlistUrl(baseUrl(req)),
      // 内嵌/外挂文本字幕由客户端轻量渲染；offset 让字幕按当前流时间轴重新对齐
      subtitleTracks: buildSubtitleTracks(session.mediaInfo, session.file, st.offset),
      // 图形字幕（PGS/VobSub 等）只能服务端烧录
      burnSubtitles: buildBurnSubtitles(session.mediaInfo),
      audioTracks: buildAudioTracks(session.mediaInfo)
    });
  }

  function buildAudioTracks(info) {
    return ((info && info.audio) || []).map((a, i) => ({
      index: i,
      streamIndex: a.index,
      // title/language 都可能为空串：逐级兜底保证 label 永不为空（客户端弹层显示空白）
      label: (a.title || '').trim()
        || (a.language ? languageName(a.language) : '')
        || `音轨 ${i + 1}`,
      language: a.language || '',
      channels: a.channels || 2,
      codec: a.codec || '',
      default: !!a.default
    }));
  }

  function buildBurnSubtitles(info) {
    const out = [];
    for (const s of (info && info.subtitles) || []) {
      if (s.text) continue;
      out.push({
        index: s.subIndex !== undefined ? s.subIndex : s.index,
        label: s.title || (s.language ? languageName(s.language) : `图形字幕 ${out.length + 1}`),
        language: s.language || '',
        codec: s.codec
      });
    }
    return out;
  }

  function languageName(code) {
    const map = {
      chi: '简体中文', zho: '中文', zh: '中文', chs: '简体中文', 'zh-cn': '简体中文',
      cht: '繁体中文', tc: '繁体中文', 'zh-tw': '繁体中文', 'zh-hk': '繁体中文',
      eng: '英语', en: '英语', jpn: '日语', ja: '日语', jp: '日语', kor: '韩语',
      fra: '法语', fre: '法语', deu: '德语', ger: '德语', spa: '西班牙语', rus: '俄语',
      ita: '意大利语', por: '葡萄牙语', tha: '泰语', vie: '越南语', und: '未知'
    };
    return map[String(code).toLowerCase()] || code;
  }

  /**
   * 构建字幕轨列表。
   *
   * `offset` 是会话流时间轴原点：每次 seek 后服务端重启 ffmpeg，新流从 0 开始，
   * 而字幕 cue 是原片绝对时间。把 offset 拼进 VTT URL（`&start=`），
   * 服务端抽取时就会从该点重定基线，字幕才能和流对齐。
   */
  function buildSubtitleTracks(info, file, offset = 0) {
    const tracks = [];
    const external = library.findExternalSubs(file);
    const startSec = Math.max(0, Number(offset) || 0);
    const tail = startSec > 0.05 ? `&start=${startSec.toFixed(3)}` : '';
    const q = (idx, ext) => `?path=${encodeURIComponent(file)}&index=${idx}${ext ? '&external=1' : ''}${tail}`;

    // 1) 内嵌文本字幕：客户端轻量渲染（VTT）
    for (const s of (info && info.subtitles) || []) {
      if (s.text) {
        tracks.push({
          id: `e${s.subIndex}`, kind: 'embedded', index: s.subIndex, format: s.codec,
          label: (s.title || '').trim() || languageName(s.language) || `字幕 ${tracks.length + 1}`,
          language: s.language, text: true, burn: false,
          default: false,
          url: `/api/subtitle/vtt${q(s.subIndex, false)}`
        });
      } else {
        // 内嵌图形字幕（PGS/DVD）：只能服务端烧录
        tracks.push({
          id: `b${s.subIndex}`, kind: 'embedded', index: s.subIndex, format: s.codec,
          label: `${(s.title || '').trim() || languageName(s.language) || `图形字幕 ${tracks.length + 1}`}（烧录）`,
          language: s.language, text: false, burn: true, default: false,
          url: ''
        });
      }
    }

    // 2) 外挂字幕：ASS/SSA 默认走服务端烧录以保留特效；
    //    纯文本（srt/vtt）优先客户端渲染，烧录作为可选。
    //    注意：URL 里的 index 是**外挂字幕数组的下标**（服务端 findExternalSubs 的顺序），
    //    不是 tracks 的下标 —— 两者在混有内嵌字幕时会错开。
    let autoPicked = false;
    external.forEach((s, extIndex) => {
      const isAss = s.format === 'ass' || s.format === 'ssa';
      const track = {
        id: `x${extIndex}`, kind: 'external', index: extIndex, extIndex,
        format: s.format, label: `${languageName(s.lang) || '外挂'} ${s.name}`.trim(),
        language: s.lang, text: !isAss, burn: isAss,
        default: false,
        path: s.path,
        url: isAss ? '' : `/api/subtitle/vtt${q(extIndex, true)}`
      };
      // 同名字幕自动选中：与视频同名（或带 .chs/.zh-cn 等后缀）的第一条
      if (!autoPicked && isSameStem(s.name, file)) {
        track.default = true;
        autoPicked = true;
      }
      tracks.push(track);
    });
    if (autoPicked) {
      // 自动选中项排到最前，客户端打开就能直接用，不用翻菜单
      const idx = tracks.findIndex((t) => t.default);
      if (idx > 0) {
        const [pick] = tracks.splice(idx, 1);
        tracks.unshift(pick);
      }
    }
    return tracks;
  }

  /** 外挂字幕与视频是否同名（`影片.mkv` ↔ `影片.ass`、`影片.chs.ass`） */
  function isSameStem(subName, mediaFile) {
    const mediaStem = path.parse(mediaFile).name.toLowerCase();
    const subStem = path.parse(subName).name.toLowerCase();
    if (subStem === mediaStem) return true;
    // 允许 `.chs`/`.zh-cn`/`.sc` 等语言后缀；要求分隔符存在，避免 "abc2" 误匹配 "abc"
    return subStem.startsWith(mediaStem) && /^[._\-\s]/.test(subStem.slice(mediaStem.length));
  }


  /** 正在生成的 VTT（避免并发重复起 ffmpeg；key=输出路径） */
  const subsPending = new Map();
  async function serveSubtitle(req, res, pathname, q) {
    const name = path.basename(pathname);
    let vtt = null;
    let cacheKey = name;
    if (name.startsWith('__embedded_')) {
      const m = name.match(/^__embedded_(.+?)__(\d+)\.vtt$/);
      if (!m) return notFound(res);
      const baseName = decodeURIComponent(m[1]);
      const idx = Number(m[2]);
      const file = findFileByName(baseName);
      if (!file) return notFound(res);
      vtt = await extractSubtitleWindow(file, idx, 0);
    } else if (name.startsWith('__external_')) {
      const m = name.match(/^__external_(.+?)__\.vtt$/);
      if (!m) return notFound(res);
      const baseName = decodeURIComponent(m[1]);
      const file = findFileByName(baseName);
      if (!file) return notFound(res);
      vtt = await externalSubtitleToVtt(file);
    } else if (name.endsWith('.vtt')) {
      const full = path.join(config.dataDir, 'cache', 'subs', name);
      if (!fs.existsSync(full)) return notFound(res);
      vtt = full;
    }
    if (!vtt || !fs.existsSync(vtt)) return notFound(res);
    const body = fs.readFileSync(vtt);
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
    res.end(body);
  }

  function findFileByName(baseName) {
    for (const root of library.roots) {
      if (root.type === 'file' && path.basename(root.path) === baseName) return root.path;
    }
    // 在最近播放与缓存中查找
    for (const r of config.get('recentPlayed') || []) {
      if (path.basename(r.path) === baseName && fs.existsSync(r.path)) return r.path;
    }
    return null;
  }

  const subsDir = ensureDir(path.join(config.dataDir, 'cache', 'subs'));

  /** 字幕窗口长度（秒）：只抽当前播放点所在的这一段，而不是整轨 */
  const SUB_WINDOW = 600;

  /**
   * 字幕缓存路径。两类缓存**必须分开命名**，否则会互相覆盖：
   * - 整轨：`e-<stem>-<index>.vtt`（时间轴 = 原片绝对时间）
   * - 窗口：`e-<stem>-<index>-w<起点>.vtt`（时间轴从窗口起点算）
   * 之前窗口 0 与整轨同名，后台整轨写盘时把窗口文件覆盖掉，
   * 表现为「拖到 20 分钟后没字幕」。
   */
  function subCachePath(file, index, winStart) {
    const stem = path.basename(file).replace(/[^\w.-]/g, '_');
    if (winStart == null) return path.join(subsDir, `e-${stem}-${index}.vtt`);
    return path.join(subsDir, `e-${stem}-${index}-w${winStart}.vtt`);
  }

  /** 字幕窗口起点（与缓存分片规则一致） */
  function subtitleWindowStart(startSec) {
    return Math.floor(Math.max(0, Number(startSec) || 0) / SUB_WINDOW) * SUB_WINDOW;
  }

  /** 一次最多拼多少个窗口（8 个 = 80 分钟；超出部的由客户端下次 seek/重挂续上） */
  const SUB_MAX_PARTS = 8;

  /**
   * 取一段字幕，返回 `{ parts }`，每个 part 是 `{ path, base }`
   * （`base` = 该分片第一条 cue 对应的原片绝对秒数）。
   *
   * 策略：从当前播放点所在窗口开始，**一路抽到片尾**（最多 8 个窗口 ≈ 80 分钟），
   * 拼成一份 VTT 一次下发。这样客户端挂一次 `<track>` 就能覆盖整部片，
   * 不会看到一半字幕突然消失；每个窗口按 `-w<起点>` 单独缓存，二次访问是读文件（毫秒级）。
   *
   * 为什么不是整轨抽取：整轨要把文件从头读到尾 —— 实测 10GB 片源要 100 秒，
   * 用户看到的就是「字幕几十秒后才出现」。窗口抽取把 `-ss` 放在 `-i` 之前，
   * 走容器索引直接跳，实测单窗口 40~90ms。
   */
  async function ensureSubtitleRange(file, info, index, startSec) {
    const start = Math.max(0, Number(startSec) || 0);
    // 整轨缓存已存在（小文件预热过 / 旧版本留下）：一份文件覆盖全片，最快
    const full = subCachePath(file, index, null);
    if (fs.existsSync(full)) return { parts: [{ path: full, base: 0 }] };

    const first = subtitleWindowStart(start);
    const duration = Number(info && info.duration) || 0;
    let last = first + (SUB_MAX_PARTS - 1) * SUB_WINDOW;
    if (duration > 0) last = Math.min(last, subtitleWindowStart(duration - 0.5));

    const wins = [];
    for (let ws = first; ws <= last; ws += SUB_WINDOW) wins.push(ws);

    // 并发 3：一次起十几个 ffmpeg 在低配机上会抢爆磁盘
    const parts = [];
    for (let i = 0; i < wins.length; i += 3) {
      const batch = await Promise.all(wins.slice(i, i + 3).map((ws) => extractSubtitleWindow(file, index, ws)));
      for (let k = 0; k < batch.length; k++) {
        if (batch[k]) parts.push({ path: batch[k], base: wins[i + k] });
      }
    }
    // 小文件顺手把整轨抽出来（后台，不阻塞响应）：之后任何 seek 都只读一份文件
    if (parts.length) warmFullSubtitle(file, index, full);
    return parts.length ? { parts } : null;
  }

  /** 后台抽整轨：小文件才做（大文件整轨读一遍要上百秒，会和转码抢磁盘 I/O） */
  const fullJobs = new Map();
  const FULL_WARM_LIMIT = 2 * 1024 * 1024 * 1024;
  function warmFullSubtitle(file, index, out) {
    if (!file || !fs.existsSync(file)) return;
    if (fs.existsSync(out) || fullJobs.has(out)) return;
    try {
      if (fs.statSync(file).size > FULL_WARM_LIMIT) return; // 大文件不做整轨预热
    } catch (_) { return; }
    const job = new Promise((done) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-i', file,
        '-map', `0:s:${index}`, '-c:s', 'webvtt', '-f', 'webvtt', '-y', out];
      let p;
      try {
        p = spawn(ffmpeg.ffmpegPath, args, { windowsHide: true });
      } catch (_) {
        fullJobs.delete(out);
        return done(null);
      }
      p.on('close', () => { fullJobs.delete(out); done(fs.existsSync(out) ? out : null); });
      p.on('error', () => { fullJobs.delete(out); done(null); });
    });
    fullJobs.set(out, job);
    job.catch(() => {});
  }

  /**
   * 抽一个窗口的内嵌字幕为 WEBVTT（窗口内相对时间轴）。
   *
   * `-ss` 放在 `-i` 之前：ffmpeg 用容器索引直接跳到该时间点，
   * 配合 `-t` 只读到窗口末尾就退出 —— 10 分钟窗口在 4K 大文件上也只有几十毫秒级
   * （实测 9.6GB 片源 `-ss 300 -t 120` = 65ms）。
   */
  function extractSubtitleWindow(file, index, winStart) {
    return new Promise((resolve) => {
      if (!file || !fs.existsSync(file)) return resolve(null);
      const out = subCachePath(file, index, winStart);
      if (fs.existsSync(out)) return resolve(out);
      const pending = subsPending.get(out);
      if (pending) { pending.then(resolve); return; }
      const job = new Promise((done) => {
        const args = ['-hide_banner', '-loglevel', 'error'];
        if (winStart > 0) args.push('-ss', String(winStart));
        args.push('-i', file, '-map', `0:s:${index}`, '-t', String(SUB_WINDOW),
          '-c:s', 'webvtt', '-f', 'webvtt', '-y', out);
        let p;
        try {
          p = spawn(ffmpeg.ffmpegPath, args, { windowsHide: true });
        } catch (_) {
          subsPending.delete(out);
          return done(null);
        }
        p.on('close', () => { subsPending.delete(out); done(fs.existsSync(out) ? out : null); });
        p.on('error', () => { subsPending.delete(out); done(null); });
      });
      subsPending.set(out, job);
      job.then(resolve);
    });
  }

  /** 同名字幕文件的整轨转换（同样只做一次） */
  function externalSubtitleToVtt(file) {
    return new Promise((resolve) => {
      if (!file) return resolve(null);
      const out = path.join(subsDir, `x-${path.basename(file).replace(/[^\w.-]/g, '_')}.vtt`);
      if (fs.existsSync(out)) return resolve(out);
      const pending = subsPending.get(out);
      if (pending) { pending.then(resolve); return; }
      const job = new Promise((done) => {
        const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-c:s', 'webvtt', '-f', 'webvtt', '-y', out];
        const p = spawn(ffmpeg.ffmpegPath, args, { windowsHide: true });
        p.on('close', () => { subsPending.delete(out); done(fs.existsSync(out) ? out : null); });
        p.on('error', () => { subsPending.delete(out); done(null); });
      });
      subsPending.set(out, job);
      job.then(resolve);
    });
  }

  /**
   * 把一段 VTT 的时间轴平移 `delta` 秒，并给每条 cue 标 `line:<pct>%`。
   *
   * 时间轴关系：`t_流时间 = t_文件时间 + (分片起点 - 流起点)`。
   * - 整轨缓存（分片起点 = 0）+ 流起点 682.6s → delta = -682.6（字幕减掉已过去的部分）；
   * - 窗口缓存（分片起点 600）+ 流起点 100s → delta = +500（字幕要往后推）。
   *
   * 服务端每次 seek 都重启 ffmpeg，新 HLS 流从 0 开始；而字幕 cue 是原片绝对时间。
   * 这里统一平移 + 丢掉已经过去的 cue —— 纯内存字符串处理（毫秒级），
   * 所以 seek 之后字幕是**立刻**跟上，不再需要等 ffmpeg 重新抽一遍。
   *
   * speed（补充 22）：倍速会话的输出流时间轴被压缩（ffmpeg setpts/ATempo，
   * 原片第 T 秒的内容出现在新流的 T/speed 秒处），cue 必须同样缩放：
   * t' = (t - start) / speed。客户端在字幕 URL 上带 &speed=（applySpeed 后重挂）。
   */
  function rebaseVtt(text, delta, linePercent, speed = 1) {
    const sp = Number(speed) > 0 ? Number(speed) : 1;
    const tsToSec = (ts) => {
      const p = ts.split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    const secToTs = (sec) => {
      const s = Math.max(0, sec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const rest = (s % 60).toFixed(3).padStart(6, '0');
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${rest}`;
    };
    const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\r?\n/);
    const out = [blocks[0] || 'WEBVTT', ''];
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i].trim();
      if (!b) continue;
      const lines = b.split(/\r?\n/);
      const tIdx = lines.findIndex((l) => /-->/.test(l));
      if (tIdx < 0) continue;
      const m = /^(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{2}:\d{2}(?::\d{2})?\.\d{3})/.exec(lines[tIdx]);
      if (!m) continue;
      // 先平移到流时间轴，再按倍速压缩（speed=1 时除法为恒等，不影响正常播放）
      let start = (tsToSec(m[1]) + delta) / sp;
      let end = (tsToSec(m[2]) + delta) / sp;
      if (end <= 0) continue; // 整条已在流起点之前：丢弃
      if (start < 0) start = 0;
      if (end < start + 0.05) end = start + 0.05;
      // 原有 cue 设置（如 align/position）保留，只补 / 覆盖 line
      const settings = lines[tIdx].slice(m[0].length).trim();
      const keep = settings.split(/\s+/).filter((x) => x && !x.startsWith('line:'));
      if (linePercent) keep.push(`line:${linePercent}%`);
      lines[tIdx] = `${secToTs(start)} --> ${secToTs(end)}${keep.length ? ' ' + keep.join(' ') : ''}`;
      out.push(lines.join('\n'), '');
    }
    return out.join('\n');
  }

  function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }

  async function serveHls(req, res, pathname, q) {
    const m = pathname.match(/^\/hls\/([^/]+)\/(g\d+)\/(.+)$/);
    if (!m) return notFound(res);
    const [, sid, gen, rest] = m;
    const dir = path.join(sessions.hlsDir, sid, gen);
    const full = path.join(dir, rest);
    if (!isSubPath(dir, full)) return notFound(res);
    if (!fs.existsSync(full)) return notFound(res);
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) return notFound(res);
    // 播放列表被拉取 = 播放端还活着：刷新会话活跃度（无人观看自动停止的依据）。
    // 分片请求不算（可能只是缓冲余量），只认 index.m3u8。
    if (rest.endsWith('.m3u8')) {
      const sess = sessions.detail(sid);
      if (sess) sess.markPlaylistFetch();
    }
    const type = rest.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': rest.endsWith('.m3u8') ? 'no-cache' : 'public, max-age=600',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(full).pipe(res);
  }

  /** 直接播放原始媒体（字幕/音频等辅助；视频默认走转码） */
  async function serveMedia(req, res, pathname, q) {
    const rel = pathname.slice('/media/'.length);
    const file = path.join(config.dataDir, 'media', rel);
    if (!fs.existsSync(file)) return notFound(res);
    return sendFile(req, res, file);
  }

  /**
   * 缩略图：`GET /thumb/<rootId>/<相对路径>?t=<时间秒>&token=...`
   *
   * 客户端「大图浏览」用。首次请求时用 ffmpeg 抽一帧存到 data/cache/thumbs，
   * 之后直接命中缓存（按 路径+大小+mtime 命名，文件被替换会自动失效）。
   * 生成失败（音频/损坏文件/无 ffmpeg）返回 404，客户端显示占位图。
   */
  async function serveThumb(req, res, pathname, q) {
    const rest = pathname.slice('/thumb/'.length);
    const slash = rest.indexOf('/');
    const rootId = slash < 0 ? rest : rest.slice(0, slash);
    const relPath = slash < 0 ? '' : rest.slice(slash + 1);
    const file = resolveMediaPath(rootId ? decodeURIComponent(rootId) : '', relPath);
    if (!fs.existsSync(file)) return notFound(res);

    let st;
    try { st = await fsp.stat(file); } catch (_) { return notFound(res); }
    const thumbsDir = path.join(config.dataDir, 'cache', 'thumbs');
    ensureDir(thumbsDir);
    const key = `${shortHash(`${file}|${st.size}|${Math.round(st.mtimeMs)}`, 16)}.jpg`;
    const out = path.join(thumbsDir, key);

    if (!fs.existsSync(out)) {
      // 同一张图被并发请求时避免重复起 ffmpeg
      if (!thumbJobs.has(out)) {
        const isImage = IMAGE_THUMB_EXT.has(path.extname(file).toLowerCase());
        // 图片（png/jpg/webp/bmp）是单帧：不能 -ss 定位，直接转码首帧
        const at = Math.max(1, Math.min(Number(q.t) || 6, Math.max(1, (st.size > 0 ? 600 : 6))));
        const seekArgs = isImage ? [] : ['-ss', String(at)];
        const job = new Promise((resolve) => {
          const args = [
            '-hide_banner', '-loglevel', 'error',
            ...seekArgs, '-i', file,
            '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', '-y', out
          ];
          const p = spawn(ffmpeg.ffmpegPath, args, { windowsHide: true });
          const done = () => resolve(fs.existsSync(out));
          p.on('close', done);
          p.on('error', () => resolve(false));
          setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 20000).unref?.();
        }).finally(() => thumbJobs.delete(out));
        thumbJobs.set(out, job);
      }
      await thumbJobs.get(out);
    }
    if (!fs.existsSync(out)) return notFound(res);
    const body = await fsp.readFile(out);
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': body.length,
      // 缩略图按文件内容命名，可放心长缓存
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  }

  /**
   * 原图直出：`GET /raw/<rootId>/<相对路径>?token=...`
   *
   * 图片不做转码会话，直接把源文件发给客户端（Glide/浏览器都吃原生格式）。
   * 复用 /thumb/ 的鉴权与路径解析；范围请求由 sendFile 支持。
   */
  async function serveRaw(req, res, pathname, q) {
    const rest = pathname.slice('/raw/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return notFound(res);
    const rootId = decodeURIComponent(rest.slice(0, slash));
    const relPath = rest.slice(slash + 1);
    // 鉴权：客户端带配对 token；本机（GUI/浏览器管理页走 /api/gui/* 的同一来源）
    // 与 GUI 一样免 token —— GUI 本来就是仅限本机的管理通道。
    const ip = clientIp(req);
    const isLocal = ip === '127.0.0.1' || ip === '::1';
    if (!isLocal) requireAuth(req, q);
    const file = resolveMediaPath(rootId, decodeURIComponent(relPath));
    if (!fs.existsSync(file)) return notFound(res);
    let st;
    try { st = await fsp.stat(file); } catch (_) { return notFound(res); }
    if (!st.isFile()) return notFound(res);
    return sendFile(req, res, file);
  }

  async function serveStatic(req, res, pathname, root) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let file = path.join(root, rel);
    if (!isSubPath(root, file)) return notFound(res);
    if (!fs.existsSync(file)) {
      // SPA 回退
      if (!path.extname(rel)) file = path.join(root, 'index.html');
      else return notFound(res);
    }
    return sendFile(req, res, file);
  }

  function sendFile(req, res, file) {
    const stat = fs.statSync(file);
    const type = mimeType(file);
    const range = req.headers.range;
    if (range) {
      const parts = /bytes=(\d*)-(\d*)/.exec(range);
      const start = parts && parts[1] ? Number(parts[1]) : 0;
      const end = parts && parts[2] ? Number(parts[2]) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  return { server, guiApi, publicInfo, clientIp, sendJson, getPort: () => ctx.port };
}

module.exports = { createHttpServer };
