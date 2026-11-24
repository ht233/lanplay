'use strict';
/**
 * 真实性能测试：F 盘大文件（4K / 1080p 长片）
 * 指标：起播延迟、seek 延迟、分片产出速率、ffmpeg CPU 占用
 *
 * 用法：先在服务端添加待测文件为「单文件」媒体源，然后把 rootId 写进 CASES，
 * 或用 `LANPLAY_PERF_ROOTS=<id1>,<id2>` 环境变量覆盖。
 */
const http = require('http');
const { execSync } = require('child_process');

function req(p, method, body, token) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const h = { 'Content-Type': 'application/json' };
    if (d) h['Content-Length'] = Buffer.byteLength(d);
    if (token) h['X-LanPlay-Token'] = token;
    const q = http.request({ host: '127.0.0.1', port: 8099, path: p, method, headers: h, timeout: 60000 }, (r) => {
      let s = '';
      r.on('data', (c) => s += c);
      r.on('end', () => { try { res({ status: r.statusCode, body: JSON.parse(s) }); } catch (_) { res({ status: r.statusCode, body: s }); } });
    });
    q.on('error', rej);
    q.on('timeout', () => q.destroy(new Error('timeout')));
    if (d) q.write(d);
    q.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ffmpegCpu() {
  try {
    const out = execSync('wmic process where "name=\'ffmpeg.exe\'" get ProcessId,KernelModeTime,UserModeTime /format:csv', { encoding: 'utf8', timeout: 10000 });
    const lines = out.split('\n').filter((l) => l.includes('ffmpeg.exe'));
    return lines.map((l) => {
      const parts = l.trim().split(',');
      const user = Number(parts[parts.length - 2]) / 1e7;
      const kernel = Number(parts[parts.length - 3] || 0) / 1e7;
      return { pid: parts[parts.length - 1], cpuSec: (user + kernel).toFixed(1) };
    });
  } catch (_) { return []; }
}

async function firstSegmentTime(playlistUrl, token, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pl = await req(playlistUrl, 'GET', null, token);
    if (pl.body && String(pl.body).includes('.ts')) return Date.now() - started;
    await sleep(100);
  }
  return -1;
}

(async () => {
  const st = await req('/api/gui/state', 'GET');
  const pair = await req('/api/pair', 'POST', { pin: st.body.server.pin, name: 'perf' });
  const tok = pair.body.token;

  // 性能用例默认无 rootId —— 通过 LANPLAY_PERF_ROOTS=<id1>,<id2> 传入要压测的媒体源 id，
  // 或不带环境变量时自动取服务端第一个启用的媒体源。
  let cases = (process.env.LANPLAY_PERF_ROOTS || '')
    .split(',').map((id) => id.trim()).filter(Boolean)
    .map((id) => ({ name: `媒体源 ${id}`, rootId: id }));
  if (!cases.length) {
    const first = (st.body.roots || []).find((r) => r.enabled);
    if (first) cases = [{ name: `媒体源 ${first.id}`, rootId: first.id }];
  }

  for (const c of cases) {
    console.log(`\n══════ ${c.name} ══════`);
    // 起播
    let t0 = Date.now();
    const play = await req('/api/play', 'POST', { rootId: c.rootId, path: '' }, tok);
    const playMs = Date.now() - t0;
    if (play.status !== 200) { console.log(`  起播失败: ${JSON.stringify(play.body)}`); continue; }
    console.log(`  起播 API 响应: ${playMs}ms  encoder=${play.body.encoder}`);
    // 首个分片
    const segMs = await firstSegmentTime(play.body.playlist, tok);
    console.log(`  首分片就绪: ${segMs}ms`);
    // 等 5 秒看产出速率
    await sleep(5000);
    const pl = await req(play.body.playlist, 'GET', null, tok);
    const segCount = (String(pl.body).match(/\.ts/g) || []).length;
    console.log(`  5 秒产出分片: ${segCount} 个（约 ${(segCount / 5).toFixed(1)} 个/秒，即 ${(segCount / 5).toFixed(1)}x 实时）`);
    // seek 性能（30s / 600s / 1800s）
    const dur = play.body.duration;
    for (const frac of [0.05, 0.3, 0.7]) {
      const pos = Math.round(dur * frac);
      t0 = Date.now();
      const sk = await req('/api/session/seek', 'POST', { id: play.body.id, position: pos }, tok);
      const seekMs = Date.now() - t0;
      const seg2 = await firstSegmentTime(sk.body.playlist, tok, 20000);
      console.log(`  seek→${pos}s: API ${seekMs}ms + 首分片 ${seg2}ms = ${seekMs + seg2}ms`);
    }
    // CPU
    await sleep(1000);
    const procs = ffmpegCpu();
    console.log(`  ffmpeg 进程数: ${procs.length}${procs.length ? '  累计CPU: ' + procs.map((p) => `${p.pid}=${p.cpuSec}s`).join(', ') : ''}`);
    await req('/api/session/stop', 'POST', { id: play.body.id }, tok);
    await sleep(800);
  }
  console.log('\n══════ 并发快进压力（第一个用例，连续 10 次 seek）══════');
  const stressRoot = cases[0] && cases[0].rootId;
  const play = await req('/api/play', 'POST', { rootId: stressRoot, path: '' }, tok);
  if (play.status === 200) {
    const dur = play.body.duration;
    let totalApi = 0;
    for (let i = 1; i <= 10; i++) {
      const t0 = Date.now();
      const sk = await req('/api/session/seek', 'POST', { id: play.body.id, position: Math.round(dur * i / 12) }, tok);
      totalApi += Date.now() - t0;
      if (sk.status !== 200) { console.log(`  第 ${i} 次 seek 失败: ${JSON.stringify(sk.body)}`); break; }
    }
    console.log(`  连续 10 次 seek 平均 API 耗时: ${(totalApi / 10).toFixed(0)}ms`);
    await sleep(1500);
    const st2 = await req(`/api/session/state?id=${play.body.id}`, tok);
    console.log(`  会话状态: ${st2.body ? st2.body.state : '已清理'}`);
    const procs = ffmpegCpu();
    console.log(`  ffmpeg 残留进程: ${procs.length} 个`);
    await req('/api/session/stop', 'POST', { id: play.body.id }, tok);
  } else {
    console.log(`  起播失败: ${JSON.stringify(play.body)}`);
  }
})().catch((e) => { console.error('异常:', e.message); process.exit(2); });
