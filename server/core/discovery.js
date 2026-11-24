'use strict';

const dgram = require('dgram');
const os = require('os');

const MAGIC = 'LANPLAY1';

/**
 * UDP 自动发现：客户端广播 LANPLAY1 DISCOVER，服务端应答，
 * 携带服务名、ID、HTTP 端口与是否需要配对码。
 */
class Discovery {
  constructor({ config, logger, port, getInfo }) {
    this.config = config;
    this.logger = logger;
    this.port = port;       // HTTP 端口
    this.getInfo = getInfo;
    this.socket = null;
    this.discoveryPort = Number(config.get('discoveryPort')) || 52310;
    this.timer = null;
  }

  start() {
    if (!this.config.get('discovery')) return;
    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket.on('error', (err) => this.logger.warn(`自动发现服务异常：${err.message}`));
      this.socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
      this.socket.bind(this.discoveryPort, () => {
        try { this.socket.setBroadcast(true); } catch (_) { /* ignore */ }
        this.logger.info(`局域网发现服务已启动 UDP:${this.discoveryPort}`);
      });
      // 周期性广播自身，便于客户端无需先发查询
      this.timer = setInterval(() => this.announce(), 5000);
      this.timer.unref?.();
    } catch (err) {
      this.logger.warn(`无法启动自动发现：${err.message}`);
    }
  }

  onMessage(msg, rinfo) {
    const text = msg.toString('utf8').trim();
    if (!text.startsWith(MAGIC)) return;
    const cmd = text.slice(MAGIC.length).trim();
    if (cmd === 'DISCOVER') {
      this.reply(rinfo.address, rinfo.port);
    }
  }

  payload() {
    const info = this.getInfo ? this.getInfo() : {};
    const data = {
      magic: MAGIC,
      type: 'ANNOUNCE',
      name: info.name,
      serverId: info.serverId,
      port: this.port,
      requirePin: info.requirePin,
      discoveryPort: this.discoveryPort,
      version: '1.0.0',
      // 局域网 IPv4，客户端据此直连；取不到时由客户端回退到报文源地址
      host: info.host || ''
    };
    return Buffer.from(JSON.stringify(data));
  }

  reply(address, port) {
    if (!this.socket) return;
    try { this.socket.send(this.payload(), port, address); } catch (_) { /* ignore */ }
  }

  announce() {
    if (!this.socket) return;
    const buf = this.payload();
    try { this.socket.send(buf, this.discoveryPort, '255.255.255.255'); } catch (_) { /* ignore */ }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.socket) { try { this.socket.close(); } catch (_) { /* ignore */ } this.socket = null; }
  }
}

module.exports = { Discovery, MAGIC };
