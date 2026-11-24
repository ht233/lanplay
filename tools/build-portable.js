/**
 * LanPlay 绿色版打包脚本（无需 electron-builder / npm）
 *
 * 产物：dist\LanPlay-win64\
 *   LanPlay.exe                Electron 主程序（已改名）
 *   resources\app\             应用代码（server/ + gui/ + package.json）
 *   bin\ffmpeg.exe/ffprobe.exe 内置转码器（若存在）
 *   data\                      运行后自动生成（配置、日志、HLS 缓存）
 *   LanPlay.exe 直接双击即可运行，无需安装。
 *
 * 用法： node tools/build-portable.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const outDir = path.join(distRoot, 'LanPlay-win64');
const electronDir = process.env.LANPLAY_ELECTRON_DIR
  ? path.resolve(process.env.LANPLAY_ELECTRON_DIR)
  : path.resolve(projectRoot, '..', '_toolchain', 'electron');

function log(msg) { process.stdout.write(`[build] ${msg}\n`); }

function copyDir(src, dst, { skip = [] } = {}) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, { skip });
    else fs.copyFileSync(s, d);
  }
}

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function main() {
  if (!fs.existsSync(path.join(electronDir, 'electron.exe'))) {
    console.error(`找不到 Electron：${electronDir}`);
    console.error('请设置环境变量 LANPLAY_ELECTRON_DIR 指向已解压的 electron 目录');
    process.exit(1);
  }

  log('清理输出目录…');
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  log('复制 Electron 运行时…');
  for (const entry of fs.readdirSync(electronDir, { withFileTypes: true })) {
    if (entry.name === 'resources') continue;
    const s = path.join(electronDir, entry.name);
    const d = path.join(outDir, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  fs.mkdirSync(path.join(outDir, 'resources'), { recursive: true });

  log('复制应用代码…');
  const appDir = path.join(outDir, 'resources', 'app');
  copyDir(path.join(projectRoot, 'server'), path.join(appDir, 'server'));
  copyDir(path.join(projectRoot, 'gui'), path.join(appDir, 'gui'));
  fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(appDir, 'package.json'));

  log('复制 ffmpeg…');
  const binDir = path.join(outDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  let missingFfmpeg = false;
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    const src = path.join(projectRoot, 'bin', exe);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(binDir, exe));
    else { missingFfmpeg = true; log(`警告：未找到 ${src}`); }
  }
  // ffmpeg 是转码核心，缺失的包无法工作 —— 硬失败防止打出坏包（build-portable 整目录拷贝不带校验）。
  if (missingFfmpeg) {
    console.error('错误：bin\\ffmpeg.exe / ffprobe.exe 缺失，拒绝打包。请先放置解码器后重试。');
    process.exit(1);
  }

  log('复制 start.bat…');
  const startBat = path.join(projectRoot, 'tools', 'start.bat');
  if (fs.existsSync(startBat)) fs.copyFileSync(startBat, path.join(outDir, 'start.bat'));
  else log('警告：未找到 tools\\start.bat（可选启动脚本）');

  log('重命名主程序…');
  fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'LanPlay.exe'));

  // 绿色版说明
  fs.writeFileSync(path.join(outDir, '运行说明.txt'), [
    'LanPlay 服务端（绿色版）',
    '',
    '1. 双击 LanPlay.exe 启动，无需安装。',
    '2. 首次启动会在本目录生成 data\\ 文件夹（配置、日志、转码缓存）。',
    '3. 服务端端口默认 8099，被占用时自动顺延并在界面上显示。',
    '4. 投影仪安装 LanPlay 客户端 APK 后，输入界面右上角配对码即可连接。',
    '5. 移动整个文件夹即可迁移到其他电脑，配置随行。',
    '',
    '卸载：直接删除整个文件夹。'
  ].join('\r\n'), 'utf8');

  const mb = (dirSize(outDir) / 1024 / 1024).toFixed(1);
  log(`完成：${outDir}（${mb} MB）`);
}

main();
