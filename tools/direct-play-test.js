'use strict';
// 直通判定单测：不依赖 ffmpeg，直接实例化 Session 基类逻辑过重，
// 这里用最小桩验证 pickDirectPlay 的三重约束。
const path = require('path');
const { TranscodeSession } = require('../server/core/transcode');

function makeSession(mediaInfo, settings, extra) {
  const manager = {
    hlsDir: path.join(__dirname, '..', 'data', 'hls'),
    logger: { info() {}, warn() {}, error() {}, success() {} },
    defaults: () => settings
  };
  const s = new TranscodeSession(manager, {
    id: 'probe-direct',
    file: 'F:\\fake\\movie.mp4',
    mediaInfo,
    settings,
    client: { id: 'probe', name: 'probe' }
  });
  Object.assign(s, extra || {});
  return s;
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const baseVideo = { index: 0, codec: 'h264', width: 1920, height: 1080, bitrate: 4 * 1000 * 1000 };
const baseInfo = { duration: 100, bitrate: 5 * 1000 * 1000, video: baseVideo, audio: [{ index: 1, codec: 'aac', channels: 2 }] };

console.log('== pickDirectPlay 三重约束 ==');
check('h264/1080p/4Mbps → 直通', makeSession(baseInfo, {}).pickDirectPlay() === true);
check('hevc/1080p/4Mbps → 直通', makeSession({ ...baseInfo, video: { ...baseVideo, codec: 'hevc' } }, {}).pickDirectPlay() === true);
check('av1/1080p/4Mbps → 不直通（格式）', makeSession({ ...baseInfo, video: { ...baseVideo, codec: 'av1' } }, {}).pickDirectPlay() === false);
check('mpeg2video → 不直通（格式）', makeSession({ ...baseInfo, video: { ...baseVideo, codec: 'mpeg2video' } }, {}).pickDirectPlay() === false);
check('h264/4K(2160p) → 不直通（分辨率）', makeSession({ ...baseInfo, video: { ...baseVideo, height: 2160, width: 3840, bitrate: 4e6 } }, {}).pickDirectPlay() === false);
check('h264/1080p/40Mbps → 不直通（码率）', makeSession({ ...baseInfo, video: { ...baseVideo, bitrate: 40 * 1000 * 1000 } }, {}).pickDirectPlay() === false);
check('码率未知(0) → 直通（宽容）', makeSession({ ...baseInfo, video: { ...baseVideo, bitrate: 0 } }, {}).pickDirectPlay() === true);
check('容器码率兜底 40Mbps → 不直通', makeSession({ ...baseInfo, video: { ...baseVideo, bitrate: 0 }, bitrate: 40e6 }, {}).pickDirectPlay() === false);

console.log('== 显式输出参数/倍速/烧录 ==');
check('fps=30 → 不直通', makeSession(baseInfo, { fps: '30' }).pickDirectPlay() === false);
check('resolution=720 → 不直通', makeSession(baseInfo, { resolution: '720' }).pickDirectPlay() === false);
check('directPlay=off → 不直通', makeSession(baseInfo, { directPlay: 'off' }).pickDirectPlay() === false);
check('speed=2 → 不直通', makeSession(baseInfo, {}, { speed: 2 }).pickDirectPlay() === false);
check('字幕烧录 → 不直通', makeSession(baseInfo, {}, { subtitle: { mode: 'burn', index: 0 } }).pickDirectPlay() === false);
check('外挂字幕 side 模式 → 直通', makeSession(baseInfo, {}, { subtitle: { mode: 'side', index: -1 } }).pickDirectPlay() === true);

console.log('== buildArgs 直通参数 ==');
{
  const s = makeSession(baseInfo, {});
  s.directPlay = s.pickDirectPlay();
  const args = s.buildArgs(path.join(__dirname, '..', 'data', 'hls', 'probe-direct', 'g1'));
  const i = args.indexOf('-c:v');
  check('-c:v copy 存在', i >= 0 && args[i + 1] === 'copy');
  check('无 -force_key_frames', !args.includes('-force_key_frames'));
  check('无 -preset', !args.includes('-preset'));
  check('无 -vf', !args.includes('-vf'));
  check('encoderUsed=copy', s.encoderUsed === 'copy');
  check('publicState.directPlay=true', s.publicState().directPlay === true);
}
{
  // 超码率 4K 源：直通关闭 → 走 pickEncoder
  const s4k = makeSession({ ...baseInfo, video: { ...baseVideo, height: 2160, width: 3840, bitrate: 40e6 } }, {});
  s4k.directPlay = s4k.pickDirectPlay();
  check('4K 高码率 → 不直通', s4k.directPlay === false);
  const args2 = s4k.buildArgs(path.join(__dirname, '..', 'data', 'hls', 'probe-direct', 'g1'));
  const i2 = args2.indexOf('-c:v');
  check('4K 走转码（-c:v 非 copy）', i2 >= 0 && args2[i2 + 1] !== 'copy');
  check('4K 转码有 -force_key_frames', args2.includes('-force_key_frames'));
}

console.log(`\n总计 ${pass + fail}：通过 ${pass}${fail ? `，失败 ${fail}` : ''}`);
process.exit(fail ? 1 : 0);
