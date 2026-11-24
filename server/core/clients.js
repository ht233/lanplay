'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { uid, nowIso } = require('./util');

const PAIR_CODE_TTL = 24 * 3600 * 1000;
const TOKEN_TTL = 30 * 24 * 3600 * 1000;

/**
 * 客户端注册与访问控制：
 * - 首次连接需要配对码（服务端顶部 PIN），换取长期 token
 * - 已配对客户端可在“客户端”页查看/踢出
 * - 可关闭 PIN 校验（局域网信任模式）
 */
class ClientRegistry extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.clients = new Map();   // id -> client
    this.paired = new Map();    // token -> clientId
    this.tickets = new Map();   // ticket -> {clientId, at}
    setInterval(() => this.prune(), 60000).unref?.();
  }

  get requirePin() { return !!this.config.get('requirePin'); }

  currentPin() { return this.config.get('pin'); }

  verifyPin(pin) {
    if (!this.requirePin) return true;
    return String(pin || '').trim() === String(this.currentPin()).trim();
  }

  issueTicket(client, ip) {
    const id = client.id || uid('c', 6);
    const record = {
      id,
      name: client.name || client.model || '未命名设备',
      model: client.model || '',
      platform: client.platform || 'Android',
      ip: ip || client.ip || '',
      pairedAt: client.pairedAt || nowIso(),
      lastSeen: nowIso(),
      lastActive: Date.now(),
      status: 'online',
      appVersion: client.appVersion || ''
    };
    const token = uid('t', 24);
    this.clients.set(id, record);
    this.paired.set(token, id);
    this.tickets.set(token, { clientId: id, at: Date.now() });
    this.logger.success(`客户端已配对：${record.name}（${record.ip}）`);
    this.emit('clients');
    return { token, clientId: id, client: record };
  }

  /** 已配对客户端用旧 token 重连时刷新在线状态 */
  touch(token, meta = {}) {
    const clientId = this.paired.get(token);
    if (!clientId) return null;
    const rec = this.clients.get(clientId);
    if (!rec) return null;
    rec.lastSeen = nowIso();
    rec.lastActive = Date.now();
    rec.status = 'online';
    if (meta.ip) rec.ip = meta.ip;
    if (meta.name) rec.name = meta.name;
    if (meta.appVersion) rec.appVersion = meta.appVersion;
    this.emit('clients');
    return rec;
  }

  authenticate(token) {
    if (!this.requirePin) return { ok: true, clientId: this.paired.get(token) || 'guest' };
    if (!token) return { ok: false };
    const id = this.paired.get(token);
    if (!id) return { ok: false };
    return { ok: true, clientId: id, client: this.clients.get(id) };
  }

  list() {
    return Array.from(this.clients.values()).map((c) => Object.assign({}, c));
  }

  kick(id) {
    const rec = this.clients.get(id);
    if (!rec) throw new Error('客户端不存在');
    for (const [token, cid] of this.paired) if (cid === id) this.paired.delete(token);
    this.clients.delete(id);
    this.logger.warn(`已踢出客户端：${rec.name}（${rec.ip}）`);
    this.emit('clients');
    return rec;
  }

  markOffline(clientId) {
    const rec = this.clients.get(clientId);
    if (!rec) return;
    rec.status = 'offline';
    this.emit('clients');
  }

  prune() {
    const now = Date.now();
    for (const [token, t] of this.tickets) if (now - t.at > PAIR_CODE_TTL) this.tickets.delete(token);
    for (const [token, id] of this.paired) {
      const rec = this.clients.get(id);
      if (!rec) { this.paired.delete(token); continue; }
      if (rec.status === 'online' && now - rec.lastActive > 90 * 1000) {
        rec.status = 'offline';
        this.emit('clients');
      }
      if (now - rec.lastActive > TOKEN_TTL) {
        this.paired.delete(token);
        this.clients.delete(id);
      }
    }
  }
}

module.exports = { ClientRegistry };
