'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { nowIso, localTimestamp, ensureDir } = require('./util');

/**
 * 运行日志：内存环形缓冲（GUI 实时推送）+ 文件落盘（排障）。
 */
class Logger extends EventEmitter {
  constructor(dataDir, { max = 4000, console: toConsole = true } = {}) {
    super();
    this.max = max;
    this.seq = 0;
    this.entries = [];
    this.toConsole = toConsole;
    this.logDir = path.join(dataDir, 'logs');
    ensureDir(this.logDir);
    this.day = '';
    this.stream = null;
    this.openFile();
  }

  openFile() {
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.day && this.stream) return;
    this.day = day;
    try {
      if (this.stream) this.stream.end();
      this.stream = fs.createWriteStream(path.join(this.logDir, `lanplay-${day}.log`), { flags: 'a' });
    } catch (_) {
      this.stream = null;
    }
  }

  write(level, message) {
    const entry = {
      seq: ++this.seq,
      ts: nowIso(),
      time: new Date().toTimeString().slice(0, 8),
      level,
      message: String(message)
    };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    try {
      this.openFile();
      if (this.stream) this.stream.write(`[${entry.ts}] [${level}] ${entry.message}\n`);
    } catch (_) { /* ignore */ }
    if (this.toConsole) {
      // eslint-disable-next-line no-console
      console.log(`[${entry.time}] [${level}] ${entry.message}`);
    }
    this.emit('log', entry);
    return entry;
  }

  info(msg) { return this.write('info', msg); }
  warn(msg) { return this.write('warn', msg); }
  error(msg) { return this.write('error', msg); }
  debug(msg) { return this.write('debug', msg); }
  success(msg) { return this.write('success', msg); }

  list({ since = 0, limit = 1000 } = {}) {
    const rows = since ? this.entries.filter((e) => e.seq > since) : this.entries;
    return rows.slice(-limit);
  }

  clear() {
    this.entries = [];
    this.emit('clear');
  }

  exportText() {
    return this.entries.map((e) => `[${e.ts}] [${e.level.toUpperCase()}] ${e.message}`).join('\r\n');
  }
}

module.exports = { Logger };
