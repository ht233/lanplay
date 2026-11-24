'use strict';

const fs = require('fs');
const path = require('path');
const { uid, readJson, writeJson, ensureDir, nowIso } = require('./util');

const DEFAULTS = {
  version: 1,
  serverName: 'LanPlay 服务端',
  port: 8099,
  autoPort: true,
  bindHost: '0.0.0.0',
  discovery: true,
  discoveryPort: 52310,
  requirePin: true,
  pin: '',
  maxSessions: 2,
  hardwareAccel: true,
  transcode: {
    resolution: 'auto',
    bitrate: 4000,
    fps: 'auto',
    codec: 'h264',
    quality: 'balanced',
    audioBitrate: 128,
    hlsTime: 1,
    directPlay: 'auto'
  },
  roots: [],
  recentPlayed: []
};

class Config {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    this.file = path.join(this.dataDir, 'config.json');
    ensureDir(this.dataDir);
    ensureDir(path.join(this.dataDir, 'logs'));
    ensureDir(path.join(this.dataDir, 'cache'));
    ensureDir(path.join(this.dataDir, 'hls'));
    this.data = {};
    this.load();
  }

  load() {
    const saved = readJson(this.file, null);
    const data = Object.assign({}, DEFAULTS, saved || {});
    data.transcode = Object.assign({}, DEFAULTS.transcode, (saved && saved.transcode) || {});
    data.roots = Array.isArray(data.roots) ? data.roots : [];
    data.recentPlayed = Array.isArray(data.recentPlayed) ? data.recentPlayed : [];
    if (!data.serverId) data.serverId = `s-${uid('', 12)}`;
    if (!data.pin) data.pin = String(Math.floor(100000 + Math.random() * 900000));
    if (!data.instanceId) data.instanceId = uid('lp', 10);
    this.data = data;
    this.save();
    return data;
  }

  save() {
    try {
      writeJson(this.file, this.data);
    } catch (err) {
      // 配置写入失败不应导致服务崩溃
      // eslint-disable-next-line no-console
      console.error('[config] save failed:', err.message);
    }
  }

  get(key) { return this.data[key]; }

  set(key, value) { this.data[key] = value; this.save(); }

  patch(obj) {
    Object.assign(this.data, obj);
    this.save();
    return this.data;
  }

  regeneratePin() {
    this.data.pin = String(Math.floor(100000 + Math.random() * 900000));
    this.save();
    return this.data.pin;
  }

  addRecent(filePath) {
    const list = this.data.recentPlayed.filter((x) => x.path !== filePath);
    list.unshift({ path: filePath, name: path.basename(filePath), at: nowIso() });
    this.data.recentPlayed = list.slice(0, 20);
    this.save();
  }

  /** 可移植配置：优先环境变量，其次可执行文件所在目录 */
  static resolveRootDir({ isPackaged, execPath, appRoot }) {
    if (process.env.LANPLAY_ROOT) return path.resolve(process.env.LANPLAY_ROOT);
    if (process.env.PORTABLE_EXECUTABLE_DIR) return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
    if (isPackaged && execPath) return path.dirname(execPath);
    return path.resolve(appRoot);
  }
}

module.exports = { Config, DEFAULTS };
