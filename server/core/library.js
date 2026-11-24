'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const {
  uid, shortHash, readJsonAsync, writeJson, ensureDir, isSubPath,
  isProbablyNetworkPath
} = require('./util');

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.webm', '.rmvb', '.mpg', '.mpeg', '.vob', '.iso']);
const AUDIO_EXT = new Set(['.mp3', '.flac', '.aac', '.m4a', '.wav', '.ogg', '.opus', '.wma', '.ape']);
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.sup']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const SKIP_DIR = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', '@eaDir']);

/** 带 HTTP 状态码的错误，让上层能区分「客户端问题」与「服务端异常」 */
function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function kindOf(name, isDir) {
  if (isDir) return 'dir';
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (SUB_EXT.has(ext)) return 'subtitle';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'file';
}

/** 排序参数归一化：既接受 {sort:'size', order:'desc'}，也接受 {sort:'size-desc'}。 */
function normalizeSort(sort, order) {
  let sortKey = String(sort || '');
  let sortOrder = String(order || '');
  const dash = sortKey.lastIndexOf('-');
  if (dash > 0 && sortKey.slice(dash + 1) === 'desc') {
    sortOrder = sortOrder || 'desc';
    sortKey = sortKey.slice(0, dash);
  }
  return { sortKey, sortOrder: sortOrder === 'desc' ? 'desc' : 'asc' };
}

/**
 * 媒体库：轻量引用根（不刮削），按需遍历目录 + 元数据缓存。
 */
class Library extends EventEmitter {
  constructor(config, logger, probe) {
    super();
    this.config = config;
    this.logger = logger;
    this.probe = probe;
    this.cacheFile = path.join(config.dataDir, 'cache', 'media-cache.json');
    this.cache = {};
    this.cacheDirty = false;
    this.scanning = new Set();
    // 探测缓存结构版本号：normalize() 新增字段（如 startPts）时递增，
    // 让旧结构缓存条目自动失效重新探测（旧条目缺字段会让基于该字段的
    // 转码逻辑静默失效，无法靠代码升级修复已缓存的文件）。
    this.META_VER = 2;
    // 媒体库版本号：引用增删改、目录内容变化时递增。
    // 客户端/服务端 GUI 用它做「有没有变化」的轻量判断，再决定是否重拉列表。
    this.version = 1;
    this.lastChangeAt = Date.now();
    this.lastChangeReason = '';
    this.loadCache();
    setInterval(() => this.flushCache(), 15000).unref?.();
  }

  async loadCache() {
    this.cache = (await readJsonAsync(this.cacheFile, {})) || {};
  }

  flushCache() {
    if (!this.cacheDirty) return;
    this.cacheDirty = false;
    try { writeJson(this.cacheFile, this.cache); } catch (_) { /* ignore */ }
  }

  get roots() { return this.config.get('roots'); }

  listRoots() {
    return this.roots.map((r) => {
      let exists = false;
      try { exists = fs.existsSync(r.path); } catch (_) { exists = false; }
      // 旧版本添加的引用没有 mtime/size 字段（补充 28 才加入）：现场 stat 补齐并回写，
      // 否则时间/大小排序对存量引用永远按 0 排在尾部
      if ((r.mtime === undefined || r.size === undefined) && exists) {
        try {
          const st = fs.statSync(r.path);
          r.mtime = Math.round(st.mtimeMs);
          r.size = st.size;
        } catch (_) { /* ignore */ }
      }
      return Object.assign({}, r, { exists });
    });
  }

  findRoot(id) { return this.roots.find((r) => r.id === id); }

  /** 从客户端/API 传入的路径解析出所属根，防止越权浏览 */
  resolveWithinRoots(target) {
    if (!target) return null;
    const resolved = path.resolve(target);
    for (const root of this.roots) {
      if (!root.enabled) continue;
      if (isSubPath(root.path, resolved)) return { root, path: resolved };
    }
    // 网络路径可能无法直接 resolve 比较，做字符串前缀兜底
    for (const root of this.roots) {
      if (!root.enabled) continue;
      if (isProbablyNetworkPath(root.path) && resolved.toLowerCase().startsWith(path.resolve(root.path).toLowerCase())) {
        return { root, path: resolved };
      }
    }
    return null;
  }

  addRoot(inputPath, { name, kind } = {}) {
    const raw = String(inputPath || '').trim().replace(/^"|"$/g, '');
    if (!raw) throw new Error('路径为空');
    const resolved = path.resolve(raw);
    // Windows 盘符根 "D:\" 也允许
    const exists = fs.existsSync(resolved);
    if (!exists && !isProbablyNetworkPath(raw)) throw new Error(`路径不存在：${resolved}`);
    let stat = null;
    try { stat = fs.statSync(resolved); } catch (_) { stat = null; }
    const type = kind || (stat ? (stat.isDirectory() ? 'dir' : 'file') : 'dir');
    if (this.roots.some((r) => r.path.toLowerCase() === resolved.toLowerCase())) {
      throw new Error('该路径已添加');
    }
    const root = {
      id: `r${shortHash(resolved, 6)}`,
      name: (name && String(name).trim()) || path.basename(resolved) || resolved,
      path: resolved,
      type,
      enabled: true,
      addedAt: new Date().toISOString(),
      // 时间/大小排序用（媒体源的时间 = 引用目标自身 mtime；目录/文件皆取）
      mtime: stat ? Math.round(stat.mtimeMs) : 0,
      size: stat ? stat.size : 0
    };
    this.roots.push(root);
    this.config.save();
    this.logger.success(`新增引用 [${root.id}] ${root.path} (${root.type})`);
    this.touch();
    this.emit('roots');
    return root;
  }

  updateRoot(id, patch) {
    const root = this.findRoot(id);
    if (!root) throw new Error('引用不存在');
    if (patch.name !== undefined) root.name = String(patch.name).slice(0, 80);
    if (patch.enabled !== undefined) root.enabled = !!patch.enabled;
    this.config.save();
    this.touch();
    this.emit('roots');
    return root;
  }

  removeRoot(id) {
    const idx = this.roots.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error('引用不存在');
    const [root] = this.roots.splice(idx, 1);
    this.config.save();
    this.logger.info(`移除引用 [${root.id}] ${root.path}`);
    this.touch();
    this.emit('roots');
    return root;
  }

  /** 批量启用/禁用 */
  updateMany(ids, patch) {
    const list = Array.isArray(ids) ? ids : [];
    const updated = [];
    for (const id of list) {
      const root = this.findRoot(id);
      if (!root) continue;
      if (patch.name !== undefined) root.name = String(patch.name).slice(0, 80);
      if (patch.enabled !== undefined) root.enabled = !!patch.enabled;
      updated.push(root);
    }
    if (updated.length) {
      this.config.save();
      this.touch();
      this.emit('roots');
    }
    return updated;
  }

  /** 批量移除；all=true 时清空全部引用 */
  removeMany(ids, { all = false } = {}) {
    const set = new Set(Array.isArray(ids) ? ids : []);
    const removed = [];
    for (let i = this.roots.length - 1; i >= 0; i--) {
      const r = this.roots[i];
      if (all || set.has(r.id)) removed.push(...this.roots.splice(i, 1));
    }
    if (removed.length) {
      this.config.save();
      this.logger.info(`批量移除引用 ${removed.length} 个`);
      this.touch();
      this.emit('roots');
    }
    return removed;
  }

  /** 供客户端/GUI 增量同步：roots 快照 + 版本号（内容变化即递增） */
  snapshot() {
    const roots = this.roots.map((r) => {
      let exists = false;
      try { exists = fs.existsSync(r.path); } catch (_) { exists = false; }
      // 旧引用补 mtime/size（同 listRoots）
      if ((r.mtime === undefined || r.size === undefined) && exists) {
        try {
          const st = fs.statSync(r.path);
          r.mtime = Math.round(st.mtimeMs);
          r.size = st.size;
        } catch (_) { /* ignore */ }
      }
      return {
        id: r.id, name: r.name, path: r.path, type: r.type,
        enabled: r.enabled, addedAt: r.addedAt, mtime: r.mtime || 0, size: r.size || 0, exists
      };
    });
    return { version: this.version, roots };
  }

  /** 标记媒体库内容有变化（目录监听调用），供客户端轮询增量同步 */
  touch(reason = '') {
    this.version += 1;
    this.lastChangeAt = Date.now();
    this.lastChangeReason = reason;
    this.emit('change', { version: this.version, reason });
  }

  /** 目录浏览：返回子目录与媒体文件（同一目录下的字幕/封面作为附属信息） */
  async browse(rootId, relPath = '', { sort = '', order = '' } = {}) {
    const { sortKey, sortOrder } = normalizeSort(sort, order);
    const root = this.findRoot(rootId);
    if (!root) throw badRequest('引用不存在', 404);
    if (!root.enabled) throw badRequest('引用已禁用', 403);
    const target = relPath ? path.resolve(root.path, relPath) : path.resolve(root.path);
    if (!isSubPath(root.path, target) && target !== path.resolve(root.path)) {
      throw badRequest('越权访问路径', 403);
    }
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (e) {
      throw badRequest(`无法读取目录：${e.code === 'ENOENT' ? '路径不存在' : e.message}`, 404);
    }
    if (stat.isFile()) {
      const item = await this.describeFile(target);
      return { rootId, path: relPath, isFile: true, name: path.basename(target), items: [item], sort: sortKey, order: sortOrder };
    }
    const entries = await fsp.readdir(target, { withFileTypes: true });
    const items = [];
    const subs = entries.filter((e) => e.isFile() && SUB_EXT.has(path.extname(e.name).toLowerCase())).map((e) => e.name);
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        items.push({
          name: e.name, type: 'dir', kind: 'dir',
          path: path.relative(root.path, path.join(target, e.name)).split(path.sep).join('/')
        });
        continue;
      }
      const kind = kindOf(e.name, false);
      // 可列出项：视频/音频/图片。字幕与其它杂项（txt/nfo/exe/zip…）不进列表。
      // 图片走 /media/ 原图直出，不参与转码会话。
      if (kind !== 'video' && kind !== 'audio' && kind !== 'image') continue;
      if (!e.isFile()) continue;
      const full = path.join(target, e.name);
      let st;
      try { st = await fsp.stat(full); } catch (_) { continue; }
      const item = {
        name: e.name,
        type: 'file',
        kind,
        path: path.relative(root.path, full).split(path.sep).join('/'),
        size: st.size,
        mtime: st.mtimeMs,
        subs: subs.filter((s) => path.parse(s).name.toLowerCase().startsWith(path.parse(e.name).name.toLowerCase()))
      };
      const cached = this.cache[full];
      if (cached && cached.size === st.size && cached.mtime === Math.round(st.mtimeMs)) {
        Object.assign(item, { duration: cached.duration, width: cached.width, height: cached.height, videoCodec: cached.videoCodec });
      }
      items.push(item);
    }
    items.sort((a, b) => {
      // 排序键（kind=类型）参与升降序：
      //  - kind asc  = 文件夹（dir）在前、文件在后
      //  - kind desc = 文件在前、文件夹在后
      // name/size/mtime 与 dir-first 独立：目录恒在前（浏览习惯），desc 只反转子项顺序。
      const dirFirst = (x, y) => {
        if (x.kind === 'dir' && y.kind !== 'dir') return -1;
        if (y.kind === 'dir' && x.kind !== 'dir') return 1;
        return 0;
      };
      let cmp;
      if (sortKey === 'kind') {
        // 类型排序：先按目录/文件分组（组序随升降序翻转），组内先按 kind 再按名称
        const group = sortOrder === 'desc'
          ? dirFirst(b, a)  // desc：文件组在前
          : dirFirst(a, b); // asc：文件夹组在前
        if (group) return group;
        cmp = String(a.kind).localeCompare(String(b.kind)) || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
        return sortOrder === 'desc' ? -cmp : cmp;
      }
      // 非 kind 排序：目录恒在前，desc 只反转子项
      const group = dirFirst(a, b);
      if (group) return group;
      if (sortKey === 'size') cmp = (a.size || 0) - (b.size || 0);
      else if (sortKey === 'mtime') cmp = (a.mtime || 0) - (b.mtime || 0);
      else cmp = a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
      return sortOrder === 'desc' ? -cmp : cmp;
    });
    return { rootId, path: relPath, isFile: false, name: path.basename(target), items, sort: sortKey, order: sortOrder };
  }

  async describeFile(file) {
    const st = await fsp.stat(file);
    const cached = this.cache[file];
    const base = {
      name: path.basename(file), type: 'file', kind: kindOf(path.basename(file), false),
      path: file.replace(/\\/g, '/'), size: st.size, mtime: st.mtimeMs
    };
    if (cached && cached.size === st.size && cached.mtime === Math.round(st.mtimeMs)) return Object.assign(base, cached.meta);
    return base;
  }

  getCached(file) {
    try {
      const st = fs.statSync(file);
      const c = this.cache[file];
      if (c && c.size === st.size && c.mtime === Math.round(st.mtimeMs)
        && c.metaVer === this.META_VER) return c;
    } catch (_) { /* ignore */ }
    return null;
  }

  /** 探测并缓存媒体信息（客户端播放前调用） */
  async mediaInfo(file) {
    const cached = this.getCached(file);
    if (cached) return cached;
    const info = await this.probe.probe(file);
    const st = fs.statSync(file);
    const record = Object.assign({}, info, { size: st.size, mtime: Math.round(st.mtimeMs), metaVer: this.META_VER });
    this.cache[file] = record;
    this.cacheDirty = true;
    return record;
  }

  /** 列出根下全部可播放项（分页，供客户端“全部影片”视图） */
  async listAll(rootId, { offset = 0, limit = 200 } = {}) {
    const root = this.findRoot(rootId);
    if (!root) throw new Error('引用不存在');
    if (root.type === 'file') {
      return { total: 1, items: [await this.describeFile(root.path)], offset: 0, limit };
    }
    const out = [];
    const walk = async (dir, depth) => {
      if (depth > 8 || out.length > 5000) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || SKIP_DIR.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await walk(full, depth + 1); continue; }
        const kind = kindOf(e.name, false);
        if (kind !== 'video' && kind !== 'audio' && kind !== 'image') continue;
        const item = await this.describeFile(full);
        out.push(item);
      }
    };
    await walk(root.path, 0);
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    return { total: out.length, offset, limit, items: out.slice(offset, offset + limit) };
  }

  /** 查找同目录外挂字幕 */
  findExternalSubs(mediaFile) {
    const dir = path.dirname(mediaFile);
    const stem = path.parse(mediaFile).name.toLowerCase();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    return entries
      .filter((e) => e.isFile() && SUB_EXT.has(path.extname(e.name).toLowerCase()))
      .filter((e) => path.parse(e.name).name.toLowerCase().startsWith(stem))
      .map((e) => {
        const full = path.join(dir, e.name);
        const lang = path.parse(e.name).name.slice(stem.length).replace(/^[._-]/, '');
        return { path: full, name: e.name, lang: lang || '', format: path.extname(e.name).slice(1).toLowerCase() };
      });
  }

  rootsForClient() {
    return this.roots.filter((r) => r.enabled).map((r) => ({
      id: r.id, name: r.name, type: r.type, path: r.path, count: null,
      mtime: r.mtime || 0, size: r.size || 0
    }));
  }
}

module.exports = { Library, VIDEO_EXT, AUDIO_EXT, SUB_EXT, kindOf, badRequest };
