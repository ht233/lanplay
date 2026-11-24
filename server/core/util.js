'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function uid(prefix = '', len = 8) {
  const s = crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
  return prefix ? `${prefix}-${s}` : s;
}

function shortHash(input, len = 8) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, len);
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.ass': 'text/x-ssa; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

function mimeType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonAsync(file, fallback) {
  return new Promise((resolve) => {
    fs.readFile(file, 'utf8', (err, raw) => {
      if (err || !raw.trim()) return resolve(fallback);
      try { resolve(JSON.parse(raw)); } catch (_) { resolve(fallback); }
    });
  });
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  return dir;
}

/** true when child is inside (or equal to) root */
function isSubPath(root, child) {
  const r = path.resolve(root);
  const c = path.resolve(child);
  if (c === r) return true;
  const rel = path.relative(r, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function nowIso() {
  const d = new Date();
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function localTimestamp() {
  const d = new Date();
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function pickLanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        out.push({ iface: name, address: info.address, netmask: info.netmask });
      }
    }
  }
  // 常见家用网段优先（192.168 > 10 > 其他）
  out.sort((a, b) => {
    const score = (x) => (x.address.startsWith('192.168.') ? 0 : x.address.startsWith('10.') ? 1 : 2);
    return score(a) - score(b);
  });
  return out;
}

function isProbablyNetworkPath(p) {
  return /^\\\\/.test(p) || /^\/\//.test(p);
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_');
}

module.exports = {
  uid, shortHash, humanSize, formatDuration, mimeType, readJson, writeJson, readJsonAsync,
  ensureDir, isSubPath, clamp, sleep, nowIso, localTimestamp, pickLanAddresses,
  isProbablyNetworkPath, safeFileName
};
