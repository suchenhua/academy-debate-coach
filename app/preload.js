/* Academy 辩论教练 · Electron preload
 * 暴露极小通道：PDF 导出 + 本地文件打开/读取（MD 阅读器用），不给网页 Node 权限。 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('academyElectron', {
  exportPdf: (html, title) => ipcRenderer.invoke('pdf:export', { html, title }),
  /* 静默转 PDF：渲染 HTML 后直接落到产物空间 data/deliverables/，不弹保存框 */
  exportPdfSilent: (html, name) => ipcRenderer.invoke('pdf:export-silent', { html, name }),
  /* 打开系统文件对话框选 .md，返回 { path, name, text } 或 { canceled:true } */
  openMarkdownFile: () => ipcRenderer.invoke('md:open'),
  /* 直接读取给定文件路径（已由主进程校验扩展名/大小） */
  readMarkdownFile: (filePath) => ipcRenderer.invoke('md:read', filePath),
  /* 内置阅读器：把编辑内容写回原文件（force=true 忽略外部修改冲突） */
  saveMarkdownFile: (payload) => ipcRenderer.invoke('md:save', payload),
  /* 保存备份文件（弹保存对话框） */
  saveBackupFile: (jsonText, defaultName) => ipcRenderer.invoke('backup:save', { jsonText, defaultName }),
  /* 产物空间：把文件另存到用户选择的任意路径（文本或二进制） */
  saveDeliverable: ({ name, text, base64 }) => ipcRenderer.invoke('deliverable:saveAs', { name, text, base64 }),
  showDeliverFolder: (fileName) => ipcRenderer.invoke('deliverable:folder', fileName),
  /* 在文件管理器中显示导出的备份文件 */
  showInFolder: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
  /* 打开「研究台」独立轻量窗 */
  openResearch: () => ipcRenderer.invoke('app:openResearch'),
  /* 选择备份文件并读取内容 */
  openBackupFile: () => ipcRenderer.invoke('backup:open'),
  /* 收到"用此 App 打开某文件"（文件关联双击）时触发 */
  onOpenFileRequest: (cb) => {
    ipcRenderer.on('md:open-request', (_evt, filePath) => cb(filePath));
  },
});
