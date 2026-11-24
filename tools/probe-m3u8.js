'use strict';
/* 探针：模拟 nvenc 冷启动（首片产出慢、m3u8 被反复重写），
 * 验证 ffmpeg EVENT 播放列表是否会被读到「引用了尚未落盘分片 / 半截」的状态。
 * 只读临时目录，不依赖运行中的 server。 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const ffmpeg = path.join(root, 'bin', 'ffmpeg.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-m3u8-probe-'));
const pl = path.join(dir, 'index.m3u8');

// -readrate 0.25 = 4 倍慢速产出，模拟硬件编码器冷启动的不规则节奏
const args = [
  '-hide_banner', '-loglevel', 'error',
  '-readrate', '0.25',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '10',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '64k',
  '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'event',
  '-hls_flags', 'independent_segments+temp_file',
  '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
  pl
];

function classify() {
  if (!fs.existsSync(pl)) return { kind: 'missing' };
  let txt;
  try { txt = fs.readFileSync(pl, 'utf8'); } catch (_) { return { kind: 'read-error' }; }
  const names = [...txt.matchAll(/#EXTINF[^\n]*,\s*\n([^\n#]+)/g)].map((m) => m[1].trim()).filter(Boolean);
  const lastExtinf = txt.lastIndexOf('#EXTINF');
  const afterLast = lastExtinf >= 0 ? txt.slice(lastExtinf).replace(/#EXTINF[^\n]*,/, '').trim() : '';
  const truncated = !txt.endsWith('\n') || (lastExtinf >= 0 && afterLast === '' && names.length > 0);
  const missing = names.filter((n) => {
    const f = path.join(dir, n);
    try { return !fs.existsSync(f) || fs.statSync(f).size === 0; } catch (_) { return true; }
  });
  if (truncated) return { kind: 'TRUNCATED', names: names.length, tail: JSON.stringify(txt.slice(-70)) };
  if (missing.length) return { kind: 'MISSING-SEGMENT', names: names.length, missing };
  return { kind: 'ok', names: names.length };
}

const stats = {};
let samples = 0;
const proc = spawn(ffmpeg, args, { windowsHide: true });
proc.on('error', (e) => console.log('ffmpeg spawn error:', e.message));
let stderr = '';
proc.stderr.on('data', (b) => { stderr += b.toString(); });

const timer = setInterval(() => {
  const r = classify();
  samples++;
  stats[r.kind] = (stats[r.kind] || 0) + 1;
  if ((r.kind === 'TRUNCATED' || r.kind === 'MISSING-SEGMENT')) {
    const key = '_shown_' + r.kind;
    if ((stats[key] = (stats[key] || 0) + 1) <= 4) {
      console.log(`[sample ${samples}] ${r.kind}`, JSON.stringify(r));
    }
  }
}, 4);

proc.on('close', (code) => {
  setTimeout(() => {
    clearInterval(timer);
    console.log('---- RESULT ----');
    console.log('ffmpeg exit =', code);
    if (stderr) console.log('stderr =', stderr.slice(-800));
    try { console.log('dir files =', fs.readdirSync(dir).slice(0, 12).join(', ')); } catch (_) {}
    console.log('samples =', samples);
    console.log('stats   =', JSON.stringify(stats));
    const bad = (stats.TRUNCATED || 0) + (stats['MISSING-SEGMENT'] || 0);
    console.log('BAD (truncated / missing-segment) =', bad);
    console.log(bad > 0
      ? 'VERDICT: 播放列表重写/分片落盘期间确实存在不自洽窗口 → serveHls 必须做自洽快照 + 分片待就绪'
      : 'VERDICT: 未捕获不自洽（ffmpeg temp_file 保证先落盘再写表），竞态在别的环节');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }, 200);
});
