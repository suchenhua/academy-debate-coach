#!/usr/bin/env node
/*
 * pdf-worker.js — 极简 Electron 打印 worker：md/txt/csv → PDF（A4，本地打印）
 *
 * 用法：electron.exe app/pdf-worker.js --in <输入文件> --out <输出.pdf> [--title 标题]
 * 读入文本文件，用 md-view 渲染成 HTML，隐藏窗口 printToPDF 落盘。
 * 供「产物空间」DELIVER 协议把 Agent 的文本产物转成 PDF。
 *
 * 排版规范与 docx.js 同源（移植自 debate-toolbox 的 python-docx 排版）：
 *   微软雅黑、页边距上下 2cm 左右 2.5cm、页脚「x / y」页码、
 *   表格行与代码块跨页保护、标题不与正文断页。
 * 通过临时 HTML 文件装载（data: URL 有长度上限，超长文档会截断）。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const parseArg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
};
const IN = parseArg('--in');
const OUT = parseArg('--out');
const TITLE = parseArg('--title') || (IN ? path.basename(IN).replace(/\.[^.]+$/, '') : '产物');

app.whenReady().then(async () => {
  let tmpHtml = '';
  try {
    if (!IN || !OUT) throw new Error('缺少 --in / --out');
    // 用 md-view 渲染（浏览器式模块：挂 window 再 require）
    const mdViewPath = path.join(__dirname, 'md-reader', 'md-view.js');
    global.window = global;
    require(mdViewPath);
    const text = fs.readFileSync(IN, 'utf8');
    const html = window.MDView ? window.MDView.mdToHtml(text) : '<pre>' + String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>';
    const doc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' +
      String(TITLE).replace(/[<>&"]/g, '') +
      '</title><style>' +
      'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;margin:0;color:#1c2434;line-height:1.6;font-size:14.5px;background:#fff}' +
      // 强制浅色：系统深色主题下 printBackground 会把底色打黑
      'html{color-scheme:light}' +
      'h1{font-size:1.6em;color:#1F3864}' +
      'h2{font-size:1.35em;color:#2F5496}' +
      'h3{font-size:1.15em;color:#333}' +
      'h1,h2,h3{border-bottom:1px solid #e5e7ee;padding-bottom:.3em;margin-top:1.4em;page-break-after:avoid}' +
      'p{margin:.6em 0;orphans:2;widows:2}' +
      'pre{background:#f5f7fb;padding:12px;border-radius:6px;overflow:hidden;font-size:12px;white-space:pre-wrap;word-break:break-all;page-break-inside:avoid}' +
      'code{background:#f0f2f7;padding:1px 5px;border-radius:4px;font-size:.92em}' +
      'blockquote{border-left:3px solid #8496B0;margin:8px 0;padding:2px 14px;color:#445066}' +
      'table{border-collapse:collapse;margin:10px 0;width:100%}' +
      'tr{page-break-inside:avoid}' +
      'th,td{border:1px solid #d5dae6;padding:5px 10px}' +
      'th{background:#eef1f8}' +
      'ul,ol{margin:.5em 0;padding-left:1.6em}li{margin:.25em 0}' +
      'a{color:#0563C1}' +
      '</style></head><body>' + html + '</body></html>';

    tmpHtml = path.join(os.tmpdir(), 'academy-pdf-' + Date.now() + '.html');
    fs.writeFileSync(tmpHtml, doc, 'utf8');

    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await win.loadURL('file://' + tmpHtml.replace(/\\/g, '/'));
    // 页边距（英寸）：上下 2cm≈0.79，左右 2.5cm≈0.98；页码在页脚边距区渲染
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#8A93A6;font-family:\'Microsoft YaHei\',sans-serif">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margins: { top: 0.79, bottom: 0.79, left: 0.98, right: 0.98 },
    });
    fs.writeFileSync(OUT, pdf);
    console.log('OK ' + OUT);
    if (!win.isDestroyed()) win.destroy();
  } catch (e) {
    console.error('ERR ' + (e && e.message));
    process.exitCode = 1;
  } finally {
    if (tmpHtml) { try { fs.unlinkSync(tmpHtml); } catch (_) {} }
    app.quit();
  }
});
