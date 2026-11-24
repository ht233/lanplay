'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lanplay', {
  info: () => ipcRenderer.invoke('lanplay:info'),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
  },
  openExternal: (url) => ipcRenderer.invoke('lanplay:openExternal', url),
  openPath: (p) => ipcRenderer.invoke('lanplay:openPath', p),
  showItemInFolder: (p) => ipcRenderer.invoke('lanplay:showItemInFolder', p),
  onReady: (cb) => ipcRenderer.on('lanplay:ready', (e, data) => cb(data))
});
