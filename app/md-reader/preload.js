/* Academy MD Reader · preload：极窄通道，不给页面 Node 权限 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('academyReader', {
  onLoad: (cb) => ipcRenderer.on('reader:load', (_e, d) => cb(d)),
  onEmpty: (cb) => ipcRenderer.on('reader:empty', () => cb()),
  copyText: (text) => ipcRenderer.invoke('reader:copyText', text),
  saveWord: (payload) => ipcRenderer.invoke('reader:saveWord', payload),
  openInAcademy: (filePath) => ipcRenderer.invoke('reader:openInAcademy', filePath),
});
