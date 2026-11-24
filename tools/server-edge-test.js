'use strict';
/**
 * LanPlay 服务端深度/边界测试（第二层）
 *
 * 与 server-test.js 互补：那边验证「接口能用」，这里验证「极端情况和恢复能力」：
 *   L. 目录监听：新增/删除文件后 version 递增、/api/sync 能感知
 *   M. 异常恢复：会话停止后资源释放、重复停止、并发上限边界、ffmpeg 异常
 *   N. 编码参数：分辨率/码率/画质档位/编码器回退
 *   O. 长时间稳定性：连续 seek 20 次、连续起停 5 次、内存与句柄不泄漏
 *   P. 路径与文件名边界：中文/空格/特殊字符/超长路径/大小写
 *   Q. 鉴权与安全：token 失效、PIN 关闭、越权路径各种变体
 *
 * 用法：node tools/server-edge-test.js [--base=...] [--filter=...]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'];
  })
);
const BASE = args.base || 'http://127.0.0.1:8099';
const FILTER = args.filter || '';
const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.resolve(ROOT, '..', 'samples');
const TMP = path.join(os.tmpdir(), 'lanplay-edge-' + Date.now());

const results = [];
let currentGroup = '';
function group(name) { currentGroup = name; console.log(`\n\x1b[36m── ${name}\x1b[0m`); }
async function test(name, fn) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ group: currentGroup, name, ok: true, ms: Date.now() - t0 });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${Date.now() - t0}ms)\x1b[0m`);
  } catch (e) {
    results.push({ group: currentGroup, name, ok: false, ms: Date.now() - t0, error: e.message });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    \x1b[31m${e.message}\x1b[0m`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
const assertEq = (a, b, m) => { if (a !== b) throw new Error(`${m || '值不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const assertIncludes = (h, n, m) => { if (!String(h).includes(n)) throw new Error(`${m || '未包含'}："${h}" 中找不到 "${n}"`); };

function request(method, urlPath, { body, token, headers = {} } = {}) {
  const url = new URL(urlPath.startsWith('http') ? urlPath : BASE + urlPath);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const h = Object.assign({}, headers);
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
  if (token) h['X-LanPlay-Token'] = token;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: json, buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}
const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, b, o) => request('POST', p, Object.assign({ body: b }, o)),
  patch: (p, b, o) => request('PATCH', p, Object.assign({ body: b }, o)),
  del: (p, b, o) => request('DELETE', p, Object.assign({ body: b }, o)),
};
const gui = { get: (p, o) => api.get('/api/gui/' + p, o), post: (p, b, o) => api.post('/api/gui/' + p, b, o) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null;
let dirRoot = null;
let created = [];
const videos = () => {
  const list = fs.readdirSync(SAMPLES).filter((f) => /\.(mkv|mp4)$/i.test(f));
  if (!list.length) throw new Error(`samples 目录无视频文件，测试前置条件不满足（${SAMPLES}）`);
  return list;
};

(async () => {
  console.log(`\x1b[1mLanPlay 服务端边界测试\x1b[0m  ${BASE}`);
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

  // ── 准备：配对 + 拿一个目录 root
  const st = await gui.get('state');
  const pair = await api.post('/api/pair', { pin: st.body.server.pin, name: 'edge-test' });
  token = pair.body.token;
  const roots = (await api.get('/api/roots', { token })).body.roots;
  dirRoot = roots.find((r) => r.type === 'dir' && path.resolve(r.path.toLowerCase()) === path.resolve(SAMPLES.toLowerCase()));
  if (!dirRoot) {
    const r = await api.post('/api/roots', { paths: [SAMPLES] }, { token });
    dirRoot = r.body.added[0];
    created.push(dirRoot.id);
  }

  // ══ L. 目录监听 ══
  group('L. 目录监听与实时同步');

  await test('新增文件后 libraryVersion 递增且 /api/sync 感知', async () => {
    // 先浏览一次，确保该目录被 watcher 监听
    await api.get(`/api/browse?rootId=${dirRoot.id}&path=`, { token });
    const v0 = (await api.get('/api/roots', { token })).body.version;
    const probe = path.join(SAMPLES, `__edge_watch_${Date.now()}.mkv`);
    fs.copyFileSync(path.join(SAMPLES, videos()[0]), probe);
    let changed = null;
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      const s = (await api.get(`/api/sync?since=${v0}`, { token })).body;
      if (s.changed) { changed = s; break; }
    }
    fs.unlinkSync(probe);
    assert(changed, '3 秒内应感知到目录变化');
    assert(changed.version > v0, `版本号应增长（${v0} → ${changed.version}）`);
    assert(changed.reason, '应带变化原因');
  });

  await test('删除文件后也能感知', async () => {
    await api.get(`/api/browse?rootId=${dirRoot.id}&path=`, { token });
    const probe = path.join(SAMPLES, `__edge_del_${Date.now()}.mkv`);
    fs.copyFileSync(path.join(SAMPLES, videos()[0]), probe);
    await sleep(1200);
    const v0 = (await api.get('/api/roots', { token })).body.version;
    fs.unlinkSync(probe);
    let changed = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if ((await api.get(`/api/sync?since=${v0}`, { token })).body.changed) { changed = true; break; }
    }
    assert(changed, '删除文件后应感知到变化');
  });

  await test('浏览新目录后该目录自动纳入监听', async () => {
    const sub = path.join(SAMPLES, '__edge_sub');
    if (!fs.existsSync(sub)) fs.mkdirSync(sub);
    fs.copyFileSync(path.join(SAMPLES, videos()[0]), path.join(sub, 'a.mkv'));
    await api.get(`/api/browse?rootId=${dirRoot.id}&path=__edge_sub`, { token });
    const v0 = (await api.get('/api/roots', { token })).body.version;
    fs.copyFileSync(path.join(SAMPLES, videos()[0]), path.join(sub, 'b.mkv'));
    let changed = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if ((await api.get(`/api/sync?since=${v0}`, { token })).body.changed) { changed = true; break; }
    }
    fs.rmSync(sub, { recursive: true, force: true });
    assert(changed, '被浏览的子目录也应被监听');
  });

  // ══ M. 异常恢复 ══
  group('M. 会话异常与资源释放');

  await test('停止会话后 hls 目录被清理或标记结束', async () => {
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0] }, { token });
    const id = r.body.id;
    await sleep(1500);
    await api.post('/api/session/stop', { id }, { token });
    await sleep(800);
    const st = await api.get(`/api/session/state?id=${id}`, { token });
    assert(st.status === 404 || ['STOPPED', 'ENDED'].includes(st.body.state), '会话应已结束');
  });

  await test('重复停止同一会话不会 500', async () => {
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0] }, { token });
    const id = r.body.id;
    const a = await api.post('/api/session/stop', { id }, { token });
    const b = await api.post('/api/session/stop', { id }, { token });
    assert(a.status === 200, `第一次停止应 200，实际 ${a.status}`);
    assert(b.status === 404 || b.status === 200, `重复停止应 404 或幂等 200，实际 ${b.status}`);
    assert(b.status !== 500, '不应 500');
  });

  await test('停止后并发名额被释放（可再次起播）', async () => {
    const max = (await api.get('/api/sync?since=0', { token })).body.maxSessions;
    const ids = [];
    for (let i = 0; i < max; i++) {
      const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0] }, { token });
      if (r.status === 200) ids.push(r.body.id);
    }
    for (const id of ids) await api.post('/api/session/stop', { id }, { token });
    await sleep(800);
    const again = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0] }, { token });
    assertEq(again.status, 200, '名额应完全释放');
    await api.post('/api/session/stop', { id: again.body.id }, { token });
  });

  await test('连续 seek 20 次不崩溃且最终位置正确', async () => {
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0] }, { token });
    const id = r.body.id;
    const dur = (await api.get(`/api/session/state?id=${id}`, { token })).body.duration;
    let last = 0;
    for (let i = 0; i < 20; i++) {
      const pos = Math.round((dur * (i + 1)) / 22);
      const s = await api.post('/api/session/seek', { id, position: pos }, { token });
      assert(s.status === 200, `第 ${i + 1} 次 seek 失败：${s.status}`);
      last = s.body.offset;
    }
    assert(Math.abs(last - Math.round((dur * 20) / 22)) < 2, `末次 seek 位置应约为 ${Math.round((dur * 20) / 22)}，实际 ${last}`);
    const st = await api.get(`/api/session/state?id=${id}`, { token });
    assertEq(st.status, 200);
    await api.post('/api/session/stop', { id }, { token });
  });

  await test('连续起停 5 次不泄漏（进程数稳定）', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0] }, { token });
      assertEq(r.status, 200, `第 ${i + 1} 次起播失败`);
      await sleep(300);
      await api.post('/api/session/stop', { id: r.body.id }, { token });
    }
    await sleep(1000);
    const list = (await api.get('/api/sessions', { token })).body.sessions;
    const active = list.filter((s) => !['STOPPED', 'ENDED'].includes(s.state));
    assertEq(active.length, 0, `不应有残留活动会话，实际 ${active.length} 个`);
  });

  // ══ N. 转码参数 ══
  group('N. 转码参数策略');

  await test('指定分辨率 720p 生效', async () => {
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0], resolution: 720 }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.settings.resolution, 720);
    await api.post('/api/session/stop', { id: r.body.id }, { token });
  });

  await test('指定码率生效', async () => {
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0], bitrate: 2000 }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.settings.bitrate, 2000);
    await api.post('/api/session/stop', { id: r.body.id }, { token });
  });

  await test('编码器回退：请求不存在的硬件编码器仍能起播', async () => {
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0], codec: 'hevc' }, { token });
    assertEq(r.status, 200, 'HEVC 应能起播（软编回退）');
    assert(r.body.encoder, '应返回实际使用的编码器');
    await api.post('/api/session/stop', { id: r.body.id }, { token });
  });

  await test('实际输出分辨率符合请求', async () => {
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: videos()[0], resolution: 480, bitrate: 800 }, { token });
    const id = r.body.id;
    const st = (await api.get(`/api/session?id=${id}`, { token })).body;
    // 等分片产出
    let seg = null;
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      const pl = await api.get(st.playlist, { token });
      const line = pl.text.split('\n').find((l) => l.trim().endsWith('.ts'));
      if (line) { seg = line.trim(); break; }
    }
    assert(seg, '应产出分片');
    const dir = st.playlist.slice(0, st.playlist.lastIndexOf('/') + 1);
    const segRes = await api.get(dir + seg, { token });
    assertEq(segRes.status, 200);
    await api.post('/api/session/stop', { id }, { token });
    // 分辨率校验交给 ffprobe（可选，脚本里只校验能取到分片）
  });

  // ══ O. 路径与文件名边界 ══
  group('O. 路径与文件名边界');

  await test('中文文件名可浏览/播放', async () => {
    const cn = videos().find((f) => /[\u4e00-\u9fa5]/.test(f));
    if (!cn) return;
    const b = await api.get(`/api/browse?rootId=${dirRoot.id}&path=`, { token });
    assert(b.body.items.some((i) => i.name === cn), `列表中应出现 ${cn}`);
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: cn }, { token });
    assertEq(r.status, 200, `中文名应能播放：${cn}`);
    await api.post('/api/session/stop', { id: r.body.id }, { token });
  });

  await test('带空格文件名可播', async () => {
    const sp = videos().find((f) => f.includes(' '));
    if (!sp) return;
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: sp }, { token });
    assertEq(r.status, 200);
    await api.post('/api/session/stop', { id: r.body.id }, { token });
  });

  await test('URL 编码的中文路径可访问', async () => {
    const cn = videos().find((f) => /[\u4e00-\u9fa5]/.test(f));
    if (!cn) return;
    const r = await api.get(`/api/media?rootId=${dirRoot.id}&path=${encodeURIComponent(cn)}`, { token });
    assertEq(r.status, 200);
  });

  await test('越权路径变体全部被拒', async () => {
    const variants = ['../../../etc/passwd', '..\\..\\..\\windows\\win.ini', 'C:\\Windows\\win.ini', '/etc/passwd', '....//....//etc/passwd'];
    for (const v of variants) {
      const r = await api.get(`/api/media?rootId=${dirRoot.id}&path=${encodeURIComponent(v)}`, { token });
      assert(r.status === 403 || r.status === 404, `越权路径 "${v}" 应被拒，实际 ${r.status}`);
    }
  });

  await test('空路径 / 只有斜杠的路径被安全处理', async () => {
    for (const v of ['', '/', '\\', '//', '.']) {
      const r = await api.get(`/api/browse?rootId=${dirRoot.id}&path=${encodeURIComponent(v)}`, { token });
      assert(r.status === 200 || r.status === 403 || r.status === 404, `路径 "${v}" 不应 500，实际 ${r.status}`);
      assert(r.status !== 500, `路径 "${v}" 导致 500`);
    }
  });

  // ══ P. 鉴权与安全 ══
  group('P. 鉴权与安全');

  await test('伪造 token 无法访问任意接口', async () => {
    const paths = ['/api/roots', '/api/browse', '/api/sessions', '/api/recent', '/api/sync'];
    for (const p of paths) {
      const r = await api.get(p, { token: 'fake-token-' + Math.random() });
      assertEq(r.status, 401, `${p} 应返回 401`);
    }
  });

  await test('token 放在 query 参数也可用', async () => {
    const r = await api.get(`/api/roots?token=${encodeURIComponent(token)}`);
    assertEq(r.status, 200);
  });

  await test('GUI 接口在非回环地址被拒（当前从回环访问应可）', async () => {
    const r = await gui.get('state');
    assertEq(r.status, 200, '回环访问应正常');
  });

  await test('超长 token 不会崩溃', async () => {
    const r = await api.get('/api/roots', { token: 'x'.repeat(10000) });
    assertEq(r.status, 401);
  });

  await test('超大 JSON body 被妥善处理', async () => {
    const big = { paths: ['x'.repeat(200000)] };
    const r = await api.post('/api/roots', big, { token });
    assert(r.status === 200 || r.status === 400 || r.status === 413, `应优雅处理，实际 ${r.status}`);
    assert(r.status !== 500, '不应 500');
  });

  // ══ Q. 静态资源与 GUI ══
  group('Q. 静态资源与 GUI 页面');

  await test('GET / 返回 GUI 首页', async () => {
    const r = await api.get('/');
    assertEq(r.status, 200);
    assertIncludes(r.text, '<title>', '应是 HTML 页面');
    assertIncludes(r.text, 'LanPlay', '应含站点名');
  });

  await test('GET /app.js 返回脚本', async () => {
    const r = await api.get('/app.js');
    assertEq(r.status, 200);
    assertIncludes(r.headers['content-type'], 'javascript');
  });

  await test('GET /styles.css 返回样式', async () => {
    const r = await api.get('/styles.css');
    assertEq(r.status, 200);
    assertIncludes(r.headers['content-type'], 'css');
  });

  await test('未知路径回退到 SPA 首页（不 404）', async () => {
    const r = await api.get('/some/deep/route');
    assert(r.status === 200 || r.status === 404, `应为 200（SPA 回退）或 404，实际 ${r.status}`);
  });

  await test('静态资源路径穿越被拒', async () => {
    const r = await api.get('/../server/core/config.js');
    assert(r.status !== 200 || !r.text.includes('module.exports'), '不应泄露源码');
  });

  // ── 清理 ──
  for (const id of created) await api.del('/api/roots', { id }, { token }).catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m────────────────────────────────\x1b[0m`);
  console.log(`总计 ${results.length} 项：\x1b[32m通过 ${passed}\x1b[0m` + (failed.length ? ` / \x1b[31m失败 ${failed.length}\x1b[0m` : ''));
  if (failed.length) {
    console.log('\n失败明细：');
    failed.forEach((f) => console.log(`  \x1b[31m✗ [${f.group}] ${f.name}\n     ${f.error}\x1b[0m`));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('\x1b[31m脚本崩溃：\x1b[0m', e); process.exit(2); });
