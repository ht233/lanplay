'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const { LanPlayServer } = require('./core/app');
const { Config } = require('./core/config');

// 绿色版：配置与日志落在 exe 同级目录（便携模式）
const isPackaged = app.isPackaged;
const rootDir = Config.resolveRootDir({ isPackaged, execPath: process.execPath, appRoot: path.join(__dirname, '..') });

app.setAppUserModelId('com.lanplay.server');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow = null;
let server = null;
let quitting = false;
let stopped = false;
let tray = null;

/** 托盘图标：优先用 16px 小图标，缺失时退回主图标 */
function trayImage() {
  const assets = path.join(__dirname, '..', 'gui', 'assets');
  for (const name of ['icon16.png', 'icon32.png', 'icon.png']) {
    const p = path.join(assets, name);
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch (_) { /* try next */ }
  }
  return nativeImage.createEmpty();
}

function buildTray() {
  if (tray) return tray;
  try {
    tray = new Tray(trayImage());
  } catch (_) {
    return null;
  }
  const updateTip = () => {
    const port = server ? server.port : 0;
    tray.setToolTip(`LanPlay 服务端${port ? ` · 端口 ${port}` : ''}`);
  };
  updateTip();
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showWindow()
    },
    {
      label: '复制局域网地址',
      click: () => {
        const clipboard = require('electron').clipboard;
        const ip = (server && server.localIp) || '127.0.0.1';
        const port = server ? server.port : 8099;
        clipboard.writeText(`http://${ip}:${port}`);
      }
    },
    {
      label: '停止全部转码会话',
      click: () => { if (server) server.sessions.stopAll().catch(() => {}); }
    },
    { type: 'separator' },
    {
      label: '退出 LanPlay',
      click: () => { quitting = true; app.quit(); }
    }
  ]));
  // 双击托盘 = 显示窗口
  tray.on('double-click', () => showWindow());
  // 左键单击托盘 = 显示窗口（多数用户习惯单击；Windows 上 click 与 double-click 都会触发，
  // showWindow 幂等无副作用）
  tray.on('click', () => showWindow());
  return tray;
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(port) {
  const iconPath = path.join(__dirname, '..', 'gui', 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'LanPlay · 服务端',
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 通过本机 HTTP 服务加载界面：与 API 同源，避免 file:// 的跨域与相对路径问题
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  // 关闭窗口 = 最小化到托盘（服务端继续在后台推流），
  // 真正退出只能通过托盘右键「退出 LanPlay」或菜单。
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!tray) buildTray();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次启动 LanPlay.exe 时唤起已有实例的窗口（窗口可能正 hide 在托盘里，
    // 必须用 showWindow() 做 restore+show+focus，单 focus() 对隐藏窗口无效）
    showWindow();
  });

  app.whenReady().then(async () => {
    server = new LanPlayServer({
      rootDir,
      guiDir: path.join(__dirname, '..', 'gui'),
      version: app.getVersion(),
      hooks: {
        app,
        pickFolder: async () => {
          const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
          return result.canceled ? [] : result.filePaths;
        },
        pickFiles: async () => {
          const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile', 'multiSelections'],
            filters: [
              { name: '媒体文件', extensions: ['mkv', 'mp4', 'avi', 'mov', 'm2ts', 'ts', 'flv', 'wmv', 'webm', 'mp3', 'flac', 'm4a'] },
              { name: '所有文件', extensions: ['*'] }
            ]
          });
          return result.canceled ? [] : result.filePaths;
        },
        quit: () => app.quit()
      }
    });
    try {
      await server.start();
      createWindow(server.port);
      buildTray();
    } catch (err) {
      if (server && server.logger) server.logger.error(`启动失败：${err.message}`);
      dialog.showErrorBox('LanPlay 启动失败', err.stack || err.message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    // 窗口关闭只是收进托盘，不退出进程（托盘菜单里才有「退出」）
    if (quitting) app.quit();
  });

  app.on('activate', () => { showWindow(); });

  app.on('before-quit', async (e) => {
    // 退出前必须让转码进程与监听端口有序释放，否则残留 ffmpeg.exe
    if (stopped) return;
    e.preventDefault();
    quitting = true;
    stopped = true;
    try { if (server) await server.stop(); } catch (_) { /* ignore */ }
    app.exit(0);
  });
}

ipcMain.handle('lanplay:info', () => ({
  rootDir,
  port: server ? server.port : 0,
  version: app.getVersion()
}));

ipcMain.handle('lanplay:openExternal', (e, url) => shell.openExternal(url));

ipcMain.handle('lanplay:openPath', (e, p) => shell.openPath(p));

ipcMain.handle('lanplay:showItemInFolder', (e, p) => shell.showItemInFolder(p));
