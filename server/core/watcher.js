'use strict';

/**
 * 媒体目录实时监听。
 *
 * 需求：引用根里的文件被增删改名后，服务端 GUI 与 Android 客户端的列表都要跟着变，
 * 不需要用户手动点「刷新」。
 *
 * 实现取舍：
 * - 不引第三方依赖（绿色版要保持 0 安装），只用 Node 内置 `fs.watch`。
 * - `fs.watch` 在 Windows 上是 ReadDirectoryChangesW，递归监听一棵大目录树代价高
 *   （整盘引用会挂死），所以这里**只监听已浏览过的目录**（连同它们的直接子目录），
 *   由 HTTP 层在 browse() 时上报「这个目录有人看」，再把结果集变化告诉 Library。
 * - 事件风暴（复制整部剧会连续触发几百次）用 250ms 合并窗口 + 全局限流。
 */
const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 250;
const MIN_TOUCH_INTERVAL_MS = 2000; // 变化太密（如正在下载的大文件）时限流，静默期后统一报一次
const MAX_WATCHERS = 400;
const IDLE_TTL_MS = 10 * 60 * 1000; // 10 分钟没人访问就停止监听

class MediaWatcher {
  constructor(library, logger) {
    this.library = library;
    this.logger = logger;
    this.watchers = new Map(); // dir -> { watcher, timer, lastSeen, sig }
    this.pending = new Set(); // 待确认的目录（防抖窗口内）
    this.lastTouchAt = 0; // 限流：两次真实 touch 的最小间隔
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000).unref?.();
    this.stats = { dirs: 0, events: 0, lastEventAt: 0, confirmed: 0, falsePositives: 0 };
  }

  /** 开始监听某个目录（重复调用无副作用） */
  watch(dir) {
    if (!dir || this.watchers.has(dir)) {
      if (dir && this.watchers.has(dir)) this.watchers.get(dir).lastSeen = Date.now();
      return;
    }
    if (this.watchers.size >= MAX_WATCHERS) {
      // 已达上限：淘汰最久没被访问的
      let oldest = null;
      for (const [d, w] of this.watchers) {
        if (!oldest || w.lastSeen < oldest[1].lastSeen) oldest = [d, w];
      }
      if (oldest) this.unwatch(oldest[0]);
    }
    let watcher;
    try {
      watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
        this.onEvent(dir, event, filename);
      });
    } catch (e) {
      // 目录不存在 / 无权限 / 网络路径不支持 —— 静默跳过，不影响播放
      return;
    }
    watcher.on('error', () => this.unwatch(dir));
    this.watchers.set(dir, { watcher, timer: null, lastSeen: Date.now(), sig: this.snapshotSig(dir) });
    this.stats.dirs = this.watchers.size;
  }

  unwatch(dir) {
    const w = this.watchers.get(dir);
    if (!w) return;
    try { w.watcher.close(); } catch (_) { /* ignore */ }
    if (w.timer) clearTimeout(w.timer);
    this.watchers.delete(dir);
    this.stats.dirs = this.watchers.size;
  }

  /**
   * 目录内容签名：顶层条目的「名字 + 类型 + 大小 + mtime(秒)」。
   * fs.watch 在 Windows 上对**读取文件**也常会冒出 change 事件
   * （last-access 时间戳更新、缩略图抽帧、杀毒扫描都会触发），
   * 而这些根本不改变目录列表。事件到达后重算签名对比，
   * 列表没变就不 touch —— 否则客户端每 4 秒就会被假事件刷一次屏，
   * 表现为「像什么地方刷新了，焦点突然跳走 / 文件夹图标闪成视频帧」。
   */
  snapshotSig(dir) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => {
          let tail = '';
          if (e.isFile()) {
            try {
              const st = fs.statSync(path.join(dir, e.name));
              tail = `${st.size}:${Math.floor(st.mtimeMs / 1000)}`;
            } catch (_) { tail = 'x'; }
          }
          return `${e.isDirectory() ? 'd' : 'f'}${e.name}${tail}`;
        });
    } catch (_) {
      return null; // 目录读不到（被删/无权限）：保持 null，事件到达时按真变化处理
    }
    return names.join('\n');
  }

  onEvent(dir, event, filename) {
    this.stats.events += 1;
    this.stats.lastEventAt = Date.now();
    const w = this.watchers.get(dir);
    if (w) {
      w.lastSeen = Date.now();
      // 事件合并：复制一整个剧集目录会刷出上百个事件，
      // 只在下一次静默 250ms 后发一次「这个目录变了」。
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        w.timer = null;
        this.report(dir);
      }, DEBOUNCE_MS);
    } else {
      this.report(dir);
    }
  }

  report(dir) {
    const w = this.watchers.get(dir);
    const before = w ? w.sig : undefined;
    const now = this.snapshotSig(dir);
    if (w) w.sig = now;
    // 签名一致 = 目录清单没变（典型：读文件导致的 last-access 抖动）→ 忽略
    if (before !== undefined && now !== null && before === now) {
      this.stats.falsePositives += 1;
      this.library.logger?.debug?.(`目录无实变化（假事件忽略）：${path.basename(dir) || dir}`);
      return;
    }
    if (before !== undefined && now !== null) this.stats.confirmed += 1;
    // 限流：变化风暴（下载中/复制中）时 2 秒最多 touch 一次
    const gap = Date.now() - this.lastTouchAt;
    if (gap < MIN_TOUCH_INTERVAL_MS) {
      if (!this.pending.has(dir)) {
        this.pending.add(dir);
        setTimeout(() => {
          this.pending.delete(dir);
          this.touchNow(dir);
        }, MIN_TOUCH_INTERVAL_MS - gap).unref?.();
      }
      return;
    }
    this.touchNow(dir);
  }

  touchNow(dir) {
    this.lastTouchAt = Date.now();
    this.library.logger?.debug?.(`目录变化：${path.basename(dir) || dir}`);
    // 通知 Library 版本号 +1，客户端轮询 /api/sync 时能看到
    this.library.touch(`目录变化：${path.basename(dir) || dir}`);
  }

  sweep() {
    const now = Date.now();
    for (const [dir, w] of this.watchers) {
      if (now - w.lastSeen > IDLE_TTL_MS) this.unwatch(dir);
    }
  }

  stop() {
    clearInterval(this.sweepTimer);
    for (const dir of [...this.watchers.keys()]) this.unwatch(dir);
  }
}

module.exports = { MediaWatcher };
