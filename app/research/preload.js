'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('academyResearch', {
  init: () => ipcRenderer.invoke('research:init'),
  saveOpts: (patch) => ipcRenderer.invoke('research:saveOpts', patch),
  /* 转发到主 App 服务器的通用请求：{method, path, body} */
  proxy: (payload) => ipcRenderer.invoke('research:proxy', payload),
  copyText: (text) => ipcRenderer.invoke('research:copyText', text),
  setTitle: (t) => ipcRenderer.invoke('research:setTitle', t),
});
