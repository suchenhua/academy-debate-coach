'use strict';
/* 独立工具窗共用 preload（证据检证 / 资料溯源……见 tool-window.js 的 TOOLS 注册表） */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('academyTool', {
  init: () => ipcRenderer.invoke('tool:init'),
  saveOpts: (patch) => ipcRenderer.invoke('tool:saveOpts', patch),
  /* 转发到主 App 服务器的通用请求：{method, path, body} */
  proxy: (payload) => ipcRenderer.invoke('tool:proxy', payload),
  copyText: (text) => ipcRenderer.invoke('tool:copyText', text),
  setTitle: (t) => ipcRenderer.invoke('tool:setTitle', t),
  /* 工具窗之间互相跳转：openTool({ name: 'verify' | 'trace' }) */
  openTool: (name) => ipcRenderer.invoke('tool:openTool', { name }),
});
