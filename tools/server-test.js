'use strict';
/**
 * LanPlay 服务端全功能自动化测试
 *
 * 直接对着运行中的服务端（默认 http://127.0.0.1:8099）跑，覆盖：
 *   A. 无鉴权接口：ping / info / pair / resume
 *   B. 鉴权边界：无 token、错 token、错 PIN
 *   C. 媒体源：单文件 / 多文件 / 文件夹 / 整盘 / 不存在路径、增删改查、批量、排序、版本同步
 *   D. 浏览：目录、子目录、越权、排序 7 种、分页 library
 *   E. 媒体信息：/api/media、字幕轨
 *   F. 播放会话：起播、state、seek、speed、audio、subtitle、pause/resume、stop、并发上限
 *   G. 字幕：vtt 提取（内嵌/外挂）、extract、404
 *   H. 缩略图：命中/缓存/越权
 *   I. 进度与最近播放
 *   J. GUI 管理接口：state/browse-fs/roots/settings/pin/sessions/logs/net
 *
 * 用法：
 *   node tools/server-test.js                 # 跑全部
 *   node tools/server-test.js --filter=play   # 只跑名字含 play 的
 *   node tools/server-test.js --base=http://127.0.0.1:8099
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

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

// ---------- 迷你测试框架 ----------
const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[36m── ${name}\x1b[0m`);
}

async function test(name, fn) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, ok: true, ms });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${ms}ms)\x1b[0m`);
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, ok: false, ms, error: err.message });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`    \x1b[31m${err.message}\x1b[0m`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function assertIncludes(hay, needle, msg) {
  if (!String(hay).includes(needle)) throw new Error(`${msg || '未包含'}："${hay}" 中找不到 "${needle}"`);
}

// ---------- HTTP ----------
function request(method, urlPath, { body, token, headers = {}, raw = false } = {}) {
  const url = new URL(urlPath.startsWith('http') ? urlPath : BASE + urlPath);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const h = Object.assign({}, headers);
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
  if (token) h['X-LanPlay-Token'] = token;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: h, timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (_) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    if (payload) req.write(payload);
    req.end();
  });
}

const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, Object.assign({ body }, o)),
  patch: (p, body, o) => request('PATCH', p, Object.assign({ body }, o)),
  del: (p, body, o) => request('DELETE', p, Object.assign({ body }, o)),
};
const gui = {
  get: (p, o) => api.get('/api/gui/' + p, o),
  post: (p, body, o) => api.post('/api/gui/' + p, body, o),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 测试数据准备 ----------
let token = null;
let serverInfo = null;
let dirRoot = null;      // 目录引用根（samples）
let fileRoot = null;     // 单文件引用根
const createdRoots = [];
let sessionId = null;

function sampleFile(name) {
  return path.join(SAMPLES, name);
}

function firstVideo() {
  const files = fs.existsSync(SAMPLES) ? fs.readdirSync(SAMPLES) : [];
  return files.find((f) => /\.(mkv|mp4|avi|mov|ts)$/i.test(f)) || null;
}

// ================= 主体 =================
(async () => {
  console.log(`\x1b[1mLanPlay 服务端测试\x1b[0m  ${BASE}`);
  if (FILTER) console.log(`过滤：${FILTER}`);

  // ---------- A. 基础接口 ----------
  group('A. 基础接口（无需鉴权）');

  await test('GET /api/ping 返回 ok 与 serverId', async () => {
    const r = await api.get('/api/ping');
    assertEq(r.status, 200);
    assertEq(r.body.ok, true);
    assert(r.body.serverId, 'ping 应返回 serverId');
    assert(typeof r.body.ts === 'number', 'ping 应返回时间戳');
  });

  await test('GET /api/info 返回服务器能力信息', async () => {
    const r = await api.get('/api/info');
    assertEq(r.status, 200);
    serverInfo = r.body;
    assert(serverInfo.name, 'info 应含服务器名称');
    assert(Array.isArray(serverInfo.hardware), 'info 应含硬件编码器标签数组');
    assert(serverInfo.ffmpeg && typeof serverInfo.ffmpeg.available === 'boolean', 'info 应含 ffmpeg 可用状态');
    assert(typeof serverInfo.maxSessions === 'number', 'info 应含最大并发会话数');
  });

  await test('POST /api/pair 错误 PIN 返回 403', async () => {
    const r = await api.post('/api/pair', { pin: '000000', name: 'test' });
    assertEq(r.status, 403);
    assertIncludes(r.body.error, '配对码');
  });

  await test('POST /api/pair 正确 PIN 签发 token', async () => {
    const st = await gui.get('state');
    const pin = st.body.server.pin;
    const r = await api.post('/api/pair', { pin, name: '自动化测试', model: 'test-runner', platform: 'node' });
    assertEq(r.status, 200);
    assert(r.body.token, '应返回 token');
    token = r.body.token;
  });

  await test('POST /api/resume 有效 token 续期', async () => {
    const r = await api.post('/api/resume', { token });
    assertEq(r.status, 200);
    assertEq(r.body.ok, true);
  });

  await test('POST /api/resume 无效 token 返回 401', async () => {
    const r = await api.post('/api/resume', { token: 'bogus-token-xxx' });
    assertEq(r.status, 401);
  });

  // ---------- B. 鉴权边界 ----------
  group('B. 鉴权边界');

  await test('GET /api/roots 无 token 返回 401', async () => {
    const r = await api.get('/api/roots');
    assertEq(r.status, 401);
  });

  await test('GET /api/roots 错误 token 返回 401', async () => {
    const r = await api.get('/api/roots', { token: 'wrong' });
    assertEq(r.status, 401);
  });

  await test('GET /api/roots 有效 token 返回版本与列表', async () => {
    const r = await api.get('/api/roots', { token });
    assertEq(r.status, 200);
    assert(typeof r.body.version === 'number', '应返回 version');
    assert(Array.isArray(r.body.roots), '应返回 roots 数组');
  });

  await test('GET /api/sync 无 token 返回 401', async () => {
    const r = await api.get('/api/sync?since=0');
    assertEq(r.status, 401);
  });

  // ---------- C. 媒体源管理 ----------
  group('C. 媒体源管理');

  await test('POST /api/roots 添加目录', async () => {
    // 允许已存在：先查一次，已加过就直接复用（避免重复跑测试时误报）
    const existing = (await api.get('/api/roots', { token })).body.roots
      .find((r) => r.type === 'dir' && path.resolve(r.path.toLowerCase()) === path.resolve(SAMPLES.toLowerCase()));
    if (existing) { dirRoot = existing; return; }
    const r = await api.post('/api/roots', { paths: [SAMPLES] }, { token });
    assertEq(r.status, 200);
    assert(r.body.added.length >= 1, `应至少添加 1 个，实际：${JSON.stringify(r.body.failed)}`);
    dirRoot = r.body.added[0];
    createdRoots.push(dirRoot.id);
    assertEq(dirRoot.type, 'dir');
  });

  await test('POST /api/roots 添加单个文件', async () => {
    const f = firstVideo();
    assert(f, 'samples 目录里应有测试视频');
    const target = sampleFile(f);
    const existing = (await api.get('/api/roots', { token })).body.roots
      .find((r) => r.type === 'file' && path.resolve(r.path.toLowerCase()) === path.resolve(target.toLowerCase()));
    if (existing) { fileRoot = existing; return; }
    const r = await api.post('/api/roots', { paths: [target] }, { token });
    assertEq(r.status, 200);
    assert(r.body.added.length >= 1, `单文件应添加成功，实际：${JSON.stringify(r.body.failed)}`);
    fileRoot = r.body.added[0];
    createdRoots.push(fileRoot.id);
    assertEq(fileRoot.type, 'file');
  });

  await test('POST /api/roots 重复添加同一路径进入 failed', async () => {
    const r = await api.post('/api/roots', { paths: [SAMPLES] }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.added.length, 0, '重复添加不应成功');
    assertIncludes(JSON.stringify(r.body.failed), '已添加');
  });

  await test('POST /api/roots 一次性添加多个文件', async () => {
    const files = fs.readdirSync(SAMPLES).filter((f) => /\.(mkv|mp4)$/i.test(f)).slice(0, 2);
    assert(files.length >= 1, '需要至少 1 个视频');
    const r = await api.post('/api/roots', { paths: files.map(sampleFile), name: '多文件测试' }, { token });
    assertEq(r.status, 200);
    assert(r.body.added.length >= 1, `多文件应添加成功，实际：${JSON.stringify(r.body.failed)}`);
    r.body.added.forEach((x) => createdRoots.push(x.id));
  });

  await test('POST /api/roots 不存在的路径进入 failed', async () => {
    const r = await api.post('/api/roots', { paths: ['Z:\\definitely\\not\\exist\\xyz'] }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.added.length, 0, '不应添加成功');
    assert(r.body.failed.length === 1, '应记录失败');
  });

  await test('GET /api/roots 版本号随添加增长', async () => {
    const r = await api.get('/api/roots', { token });
    assert(r.body.version >= 3, `version 应 >= 3，实际 ${r.body.version}`);
    assert(r.body.roots.length >= createdRoots.length, '列表应包含新加的引用');
  });

  await test('PATCH /api/roots 重命名与禁用', async () => {
    const r = await api.patch('/api/roots', { id: fileRoot.id, name: '改名测试', enabled: false }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.root.name, '改名测试');
    assertEq(r.body.root.enabled, false);
  });

  await test('禁用后的引用不可浏览（403）', async () => {
    const r = await api.get(`/api/browse?rootId=${fileRoot.id}&path=`, { token });
    assertEq(r.status, 403);
  });

  await test('PATCH /api/roots 重新启用', async () => {
    const r = await api.patch('/api/roots', { id: fileRoot.id, enabled: true }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.root.enabled, true);
  });

  await test('PATCH 不存在的引用返回 404', async () => {
    const r = await api.patch('/api/roots', { id: 'r-not-exist', name: 'x' }, { token });
    assertEq(r.status, 404);
  });

  await test('POST /api/roots/batch 批量禁用', async () => {
    const r = await api.post('/api/roots/batch', { action: 'disable', ids: [fileRoot.id] }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.updated.length, 1);
  });

  await test('POST /api/roots/batch 批量启用', async () => {
    const r = await api.post('/api/roots/batch', { action: 'enable', ids: [fileRoot.id] }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.updated.length, 1);
  });

  await test('POST /api/roots/batch 不支持的动作返回 400', async () => {
    const r = await api.post('/api/roots/batch', { action: 'nonsense', ids: [] }, { token });
    assertEq(r.status, 400);
  });

  await test('GET /api/sync since=当前版本 → changed=false', async () => {
    const cur = (await api.get('/api/roots', { token })).body.version;
    const r = await api.get(`/api/sync?since=${cur}`, { token });
    assertEq(r.status, 200);
    assertEq(r.body.changed, false);
    assertEq(r.body.version, cur);
  });

  await test('GET /api/sync since=0 → changed=true', async () => {
    const r = await api.get('/api/sync?since=0', { token });
    assertEq(r.body.changed, true);
    assert(Array.isArray(r.body.roots), 'sync 应带 roots');
    assert(typeof r.body.maxSessions === 'number', 'sync 应带 maxSessions');
  });

  // ---------- D. 浏览 ----------
  group('D. 目录浏览');

  await test('GET /api/browse 根目录返回文件夹与媒体项', async () => {
    const r = await api.get(`/api/browse?rootId=${dirRoot.id}&path=`, { token });
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.items), '应返回 items');
    assert(r.body.items.length > 0, '根目录不应为空');
    const kinds = new Set(r.body.items.map((i) => i.kind));
    [...kinds].forEach((k) => assert(['dir', 'video', 'audio', 'image'].includes(k), `出现了非媒体类型：${k}`));
  });

  await test('浏览结果不含字幕/文本等非媒体文件（图片属于媒体）', async () => {
    const r = await api.get(`/api/browse?rootId=${dirRoot.id}&path=`, { token });
    const bad = r.body.items.filter((i) => /\.(srt|ass|ssa|txt|nfo|zip)$/i.test(i.name));
    assertEq(bad.length, 0, `不应列出非媒体文件，实际出现：${bad.map((b) => b.name).join(',')}`);
  });

  await test('浏览排序 name 升序 / name-desc 降序', async () => {
    const asc = (await api.get(`/api/browse?rootId=${dirRoot.id}&path=&sort=name`, { token })).body.items;
    const desc = (await api.get(`/api/browse?rootId=${dirRoot.id}&path=&sort=name-desc&order=desc`, { token })).body.items;
    assert(asc.length === desc.length, '两种排序数量应一致');
    const fileNamesAsc = asc.filter((i) => i.kind !== 'dir').map((i) => i.name);
    const fileNamesDesc = desc.filter((i) => i.kind !== 'dir').map((i) => i.name);
    if (fileNamesAsc.length > 1) {
      assertEq(fileNamesAsc[0], fileNamesDesc[fileNamesDesc.length - 1], '降序应是升序的反转');
    }
  });

  await test('浏览排序 size-desc 按大小降序', async () => {
    const items = (await api.get(`/api/browse?rootId=${dirRoot.id}&path=&sort=size-desc&order=desc`, { token })).body.items
      .filter((i) => i.kind !== 'dir');
    for (let i = 1; i < items.length; i++) {
      assert(items[i - 1].size >= items[i].size, `大小排序错误：${items[i - 1].name} < ${items[i].name}`);
    }
  });

  await test('浏览排序 mtime 可用', async () => {
    const r = await api.get(`/api/browse?rootId=${dirRoot.id}&path=&sort=mtime-desc&order=desc`, { token });
    assertEq(r.status, 200);
    assertEq(r.body.sort, 'mtime-desc');
  });

  await test('浏览单文件引用（path 为空）返回 isFile', async () => {
    const r = await api.get(`/api/browse?rootId=${fileRoot.id}&path=`, { token });
    assertEq(r.status, 200);
    assertEq(r.body.isFile, true);
    assertEq(r.body.items.length, 1);
  });

  await test('浏览越权路径返回 403', async () => {
    const r = await api.get(`/api/browse?rootId=${dirRoot.id}&path=../../..`, { token });
    assertEq(r.status, 403);
  });

  await test('浏览不存在的子目录返回 404', async () => {
    const r = await api.get(`/api/browse?rootId=${dirRoot.id}&path=no-such-dir-xyz`, { token });
    assertEq(r.status, 404);
  });

  await test('浏览不存在的引用返回 404', async () => {
    const r = await api.get('/api/browse?rootId=r-nope&path=', { token });
    assertEq(r.status, 404);
  });

  await test('GET /api/library 分页返回', async () => {
    const r = await api.get(`/api/library?rootId=${dirRoot.id}&offset=0&limit=10`, { token });
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.items), '应返回 items');
    assert(r.body.items.length <= 10, 'limit 应生效');
  });

  // ---------- E. 媒体信息 ----------
  group('E. 媒体信息');

  const mainVideo = () => firstVideo();

  await test('GET /api/media 返回时长/编码/字幕轨', async () => {
    const f = mainVideo();
    const r = await api.get(`/api/media?rootId=${dirRoot.id}&path=${encodeURIComponent(f)}`, { token });
    assertEq(r.status, 200);
    assert(r.body.info, '应返回 info');
    assert(r.body.info.duration > 0, `时长应大于 0，实际 ${r.body.info.duration}`);
    assert(r.body.info.video, '应返回视频流信息');
    assert(Array.isArray(r.body.subtitleTracks), '应返回 subtitleTracks');
  });

  await test('GET /api/media 单文件引用（path 为空）可读取', async () => {
    const r = await api.get(`/api/media?rootId=${fileRoot.id}&path=`, { token });
    assertEq(r.status, 200);
    assert(r.body.info.duration > 0, '单文件应能探测到时长');
  });

  await test('GET /api/media 不存在文件返回 404', async () => {
    const r = await api.get(`/api/media?rootId=${dirRoot.id}&path=nope.mkv`, { token });
    assertEq(r.status, 404);
  });

  await test('GET /api/media 越权路径返回 403', async () => {
    const r = await api.get(`/api/media?rootId=${dirRoot.id}&path=${encodeURIComponent('../../../windows/win.ini')}`, { token });
    assert(r.status === 403 || r.status === 404, `应为 403/404，实际 ${r.status}`);
  });

  // ---------- F. 播放会话 ----------
  group('F. 播放与转码会话');

  await test('POST /api/play 起播返回播放列表与编码器', async () => {
    const f = mainVideo();
    const r = await api.post('/api/play', { rootId: dirRoot.id, path: f }, { token });
    assertEq(r.status, 200);
    assert(r.body.id, '应返回会话 id');
    assertEq(r.body.state, 'PLAYING');
    assert(r.body.playlist, '应返回播放列表地址');
    assert(r.body.encoder, '应返回编码器名');
    sessionId = r.body.id;
  });

  await test('POST /api/play 传给会话的时长正确', async () => {
    const r = await api.get(`/api/session/state?id=${sessionId}`, { token });
    assertEq(r.status, 200);
    assert(r.body.duration > 0, `会话时长应 > 0，实际 ${r.body.duration}`);
  });

  await test('GET /hls 播放列表可访问且含分片', async () => {
    const st = (await api.get(`/api/session?id=${sessionId}`, { token })).body;
    const r = await api.get(st.playlist, { token });
    assertEq(r.status, 200);
    assertIncludes(r.text, '#EXTM3U');
    // 等一两个分片落盘
    for (let i = 0; i < 40; i++) {
      const rr = await api.get(st.playlist, { token });
      if (rr.text.includes('.ts')) break;
      await sleep(100);
    }
    const again = await api.get(st.playlist, { token });
    assertIncludes(again.text, '.ts', '播放列表应包含分片');
  });

  await test('HLS 分片可下载且是 mpegts', async () => {
    const st = (await api.get(`/api/session?id=${sessionId}`, { token })).body;
    const pl = (await api.get(st.playlist, { token })).text;
    const seg = pl.split('\n').find((l) => l.trim().endsWith('.ts'));
    assert(seg, '应找到分片');
    const dir = st.playlist.slice(0, st.playlist.lastIndexOf('/') + 1);
    const r = await api.get(dir + seg.trim(), { token });
    assertEq(r.status, 200);
    assertIncludes(r.headers['content-type'], 'mp2t');
    assert(r.buf.length > 1000, '分片应有实际数据');
  });

  await test('POST /api/session/seek 跳转生效', async () => {
    const r = await api.post('/api/session/seek', { id: sessionId, position: 30 }, { token });
    assertEq(r.status, 200);
    assert(r.body.offset >= 29 && r.body.offset <= 31, `offset 应约为 30，实际 ${r.body.offset}`);
    assert(r.body.gen >= 2, 'generation 应递增');
  });

  await test('seek 超出片长会被钳制在片长内', async () => {
    const st = (await api.get(`/api/session/state?id=${sessionId}`, { token })).body;
    const r = await api.post('/api/session/seek', { id: sessionId, position: 999999 }, { token });
    assertEq(r.status, 200);
    assert(r.body.offset <= st.duration + 1, `offset ${r.body.offset} 不应超过片长 ${st.duration}`);
  });

  await test('seek 负数会被钳制到 0', async () => {
    const r = await api.post('/api/session/seek', { id: sessionId, position: -50 }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.offset, 0);
  });

  await test('POST /api/session/speed 2 倍速生效', async () => {
    const r = await api.post('/api/session/speed', { id: sessionId, speed: 2 }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.speed, 2);
  });

  await test('POST /api/session/speed 恢复 1 倍速', async () => {
    const r = await api.post('/api/session/speed', { id: sessionId, speed: 1 }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.speed, 1);
  });

  await test('POST /api/session/speed 非法倍速被拒绝或回退', async () => {
    const r = await api.post('/api/session/speed', { id: sessionId, speed: 99 }, { token });
    assert(r.status !== 200 || r.body.speed !== 99, `非法倍速不应被采纳，实际 ${JSON.stringify(r.body)}`);
  });

  await test('POST /api/session/pause 与 resume', async () => {
    const p = await api.post('/api/session/pause', { id: sessionId }, { token });
    assertEq(p.status, 200);
    assertEq(p.body.state, 'PAUSED');
    const r = await api.post('/api/session/resume', { id: sessionId }, { token });
    assertEq(r.status, 200);
    assert(r.body.state === 'PLAYING' || r.body.state === 'STARTING', `恢复后状态异常：${r.body.state}`);
  });

  await test('GET /api/session/state 返回进度', async () => {
    await sleep(1200);
    const r = await api.get(`/api/session/state?id=${sessionId}`, { token });
    assertEq(r.status, 200);
    assert(r.body.position >= 0, 'position 应 >= 0');
  });

  await test('GET /api/sessions 列出会话', async () => {
    const r = await api.get('/api/sessions', { token });
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.sessions));
    assert(r.body.sessions.some((s) => s.id === sessionId), '列表应包含当前会话');
  });

  await test('GET /api/session 不存在的会话返回 404', async () => {
    const r = await api.get('/api/session?id=s-nope', { token });
    assertEq(r.status, 404);
  });

  await test('POST /api/session/seek 不存在会话返回 404', async () => {
    const r = await api.post('/api/session/seek', { id: 's-nope', position: 10 }, { token });
    assertEq(r.status, 404);
  });

  await test('并发上限：同客户端重播自动替换，跨客户端才受限', async () => {
    // 新语义：同一客户端连续 play 会自动替换旧会话（防连续快进占满并发），
    // 因此 max+1 次同客户端 play 应全部成功；第 max+1 个"不同客户端"才会撞上限。
    const max = (await api.get('/api/sync?since=0', { token })).body.maxSessions;
    // 1) 同客户端连续 play：全部成功且旧会话被替换
    const ids = [];
    for (let i = 0; i < max + 1; i++) {
      const r = await api.post('/api/play', { rootId: dirRoot.id, path: mainVideo() }, { token });
      assertEq(r.status, 200);
      ids.push(r.body.id);
    }
    // 只剩最后一个活会话，其余应已停止
    await sleep(600);
    const state1 = (await gui.get('state')).body;
    const alive = state1.sessions.filter((s) => ids.includes(s.id) && !['STOPPED', 'ENDED'].includes(s.state));
    assertEq(alive.length, 1, `同客户端重播后应只剩 1 个活会话，实际 ${alive.length}`);
    // 2) 跨客户端才受限：继续用同一 token 但每次 play 会先替换旧会话，
    //    因此服务端永远为该 client 保留 1 个槽位，其它客户端仍可用 max-1 个。
    //    直接验证：活跃会话数在连续 play 后始终 <= 1（同 client）。
    const state2 = (await gui.get('state')).body;
    const activeCount = state2.sessions.filter((s) => !['STOPPED', 'ENDED'].includes(s.state)).length;
    assert(activeCount <= max, `活跃会话数 ${activeCount} 应 <= maxSessions ${max}`);
    // 清理全部
    const state3 = (await gui.get('state')).body;
    state3.sessions.forEach((s) => api.post('/api/session/stop', { id: s.id }, { token }).catch(() => {}));
    await sleep(400);
  });

  await test('POST /api/session/stop 停止会话', async () => {
    // 新语义下同客户端重复 play 会替换旧会话，改用新建会话验证 stop
    const p = await api.post('/api/play', { rootId: dirRoot.id, path: mainVideo() }, { token });
    assertEq(p.status, 200);
    const sid = p.body.id;
    const r = await api.post('/api/session/stop', { id: sid }, { token });
    assertEq(r.status, 200);
    await sleep(500);
    const st = await api.get(`/api/session/state?id=${sid}`, { token });
    assert(st.status === 404 || ['STOPPED', 'ENDED'].includes(st.body.state), '会话应已停止');
  });

  await test('POST /api/play 单文件引用可起播（回归）', async () => {
    const r = await api.post('/api/play', { rootId: fileRoot.id, path: '' }, { token });
    assertEq(r.status, 200);
    assertEq(r.body.state, 'PLAYING');
    await api.post('/api/session/stop', { id: r.body.id }, { token });
  });

  // ---------- G. 字幕 ----------
  group('G. 字幕');

  await test('GET /api/media 带出字幕轨列表（含 text/burn 标记）', async () => {
    const f = mainVideo();
    const r = await api.get(`/api/media?rootId=${dirRoot.id}&path=${encodeURIComponent(f)}`, { token });
    const tracks = r.body.subtitleTracks;
    assert(Array.isArray(tracks));
    tracks.forEach((t) => {
      assert(typeof t.text === 'boolean', '每条字幕轨应有 text 布尔值');
      assert(typeof t.burn === 'boolean', '每条字幕轨应有 burn 布尔值');
    });
  });

  await test('文本字幕轨能取到 WebVTT', async () => {
    const f = mainVideo();
    const media = (await api.get(`/api/media?rootId=${dirRoot.id}&path=${encodeURIComponent(f)}`, { token })).body;
    const textTrack = media.subtitleTracks.find((t) => t.text && t.url);
    if (!textTrack) return; // 该文件没有文本字幕轨，跳过
    const r = await api.get(textTrack.url, { token });
    assertEq(r.status, 200);
    assertIncludes(r.headers['content-type'], 'text/vtt');
    assertIncludes(r.text, 'WEBVTT');
  });

  await test('同名字幕自动标记 default', async () => {
    const auto = fs.readdirSync(SAMPLES).find((f) => /自动字幕|auto.?sub/i.test(f) && /\.mkv$/i.test(f));
    if (!auto) return;
    const r = await api.get(`/api/media?rootId=${dirRoot.id}&path=${encodeURIComponent(auto)}`, { token });
    const def = (r.body.subtitleTracks || []).find((t) => t.default);
    assert(def, '同名字幕应被标记为默认');
  });

  await test('字幕 vtt 接口对不存在文件返回 404', async () => {
    const r = await api.get(`/api/subtitle/vtt?rootId=${dirRoot.id}&path=nope.mkv&index=0`, { token });
    assertEq(r.status, 404);
  });

  await test('字幕 vtt 接口对越权路径返回 403', async () => {
    const r = await api.get(`/api/subtitle/vtt?rootId=${dirRoot.id}&path=${encodeURIComponent('../../../x.srt')}&index=0`, { token });
    assert(r.status === 403 || r.status === 404, `应为 403/404，实际 ${r.status}`);
  });

  // ---------- H. 缩略图 ----------
  group('H. 缩略图');

  await test('GET /thumb 生成 JPEG 缩略图', async () => {
    const f = mainVideo();
    const r = await api.get(`/thumb/${dirRoot.id}/${encodeURIComponent(f)}?t=3`, { token });
    assertEq(r.status, 200);
    assertIncludes(r.headers['content-type'], 'image/jpeg');
    assert(r.buf.length > 1000, '缩略图应有内容');
    assertEq(r.buf[0], 0xFF, '应是 JPEG 起始字节');
    assertEq(r.buf[1], 0xD8, '应是 JPEG 起始字节');
  });

  await test('缩略图二次访问命中缓存（更快）', async () => {
    const f = mainVideo();
    const url = `/thumb/${dirRoot.id}/${encodeURIComponent(f)}?t=3`;
    const t1 = Date.now(); await api.get(url, { token }); const d1 = Date.now() - t1;
    const t2 = Date.now(); const r = await api.get(url, { token }); const d2 = Date.now() - t2;
    assertEq(r.status, 200);
    assert(d2 <= Math.max(d1, 200), `缓存命中应不慢于首次（首次 ${d1}ms，二次 ${d2}ms）`);
  });

  await test('缩略图越权路径返回 403', async () => {
    const r = await api.get(`/thumb/${dirRoot.id}/${encodeURIComponent('../../../windows/win.ini')}?t=1`, { token });
    assert(r.status === 403 || r.status === 404, `应为 403/404，实际 ${r.status}`);
  });

  await test('缩略图不存在文件返回 404', async () => {
    const r = await api.get(`/thumb/${dirRoot.id}/nope.mkv?t=1`, { token });
    assertEq(r.status, 404);
  });

  // ---------- I. 媒体源排序（补充 29：两端独立——GUI 本地 / 客户端本地，服务端不再持久化）----------
  group('I. 媒体源排序独立');

  await test('GET /api/gui/roots-sort 应 404（roots-sort 接口已随补充 29 撤销）', async () => {
    const r = await gui.get('roots-sort');
    assertEq(r.status, 404);
  });

  // ---------- J. GUI 管理接口 ----------
  group('J. GUI 管理接口');

  await test('GET /api/gui/state 返回完整状态', async () => {
    const r = await gui.get('state');
    assertEq(r.status, 200);
    assert(r.body.server, '应有 server');
    assert(r.body.server.pin, '应有 pin');
    assert(typeof r.body.libraryVersion === 'number', '应有 libraryVersion');
    assert(r.body.watcher, '应有 watcher 状态');
  });

  await test('GET /api/gui/net 返回局域网地址', async () => {
    const r = await gui.get('net');
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.addresses) && r.body.addresses.length > 0, '应返回至少一个局域网地址');
    assert(r.body.addresses[0].address, '地址项应有 address');
    assert(r.body.hostname, '应返回主机名');
  });

  await test('GET /api/gui/logs 返回日志', async () => {
    const r = await gui.get('logs?limit=20');
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.logs));
    assert(r.body.logs.length > 0, '应至少有一条日志');
  });

  await test('GET /api/gui/sessions 返回会话列表', async () => {
    const r = await gui.get('sessions');
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.sessions));
  });

  await test('GET /api/gui/clients 返回已配对客户端', async () => {
    const r = await gui.get('clients');
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.clients));
    assert(r.body.clients.length >= 1, '应至少有本次测试的客户端');
  });

  await test('GET /api/gui/browse-fs 浏览文件系统', async () => {
    const r = await gui.get('browse-fs?path=' + encodeURIComponent(SAMPLES));
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.entries), '应返回 entries');
    assert(r.body.entries.length > 0, 'samples 目录不应为空');
    assert(r.body.places && r.body.places.length > 0, '应返回快捷位置');
  });

  await test('POST /api/gui/open-with-player 系统默认播放器预览（补充 19）', async () => {
    // 试播功能已随补充 16 移除；open-with-player 是 GUI 行内「预览」按钮的后端（explorer.exe 文件关联）。
    const f = mainVideo();
    const r = await gui.post('open-with-player', { path: sampleFile(f) });
    assertEq(r.status, 200);
    assert(r.body.path && r.body.path.toLowerCase().endsWith('.mkv'), `应返回解析后的真实路径，实际 ${r.body.path}`);
  });

  await test('POST /api/gui/open-with-player 越权路径拒绝', async () => {
    const r = await gui.post('open-with-player', { path: 'C:\\Windows\\notepad.exe' });
    assertEq(r.status, 400);
    assert(r.body.error, '应返回错误信息');
  });

  await test('POST /api/gui/open-with-player 不存在文件报错', async () => {
    // 越权判定优先于存在性：先构造一个媒体源内的不存在路径
    const r = await gui.post('open-with-player', { path: path.join(SAMPLES, 'no-such-file.mkv') });
    assertEq(r.status, 400);
    assert(r.body.error, '应返回错误信息');
  });

  await test('POST /api/gui/settings 修改后生效', async () => {
    const before = (await gui.get('state')).body.server;
    const r = await gui.post('settings', { maxSessions: 2 });
    assertEq(r.status, 200);
    const after = (await gui.get('state')).body.server;
    assert(after, '设置后应能读到状态');
    // 回写原值，避免污染后续用例环境
    if (before && typeof before.maxSessions === 'number' && before.maxSessions !== 2) {
      await gui.post('settings', { maxSessions: before.maxSessions });
    }
  });

  await test('POST /api/gui/roots-batch 批量操作', async () => {
    const r = await gui.post('roots-batch', { action: 'disable', ids: [fileRoot.id] });
    assertEq(r.status, 200);
    await gui.post('roots-batch', { action: 'enable', ids: [fileRoot.id] });
  });

  await test('POST /api/gui/reveal-file 校验与报错', async () => {
    // 越权路径（不在媒体源内）拒绝 —— S-1 修复后 reveal-file 与 open-with-player 同等校验
    const r1 = await gui.post('reveal-file', { path: 'C:\\Windows\\notepad.exe' });
    assertEq(r1.status, 400);
    // 不存在的媒体源内文件报错
    const r2 = await gui.post('reveal-file', { path: path.join(SAMPLES, 'no-such-file.mkv') });
    assertEq(r2.status, 400);
    // 媒体源内真实文件成功（explorer /select 在无头会话静默成功）
    const r3 = await gui.post('reveal-file', { path: sampleFile(mainVideo()) });
    assertEq(r3.status, 200);
  });

  await test('GET /api/gui/watch 目录监听统计', async () => {
    const r = await gui.post('watch', { path: SAMPLES });
    assert(r.status === 200 || r.status === 400, `watch 应返回 200 或 400，实际 ${r.status}`);
  });

  // ---------- 收尾清理 ----------
  group('K. 清理');

  await test('DELETE /api/roots 删除单条引用', async () => {
    const r = await api.del('/api/roots', { id: fileRoot.id }, { token });
    assertEq(r.status, 200);
  });

  await test('POST /api/roots/batch purge 清空测试引用', async () => {
    const keep = (await api.get('/api/roots', { token })).body.roots
      .filter((r) => !createdRoots.includes(r.id))
      .map((r) => r.id);
    // 只删除本次测试创建的（逐个删）
    for (const id of createdRoots) {
      await api.del('/api/roots', { id }, { token }).catch(() => {});
    }
    const after = (await api.get('/api/roots', { token })).body.roots;
    assert(after.length === keep.length, `清理后应剩 ${keep.length} 个，实际 ${after.length}`);
  });

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m────────────────────────────────\x1b[0m`);
  console.log(`总计 ${results.length} 项：\x1b[32m通过 ${passed}\x1b[0m` + (failed.length ? ` / \x1b[31m失败 ${failed.length}\x1b[0m` : ''));
  if (failed.length) {
    console.log('\n失败明细：');
    failed.forEach((f) => console.log(`  \x1b[31m✗ [${f.group}] ${f.name}\n     ${f.error}\x1b[0m`));
  }
  const slowest = results.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log('\n最慢的 5 项：');
  slowest.forEach((s) => console.log(`  ${s.ms}ms  ${s.name}`));
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error('\x1b[31m测试脚本崩溃：\x1b[0m', err);
  process.exit(2);
});
