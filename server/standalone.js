'use strict';

/**
 * 无 GUI 运行模式（调试/服务器部署）：node server/standalone.js
 */
const path = require('path');
const { LanPlayServer } = require('./core/app');

const rootDir = process.env.LANPLAY_ROOT || path.join(__dirname, '..');

const server = new LanPlayServer({
  rootDir,
  guiDir: path.join(__dirname, '..', 'gui'),
  version: '1.0.0',
  hooks: {}
});

server.start().then(({ port }) => {
  console.log(`LanPlay 服务端已就绪: http://127.0.0.1:${port}`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

async function shutdown() {
  await server.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
