/* Academy MD Reader · preload：极窄通道，不给页面 Node 权限 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('academyReader', {
  onLoad: (cb) => ipcRenderer.on('reader:load', (_e, d) => cb(d)),
  onEmpty: (cb) => ipcRenderer.on('reader:empty', () => cb()),
  copyText: (text) => ipcRenderer.invoke('reader:copyText', text),
  saveWord: (payload) => ipcRenderer.invoke('reader:saveWord', payload),
  openInAcademy: (filePath) => ipcRenderer.invoke('reader:openInAcademy', filePath),
  /* 编辑：写回原文件（force=true 忽略外部修改冲突） */
  save: (payload) => ipcRenderer.invoke('reader:save', payload),
  /* 同步「有未保存修改」标记，供主进程做标题标记与关窗拦截 */
  setDirty: (dirty) => ipcRenderer.invoke('reader:setDirty', dirty),
  /* 主进程在「保存并关闭」时触发 */
  onSaveAndClose: (cb) => ipcRenderer.on('reader:save-and-close', () => cb()),
  /* 保存完成后由我们回调主进程真正关窗 */
  closeNow: () => ipcRenderer.invoke('reader:closeNow'),
});
