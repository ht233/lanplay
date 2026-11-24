'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { Config } = require('./config');
const { Logger } = require('./logger');
const { Ffmpeg } = require('./ffmpeg');
const { Library } = require('./library');
const { SessionManager } = require('./sessions');
const { ClientRegistry } = require('./clients');
const { Discovery } = require('./discovery');
const { Metrics } = require('./metrics');
const { createHttpServer } = require('./http');
const { createGuiApi } = require('./gui-api');
const { MediaWatcher } = require('./watcher');
const { pickLanAddresses, ensureDir } = require('./util');

/**
 * LanPlay 服务端核心。GUI(Electron) 与命令行模式共用。
 */
class LanPlayServer {
  constructor({ rootDir, guiDir, version, hooks = {} }) {
    this.rootDir = rootDir;
    this.guiDir = guiDir;
    this.version = version || '1.0.0';
    this.hooks = hooks;
    this.config = new Config(rootDir);
    this.logger = new Logger(this.config.dataDir);
    this.ffmpeg = new Ffmpeg(rootDir, this.logger, {
      extraDirs: [path.join(rootDir, 'bin'), path.join(__dirname, '..', '..', '_toolchain', 'ffmpeg', 'ffmpeg-9.1-essentials_build', 'bin')]
    });
    this.library = new Library(this.config, this.logger, this.ffmpeg);
    this.watcher = new MediaWatcher(this.library, this.logger);
    this.sessions = new SessionManager(this.config, this.logger, this.ffmpeg);
    this.clients = new ClientRegistry(this.config, this.logger);
    this.metrics = new Metrics(2000);
    this.startedAt = Date.now();
    this.http = null;
    this.discovery = null;
    this.port = this.config.get('port');
  }

  async findPort(preferred, auto) {
    const tryPort = (p) => new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '0.0.0.0');
    });
    if (await tryPort(preferred)) return preferred;
    if (!auto) throw new Error(`端口 ${preferred} 已被占用`);
    for (let p = preferred + 1; p < preferred + 60; p++) {
      if (await tryPort(p)) {
        this.logger.warn(`端口 ${preferred} 已被占用，自动改用 ${p}`);
        return p;
      }
    }
    throw new Error('未找到可用端口');
  }

  async start() {
    this.logger.info(`LanPlay 服务端启动 v${this.version}，服务ID ${this.config.get('serverId')}`);
    this.logger.info(`生成配对码`);
    this.logger.info(`初始配对码：${this.config.get('pin')}（长期有效，可在设置中重新生成）`);

    this.port = await this.findPort(Number(this.config.get('port')) || 8099, this.config.get('autoPort') !== false);
    if (this.port !== Number(this.config.get('port'))) {
      this.config.data.port = this.port;
      this.config.save();
    }

    await this.ffmpeg.detect();

    const ctx = {
      config: this.config,
      logger: this.logger,
      library: this.library,
      sessions: this.sessions,
      ffmpeg: this.ffmpeg,
      clients: this.clients,
      watcher: this.watcher,
      guiDir: this.guiDir,
      port: this.port,
      localIp: (pickLanAddresses()[0] || {}).address || '127.0.0.1',
      startedAt: this.startedAt,
      metrics: () => this.metrics.current(),
      pickFolder: this.hooks.pickFolder,
      pickFiles: this.hooks.pickFiles,
      quit: this.hooks.quit
    };
    const guiApi = createGuiApi(Object.assign({ app: this.hooks.app }, ctx));
    ctx.guiApi = guiApi;
    this.guiApi = guiApi;
    const { server } = createHttpServer(ctx);
    this.http = server;

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, this.config.get('bindHost') || '0.0.0.0', () => resolve());
    });

    const ips = pickLanAddresses();
    this.logger.success(`LanPlay 服务端已启动 监听 0.0.0.0:${this.port}`);
    this.logger.info(`局域网访问：${ips.length ? ips.map((i) => `http://${i.address}:${this.port}`).join('  ') : '无局域网地址'}`);

    this.discovery = new Discovery({
      config: this.config,
      logger: this.logger,
      port: this.port,
      getInfo: () => ({
        name: this.config.get('serverName'),
        serverId: this.config.get('serverId'),
        requirePin: !!this.config.get('requirePin'),
        host: (pickLanAddresses()[0] || {}).address || ''
      })
    });
    this.discovery.start();

    // 引用根状态巡检
    setInterval(() => {
      for (const root of this.library.roots) {
        const exists = fs.existsSync(root.path);
        if (!exists && root.enabled) {
          root._missing = true;
        } else {
          root._missing = false;
        }
      }
    }, 10000).unref?.();

    return { port: this.port };
  }

  async stop() {
    this.logger.info('服务端正在关闭…');
    if (this.discovery) this.discovery.stop();
    if (this.watcher) this.watcher.stop();
    await this.sessions.stopAll();
    this.library.flushCache();
    if (this.http) await new Promise((resolve) => this.http.close(resolve));
    this.config.save();
  }
}

module.exports = { LanPlayServer };
