'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { TranscodeSession, SPEEDS } = require('./transcode');
const { ensureDir } = require('./util');

class SessionManager extends EventEmitter {
  constructor(config, logger, ffmpeg) {
    super();
    this.config = config;
    this.logger = logger;
    this.ffmpeg = ffmpeg;
    this.hlsDir = path.join(config.dataDir, 'hls');
    ensureDir(this.hlsDir);
    this.sessions = new Map();
    this.history = [];
    setInterval(() => this.sweep(), 5000).unref?.();
  }

  defaults() {
    const t = this.config.get('transcode') || {};
    return {
      resolution: t.resolution || 'auto',
      bitrate: t.bitrate || 4000,
      fps: t.fps || 'auto',
      codec: t.codec || 'h264',
      quality: t.quality || 'balanced',
      audioBitrate: t.audioBitrate || 128,
      hlsTime: t.hlsTime || 2
    };
  }

  get maxSessions() { return Number(this.config.get('maxSessions')) || 2; }

  active() {
    // ERROR 态不占并发名额：ffmpeg 已死、会话只剩收尾展示，
    // 占着坑会让新点播报「已达最大并发」直到 20 秒清扫（真机故障主因之一）。
    return Array.from(this.sessions.values()).filter((s) => !['STOPPED', 'ENDED', 'ERROR'].includes(s.state));
  }

  /** 当前有几个会话在用硬件编码器（h264_mf 等 MFT 资源每实例独占，双实例必崩） */
  hardwareCount() {
    return Array.from(this.sessions.values())
      .filter((s) => s.hardware && s.proc && !['STOPPED', 'ENDED', 'ERROR'].includes(s.state)).length;
  }

  list() {
    return Array.from(this.sessions.values()).map((s) => s.summary());
  }

  detail(id) { return this.sessions.get(id) || null; }

  async create({ file, mediaInfo, client, settings, startAt = 0, subtitle = null, title }) {
    if (!this.ffmpeg.available) throw new Error('ffmpeg 未就绪，无法转码');
    // ERROR 态会话立刻回收（进程已死，占位无意义），
    // 避免「已达最大并发」要等 20 秒 sweep。
    for (const [id, s] of this.sessions) {
      if (s.state === 'ERROR' && !s.proc) {
        this.sessions.delete(id);
        this.finalize(s);
      }
    }
    if (this.active().length >= this.maxSessions) {
      throw new Error(`已达到最大并发转码会话数（${this.maxSessions}）`);
    }
    const session = new TranscodeSession(this, {
      file, mediaInfo, client, settings: Object.assign(this.defaults(), settings || {}), subtitle, title
    });
    // 硬件编码器并发互斥：h264_mf/nvenc 等 MFT/DXVA 资源每实例独占，
    // 本机第二个硬件会话会 "Cannot allocate memory" 崩掉并拖垮第一个。
    // 已有硬件会话时，新会话直接用 CPU 软编（转码慢一点但稳）。
    if (this.hardwareCount() > 0) {
      session.settings.encoder = 'cpu';
      this.logger.info(`[${session.id}] 已有硬件转码会话，本会话改用 CPU 软编`);
    }
    this.sessions.set(session.id, session);
    this.logger.info(`[${session.id}] 新建转码会话：${path.basename(file)}`);
    session.on('state', (st) => this.emit('session', st));
    this.emit('sessions');
    await session.start(startAt);
    // 不做分片等待：POST /api/play 必须在转码进程一起动就立即返回。
    // 曾在这里 await session.waitForSegments(4, 20000)：硬件编码器（nvenc）冷启动
    // 产出慢时整个 HTTP 响应被阻塞到 20s 超时（用户实测「等 20 秒才播放」）。
    // 起播鲁棒性交给客户端缓冲策略，服务端永不阻塞响应。
    // spawnProc 内部已等 index.m3u8 首次出现（50ms 轮询）才 markPlaylistReady，故返回时列表必存在。
    this.emit('sessions');
    return session;
  }

  finalize(session) {
    if (session._historyWritten) return;
    session._historyWritten = true;
    this.history.unshift({
      id: session.id,
      title: session.title,
      file: session.file,
      client: session.client ? session.client.name : '',
      startedAt: session.createdAt,
      endedAt: Date.now(),
      position: session.position,
      duration: session.duration,
      error: session.error || ''
    });
    this.history = this.history.slice(0, 50);
    try {
      this.config.addRecent(session.file);
    } catch (_) { /* ignore */ }
    this.emit('sessions');
  }

  /** 跳转（复用会话自身的 seek，会重启 ffmpeg 并递增 generation） */
  async seek(id, position) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('会话不存在');
    // 同样不做分片等待：seek 的 HTTP 响应必须在 ffmpeg 重启后立即返回，
    // 起播鲁棒性由客户端缓冲策略保证（不可在此阻塞 10s）。
    return await s.seek(position);
  }

  async stop(id, reason) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('会话不存在');
    await s.stop(reason);
    this.sessions.delete(id);
    this.emit('sessions');
  }

  /** 进程异常退出/客户端失联清理 */
  sweep() {
    // 无人观看自动停止：播放器（浏览器/Android）每几秒拉一次 index.m3u8；
    // 弹窗没关但浏览器整个被关掉、APK 被杀等场景拉流停止，会话空转占 CPU/并发名额。
    // 90 秒（≈3 个 HLS 窗口周期）没有任何拉取就视为无人观看，服务端主动停掉。
    const IDLE_MS = 90000;
    const now0 = Date.now();
    for (const [id0, s0] of this.sessions) {
      if (['STOPPED', 'ENDED', 'ERROR'].includes(s0.state)) continue;
      // 补充 33：ffmpeg 写完全片退出后 proc=null 但会话保持 PLAYING（客户端还在播缓冲），
      // 清扫条件要覆盖这种「无进程但有观众」的会话。
      if ((s0.proc || s0.state === 'PLAYING') && now0 - (s0.lastPlaylistAt || s0.createdAt) > IDLE_MS) {
        this.logger.info(`[${id0}] 超过 ${Math.round(IDLE_MS / 1000)}s 无人拉流，自动停止（最后拉取 ${new Date(s0.lastPlaylistAt || s0.createdAt).toISOString()}）`);
        this.stop(id0, '无人观看自动停止').catch(() => {});
      }
    }

    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const ended = ['STOPPED', 'ENDED', 'ERROR'].includes(s.state);
      if (!ended) continue;
      // 结束的会话保留 20 秒供客户端/GUI 收尾，再清理
      if (!s.endedAt) s.endedAt = now;
      if (!s.proc && now - s.endedAt > 20000) {
        if (!s._finalized) { s._finalized = true; this.finalize(s); }
        this.sessions.delete(id);
        this.emit('sessions');
      } else if (!s._finalized) {
        s._finalized = true;
        this.finalize(s);
      }
    }
  }

  async stopAll() {
    await Promise.all(Array.from(this.sessions.values()).map((s) => s.stop('服务端关闭').catch(() => {})));
    this.sessions.clear();
  }
}

module.exports = { SessionManager, SPEEDS };
