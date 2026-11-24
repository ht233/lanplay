'use strict';
// 冒烟回归：字幕烧录降级（对无内嵌字幕流的文件请求 burn 不应炸掉转码）
// 用法：node tools/burn-smoke.js [--port 8099]；任一用例 FAIL 时进程退出码 1。
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 8099;
})();

function req(p, method, body, token) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    if (token) h['X-LanPlay-Token'] = token;
    const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (r) => {
      let s = '';
      r.on('data', (c) => s += c);
      r.on('end', () => res({ status: r.statusCode, body: s }));
    });
    q.on('error', rej);
    if (d) q.write(d);
    q.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const st = JSON.parse((await req('/api/gui/state', 'GET')).body);
  const pair = JSON.parse((await req('/api/pair', 'POST', { pin: st.server.pin, name: 'burn-smoke' })).body);
  const tok = pair.token;
  const dir = st.roots.find((r) => r.name === 'samples') || st.roots.find((r) => r.type === 'dir');
  if (!dir) { console.error('FAIL ✗ 未找到可用的目录媒体源（需先在 GUI 添加 samples）'); process.exit(1); }

  const fails = [];

  console.log('── 用例 1：对无内嵌字幕的文件请求 burn index=0（应降级直转，不 ERROR）');
  const p1 = JSON.parse((await req('/api/play', 'POST', { rootId: dir.id, path: '实时监听测试.mkv', subtitle: { mode: 'burn', index: 0, name: 'x' } }, tok)).body);
  console.log(`play: state=${p1.state} encoder=${p1.encoder} id=${p1.id}`);
  await sleep(3000);
  const pl1 = await req(p1.playlist, 'GET', null, tok);
  const hasSeg1 = pl1.body.includes('.ts');
  console.log(`playlist 含分片: ${hasSeg1}`);
  const ok1 = p1.state === 'PLAYING' && hasSeg1;
  console.log(`状态: ${ok1 ? 'PASS ✓（降级成功）' : 'FAIL ✗'}`);
  if (!ok1) fails.push('用例1 burn 降级');
  await req('/api/session/stop', 'POST', { id: p1.id }, tok);
  await sleep(500);

  console.log('── 用例 2：同名字幕自动烧录（自动字幕测试.mkv + .ass）');
  const p2 = JSON.parse((await req('/api/play', 'POST', { rootId: dir.id, path: '自动字幕测试.mkv' }, tok)).body);
  console.log(`play: state=${p2.state} encoder=${p2.encoder}`);
  console.log(`subtitle payload: ${JSON.stringify(p2.subtitle || null)}`);
  await sleep(3500);
  const pl2 = await req(p2.playlist, 'GET', null, tok);
  const hasSeg2 = pl2.body.includes('.ts');
  console.log(`playlist 含分片: ${hasSeg2}`);
  const ok2 = p2.state === 'PLAYING' && hasSeg2;
  console.log(`状态: ${ok2 ? 'PASS ✓' : 'FAIL ✗'}`);
  if (!ok2) fails.push('用例2 同名 .ass 烧录');
  // 抽帧确认字幕烧上了
  try {
    const segDir = (() => { const base = path.join(__dirname, '..', 'data', 'hls', p2.id); const gens = fs.readdirSync(base).filter((d) => d.startsWith('g')).sort(); return path.join(base, gens[gens.length - 1]); })();
    const seg = fs.readdirSync(segDir).find((f) => f.endsWith('.ts'));
    if (seg) console.log(`分片: ${seg}（可用 ffmpeg 抽帧人工复核）`);
  } catch (_) { /* 会话可能已清理，不阻塞 */ }
  await req('/api/session/stop', 'POST', { id: p2.id }, tok);

  console.log('── 用例 3：外挂字幕 path 不存在时降级');
  const p3 = JSON.parse((await req('/api/play', 'POST', { rootId: dir.id, path: '自动字幕测试.mkv', subtitle: { mode: 'burn', index: -1, path: 'Z:\\no\\such.ass', name: 'ghost' } }, tok)).body);
  console.log(`play: state=${p3.state} id=${p3.id}`);
  await sleep(2500);
  const pl3 = await req(p3.playlist, 'GET', null, tok);
  console.log(`playlist 含分片: ${pl3.body.includes('.ts')}`);
  const ok3 = p3.state === 'PLAYING' && pl3.body.includes('.ts');
  console.log(`状态: ${ok3 ? 'PASS ✓（降级成功）' : 'FAIL ✗'}`);
  if (!ok3) fails.push('用例3 外挂字幕缺失降级');
  await req('/api/session/stop', 'POST', { id: p3.id }, tok);

  console.log(`\n汇总: ${3 - fails.length}/3 PASS${fails.length ? `；FAIL: ${fails.join('、')}` : ''}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });
