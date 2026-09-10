#!/usr/bin/env node
/*
 * pdf-worker.js — 极简 Electron 打印 worker：md/txt/csv → PDF（A4，本地打印）
 *
 * 用法：electron.exe app/pdf-worker.js --in <输入文件> --out <输出.pdf> [--title 标题]
 * 读入文本文件，用 md-view 渲染成简单 HTML，隐藏窗口 printToPDF 落盘。
 * 供「产物空间」DELIVER 协议把 Agent 的文本产物转成 PDF。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const parseArg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
};
const IN = parseArg('--in');
const OUT = parseArg('--out');
const TITLE = parseArg('--title') || (IN ? path.basename(IN).replace(/\.[^.]+$/, '') : '产物');

app.whenReady().then(async () => {
  try {
    if (!IN || !OUT) throw new Error('缺少 --in / --out');
    // 用 md-view 渲染（浏览器式模块：挂 window 再 require）
    const mdViewPath = path.join(__dirname, 'md-reader', 'md-view.js');
    global.window = global;
    require(mdViewPath);
    const text = fs.readFileSync(IN, 'utf8');
    const html = window.MDView ? window.MDView.mdToHtml(text) : '<pre>' + String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
    const doc = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' +
      String(TITLE).replace(/[<>&"]/g, '') +
      '</title><style>body{font-family:"Microsoft YaHei",simhei,sans-serif;margin:34px;color:#1c2434;line-height:1.75;font-size:14px}' +
      'h1{font-size:1.5em}h1,h2,h3{border-bottom:1px solid #e5e7ee;padding-bottom:.3em;margin-top:1.2em}' +
      'pre{background:#f5f7fb;padding:12px;border-radius:6px;overflow:auto;font-size:12px}' +
      'code{background:#f0f2f7;padding:1px 5px;border-radius:4px}' +
      'blockquote{border-left:3px solid #d5dae6;margin:8px 0;padding:2px 14px;color:#5b6b7b}' +
      'table{border-collapse:collapse;margin:10px 0}th,td{border:1px solid #d5dae6;padding:5px 10px}' +
      'th{background:#eef1f8}a{color:#1f5eff}</style></head><body>' + html + '</body></html>';

    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc));
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    fs.writeFileSync(OUT, pdf);
    console.log('OK ' + OUT);
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  } catch (e) {
    console.error('ERR ' + (e && e.message));
    app.quit();
    process.exitCode = 1;
  }
});
