'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const {
  ensureDir, isSubPath, formatDuration, humanSize, pickLanAddresses, nowIso
} = require('./util');

/**
 * GUI 专用管理接口（仅本机回环地址可访问）。
 * 与面向客户端的 /api/* 分开，避免暴露管理能力到局域网。
 */
function createGuiApi(ctx) {
  const { config, logger, library, sessions, ffmpeg, clients, app } = ctx;

  function isLoopback(req) {
    let ip = req.socket.remoteAddress || '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
  }

  function state({ sinceLog = 0, logLimit = 300 } = {}) {
    const info = ffmpeg.info();
    return {
      server: {
        name: config.get('serverName'),
        serverId: config.get('serverId'),
        port: ctx.port,
        urls: pickLanAddresses().map((a) => `http://${a.address}:${ctx.port}`),
        lanIp: (pickLanAddresses()[0] || {}).address || '127.0.0.1',
        pin: config.get('pin'),
        requirePin: !!config.get('requirePin'),
        discovery: !!config.get('discovery'),
        discoveryPort: config.get('discoveryPort'),
        version: app && app.getVersion ? app.getVersion() : '1.0.0',
        uptime: Math.round((Date.now() - ctx.startedAt) / 1000)
      },
      metrics: ctx.metrics ? ctx.metrics() : {},
      transcodeDefaults: config.get('transcode'),
      maxSessions: sessions.maxSessions,
      hardwareAccel: !!config.get('hardwareAccel'),
      sessions: sessions.list(),
      clients: clients.list(),
      roots: library.listRoots(),
      libraryVersion: library.version,
      watcher: ctx.watcher ? { dirs: ctx.watcher.stats.dirs, events: ctx.watcher.stats.events, confirmed: ctx.watcher.stats.confirmed, falsePositives: ctx.watcher.stats.falsePositives, lastEventAt: ctx.watcher.stats.lastEventAt } : null,
      history: sessions.history.slice(0, 20),
      ffmpeg: info,
      logs: logger.list({ since: sinceLog, limit: logLimit }),
      logSeq: logger.seq
    };
  }

  async function handle(req, res, pathname, q, body) {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '管理接口仅限本机访问' }));
      return true;
    }
    const json = (code, data) => {
      const text = JSON.stringify(data);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
      res.end(text);
    };
    const ok = (data) => json(200, Object.assign({ ok: true }, data || {}));
    const route = pathname.replace(/^\/api\/gui\//, '');

    try {
      switch (`${req.method} ${route}`) {
        case 'GET state':
          return json(200, state({ sinceLog: Number(q.since) || 0 })), true;

        case 'GET browse-fs': {
          // GUI 内添加引用时浏览本机目录
          const target = q.path ? path.resolve(q.path) : '';
          const places = [];
          for (const letter of 'CDEFGH') {
            try { if (fs.existsSync(`${letter}:\\`)) places.push({ name: `${letter}:\\`, path: `${letter}:\\`, type: 'drive' }); } catch (_) {}
          }
          places.push({ name: '桌面', path: path.join(os.homedir(), 'Desktop'), type: 'dir' });
          places.push({ name: '下载', path: path.join(os.homedir(), 'Downloads'), type: 'dir' });
          places.push({ name: '视频', path: path.join(os.homedir(), 'Videos'), type: 'dir' });
          if (!target) return json(200, { path: '', parent: null, places, entries: [] }), true;
          let entries = [];
          try {
            entries = (await fsp.readdir(target, { withFileTypes: true }))
              .filter((e) => !e.name.startsWith('.'))
              .map((e) => ({ name: e.name, path: path.join(target, e.name), type: e.isDirectory() ? 'dir' : 'file' }))
              .filter((e) => e.type === 'dir' || /\.(mkv|mp4|avi|mov|m2ts|ts|flv|wmv|webm|rmvb|mp3|flac|m4a)$/i.test(e.name))
              .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
              .slice(0, 500);
          } catch (e) { /* 无权限 */ }
          const parent = path.dirname(target);
          return json(200, { path: target, parent: parent === target ? null : parent, places, entries }), true;
        }

        case 'POST roots': {
          const paths = Array.isArray(body.paths) ? body.paths : [body.path];
          const added = [];
          const failed = [];
          for (const p of paths) {
            try { added.push(library.addRoot(p, { name: body.name })); } catch (e) { failed.push({ path: p, error: e.message }); }
          }
          for (const r of added) {
            try { if (r.type === 'dir' && ctx.watcher) ctx.watcher.watch(r.path); } catch (_) { /* ignore */ }
          }
          return ok({ added, failed, version: library.version }), true;
        }

        case 'PATCH roots': {
          const root = library.updateRoot(body.id, body);
          return ok({ root, version: library.version }), true;
        }

        case 'DELETE roots': {
          library.removeRoot(body.id);
          return ok({ version: library.version }), true;
        }

        // 批量：多选启用/禁用/移除/全部移除
        case 'POST roots-batch': {
          const action = String(body.action || '');
          const ids = Array.isArray(body.ids) ? body.ids : [];
          if (action === 'remove' || action === 'purge') {
            const removed = library.removeMany(ids, { all: action === 'purge' });
            return ok({ removed: removed.map((r) => r.id), version: library.version }), true;
          }
          if (action === 'enable' || action === 'disable') {
            const updated = library.updateMany(ids, { enabled: action === 'enable' });
            return ok({ updated: updated.map((r) => r.id), version: library.version }), true;
          }
          return json(400, { error: '不支持的操作' }), true;
        }

        // 目录监听：立即扫描并开始监听（客户端浏览时也会自动触发）
        case 'POST watch': {
          const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : library.roots.map((r) => r.id));
          let count = 0;
          for (const id of ids) {
            const root = library.findRoot(id);
            if (root && root.type === 'dir' && ctx.watcher) {
              ctx.watcher.watch(root.path);
              count += 1;
            }
          }
          return ok({ watching: count, dirs: ctx.watcher ? ctx.watcher.stats.dirs : 0 }), true;
        }

        case 'GET browse': {
          // sort/order 必须透传，否则 GUI 的排序下拉框选了也没用（列表始终按名称升序）。
          const result = await library.browse(
            body.rootId || q.rootId,
            body.path || q.path || '',
            { sort: q.sort || body.sort || '', order: q.order || body.order || '' }
          );
          return json(200, result), true;
        }

        case 'POST settings': {
          const allowed = ['serverName', 'port', 'autoPort', 'requirePin', 'maxSessions', 'discovery', 'hardwareAccel', 'transcode'];
          const patch = {};
          for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
          if (patch.transcode) patch.transcode = Object.assign({}, config.get('transcode'), patch.transcode);
          config.patch(patch);
          if (patch.serverName) logger.info(`服务名已更新为「${patch.serverName}」`);
          if (patch.transcode) logger.info(`转码默认参数已更新：${JSON.stringify(patch.transcode)}`);
          return ok({ config: config.data }), true;
        }

        case 'POST pin': {
          const pin = config.regeneratePin();
          logger.info(`已重新生成配对码：${pin}`);
          return ok({ pin }), true;
        }

        case 'POST pin-check': {
          return ok({ valid: clients.verifyPin(body.pin) }), true;
        }

        case 'POST sessions-stop': {
          await sessions.stop(body.id, '服务端手动停止');
          return ok(), true;
        }

        case 'GET sessions': return json(200, { sessions: sessions.list() }), true;
        case 'GET clients': return json(200, { clients: clients.list() }), true;
        case 'POST clients-kick': {
          clients.kick(body.id);
          return ok(), true;
        }
        case 'POST ffmpeg-detect': {
          await ffmpeg.detect();
          return ok({ ffmpeg: ffmpeg.info() }), true;
        }
        case 'GET logs': return json(200, { logs: logger.list({ since: Number(q.since) || 0, limit: Number(q.limit) || 500 }) }), true;
        case 'POST logs-clear': logger.clear(); return ok(), true;
        case 'GET logs-export':
        case 'POST logs-export': {
          const dir = path.join(config.dataDir, 'logs');
          const file = path.join(dir, `export-${Date.now()}.txt`);
          fs.writeFileSync(file, logger.exportText(), 'utf8');
          return ok({ file }), true;
        }
        case 'POST open-folder': {
          const target = body.path || config.dataDir;
          if (!fs.existsSync(target)) throw new Error('目录不存在');
          if (process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
          else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
          return ok(), true;
        }
        // 系统默认播放器预览（补充 19）：不做转码会话，直接用 Windows 文件关联打开本地文件
        // （explorer.exe <file> ≡ 双击该文件 → 系统弹出「用 xxx 打开」/默认播放器接管）。
        // 只允许本机存在的媒体文件；路径必须能解析到某个引用内部（防任意路径打开）。
        case 'POST open-with-player': {
          const target = String(body.path || '');
          if (!target) throw new Error('缺少路径');
          const hit = library.resolveWithinRoots(target);
          if (!hit) throw new Error('文件不在媒体源内');
          const real = hit.path;
          if (!fs.existsSync(real)) throw new Error('文件不存在');
          const st = fs.statSync(real);
          if (!st.isFile()) throw new Error('不是文件');
          if (process.platform === 'win32') spawn('explorer.exe', [real], { detached: true, stdio: 'ignore' }).unref();
          else spawn('xdg-open', [real], { detached: true, stdio: 'ignore' }).unref();
          return ok({ path: real }), true;
        }
        case 'POST reveal-file': {
          // 与 open-with-player 同等校验：路径必须能解析到某个媒体源内部（防任意路径定位）。
          const target = String(body.path || '');
          if (!target) throw new Error('缺少路径');
          const hit = library.resolveWithinRoots(target);
          if (!hit) throw new Error('文件不在媒体源内');
          if (!fs.existsSync(hit.path)) throw new Error('文件不存在');
          if (process.platform === 'win32') spawn('explorer.exe', ['/select,', hit.path], { detached: true, stdio: 'ignore' }).unref();
          return ok(), true;
        }
        case 'POST pick-folder': {
          if (!ctx.pickFolder) throw new Error('当前环境不支持系统文件夹选择');
          const dirs = await ctx.pickFolder();
          return ok({ paths: dirs || [] }), true;
        }
        case 'POST pick-files': {
          if (!ctx.pickFiles) throw new Error('当前环境不支持系统文件选择');
          const files = await ctx.pickFiles();
          return ok({ paths: files || [] }), true;
        }
        case 'POST quit': {
          setTimeout(() => { if (ctx.quit) ctx.quit(); }, 300);
          return ok(), true;
        }
        case 'GET net': {
          return json(200, {
            addresses: pickLanAddresses(),
            hostname: os.hostname(),
            platform: `${process.platform} ${process.arch}`
          }), true;
        }
        default:
          return json(404, { error: `未知管理接口 ${req.method} ${route}` }), true;
      }
    } catch (err) {
      logger.error(`GUI 操作失败：${err.message}`);
      json(400, { ok: false, error: err.message });
      return true;
    }
  }

  return { handle, state, isLoopback };
}

module.exports = { createGuiApi };
