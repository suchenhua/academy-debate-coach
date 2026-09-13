#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · 研究台（独立轻量窗）
 *
 * 「一边查资料，一边和教练交流」：独立小窗，与主 App 并排使用。
 *  - 左上：辩题/关键词搜索（端侧免费 / 服务侧模型商）
 *  - 中：按 7 种触发条件生成的建议搜索词 + 搜索结果
 *  - 下：与教练的独立对话线程（研究专用小助手，走主 App 的 /api/chat/stream）
 *
 * 通信：IPC → 主进程 http.request 转发到 http://127.0.0.1:<主App端口>
 *（不经页面 fetch：避免 file:// 的 CORS 问题，也让服务端来源校验能放行本机窗口）。
 * 主 App 未运行时给出明确提示，不影响阅读类功能。
 *
 * 用法：electron.exe app/research-window.js [--topic "辩题"]
 * ----------------------------------------------- */
'use strict';

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const R_HTML = path.join(__dirname, 'research', 'renderer.html');
const R_PRELOAD = path.join(__dirname, 'research', 'preload.js');
const ICON = path.join(ROOT, 'appicon.ico');
const LOG_FILE = path.join(DATA_DIR, 'research-launch.log');
const OPTS_FILE = path.join(DATA_DIR, 'research-options.json');
const DEFAULT_PORT = 8787;

app.setName('Academy Research');
try { app.setPath('userData', path.join(DATA_DIR, 'electron-user-data-research')); } catch (_) {}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) {}
}

/* 共享设置：窗口尺寸 / 通道记忆 / 最近辩题 */
function defaultOpts() { return { width: 1080, height: 780, mode: 'server', lastTopic: '' }; }
/* 老版本默认存的是 free。升级到本版时把未主动选过 server 的一律按新默认 server 处理
   （free 效果实测很差：常被反爬返回无关结果），可随时手动切回。 */
function loadOpts() {
  try {
    const raw = JSON.parse(fs.readFileSync(OPTS_FILE, 'utf8'));
    const opts = Object.assign(defaultOpts(), raw);
    if (!raw || raw.mode !== 'server') opts.mode = 'server';
    return opts;
  } catch (_) { return defaultOpts(); }
}
function saveOpts(patch) {
  const next = Object.assign(loadOpts(), patch || {});
  try { fs.writeFileSync(OPTS_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch (_) {}
  return next;
}

/* 转发到主 App 服务器的 HTTP 请求（避免 file:// 页面的 CORS 与混合内容问题） */
function proxyFetch(port, { method = 'GET', path: reqPath = '/', body = null, timeout = 240000 }) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Accept': 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers, timeout }, (r2) => {
      let buf = '';
      r2.on('data', (c) => { buf += c; });
      r2.on('end', () => resolve({ status: r2.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', (e) => resolve({ status: 0, body: JSON.stringify({ ok: false, error: e.message }) }));
    if (data) req.write(data);
    req.end();
  });
}

/* 探测主 App 在哪个端口（8787 是默认；被占用时 server.js 会自动换端口，所以多试几个） */
function probeServer(ports) {
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= ports.length) return resolve({ ok: false, error: '主 App 未运行' });
      const port = ports[i++];
      proxyFetch(port, { path: '/api/ping', timeout: 3000 }).then((r) => {
        if (r.status === 200 && r.body.indexOf('"ok"') !== -1) return resolve({ ok: true, port });
        setTimeout(tryNext, 10);
      });
    };
    tryNext();
  });
}

let serverPort = 0;
let win = null;

function createWindow() {
  const opts = loadOpts();
  win = new BrowserWindow({
    width: opts.width || 1080,
    height: opts.height || 780,
    minWidth: 720,
    minHeight: 480,
    title: '🔍 研究台 · Academy 辩论教练',
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    show: false,
    backgroundColor: '#f4f6fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: R_PRELOAD,
    },
  });
  win.loadFile(R_HTML).catch(() => {});
  win.once('ready-to-show', () => win.show());
  win.on('resize', () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const [width, height] = win.getSize();
    saveOpts({ width, height });
  });
  win.on('closed', () => { win = null; });
  return win;
}

/* ---- IPC ---- */
ipcMain.handle('research:init', async () => {
  const ports = [DEFAULT_PORT, 8788, 8789, 8790, 8791, 8792];
  const probe = await probeServer(ports);
  serverPort = probe.ok ? probe.port : 0;
  const opts = loadOpts();
  return {
    ok: probe.ok,
    port: serverPort,
    opts: { mode: opts.mode, lastTopic: opts.lastTopic || '' },
    error: probe.ok ? '' : '主 App 没在运行：研究台需要主 App 提供搜索与对话服务。请先启动 Academy 辩论教练。',
  };
});
ipcMain.handle('research:saveOpts', (_e, patch) => { saveOpts(patch || {}); return { ok: true }; });
ipcMain.handle('research:proxy', (_e, payload) => proxyFetch(serverPort, payload || {}));
ipcMain.handle('research:copyText', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
ipcMain.handle('research:setTitle', (_e, t) => { if (win && !win.isDestroyed()) win.setTitle(t || '🔍 研究台 · Academy 辩论教练'); return { ok: true }; });

/* 单实例：重复打开只是聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.whenReady().then(() => {
  log('研究台启动');
  createWindow();
}).catch((e) => log('whenReady 失败: ' + e.message));

app.on('window-all-closed', () => { app.quit(); });
