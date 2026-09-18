#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · 独立工具窗（通用轻量壳）
 *
 * 研究台验证了「独立小窗」这条路好走之后，证据检证 / 资料溯源
 * 也各自独立成了工具。三个窗的骨架完全一样（探端口 → preload 代理
 * → 复制 / 标题 / 设置持久化），只差标题和渲染目录——
 * 所以抽成一个通用壳，按 --tool 参数加载对应目录，不再克隆三份。
 *   --tool=verify → app/verify/   🛡 证据检证
 *   --tool=trace  → app/trace/    📚 资料溯源
 * 研究台（app/research-window.js）是先出生的前辈，本轮没动它的骨架；
 * 等下次动它时应该也迁到这个壳上来。
 *
 * 通信：IPC → 主进程 http.request 转发到 http://127.0.0.1:<主App端口>
 *（不经页面 fetch：避免 file:// 的 CORS 问题，也让服务端来源校验能放行本机窗口）。
 * 主 App 未运行时给出明确提示，不影响窗口打开。
 *
 * 用法：electron.exe app/tool-window.js --tool=verify
 * ----------------------------------------------- */
'use strict';

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.ACADEMY_DATA_DIR ? path.resolve(process.env.ACADEMY_DATA_DIR) : path.join(ROOT, 'data');
const ICON = path.join(ROOT, 'appicon.ico');
const DEFAULT_PORT = 8787;

/* 工具注册表：加新工具只需要在这里登记一行 */
const TOOLS = {
  verify: {
    title: '🛡 证据检证 · Academy 辩论教练',
    dir: path.join(__dirname, 'verify'),
    width: 860, height: 720,
  },
  trace: {
    title: '📚 资料溯源 · Academy 辩论教练',
    dir: path.join(__dirname, 'trace'),
    width: 860, height: 720,
  },
};
const TOOL_ID = (process.argv.find((a) => a.startsWith('--tool=')) || '').split('=')[1] || '';
const T = TOOLS[TOOL_ID];
if (!T) {
  console.error('未知工具：' + TOOL_ID + '（可选：' + Object.keys(TOOLS).join(' / ') + '）');
  app.quit();
}

const R_HTML = path.join(T.dir, 'renderer.html');
const OPTS_FILE = path.join(DATA_DIR, 'tool-options-' + TOOL_ID + '.json');
const LOG_FILE = path.join(DATA_DIR, 'tool-' + TOOL_ID + '-launch.log');

app.setName('Academy Tool · ' + TOOL_ID);
try { app.setPath('userData', path.join(DATA_DIR, 'electron-user-data-tool-' + TOOL_ID)); } catch (_) {}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) {}
}

/* 共享设置：窗口尺寸 / 最近输入 */
function defaultOpts() { return { width: T.width, height: T.height, lastInput: '' }; }
function loadOpts() {
  try { return Object.assign(defaultOpts(), JSON.parse(fs.readFileSync(OPTS_FILE, 'utf8'))); }
  catch (_) { return defaultOpts(); }
}
function saveOpts(patch) {
  const next = Object.assign(loadOpts(), patch || {});
  try { fs.writeFileSync(OPTS_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch (_) {}
  return next;
}

/* 转发到主 App 服务器的 HTTP 请求 */
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
    width: opts.width || T.width,
    height: opts.height || T.height,
    minWidth: 640,
    minHeight: 480,
    title: T.title,
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    show: false,
    backgroundColor: '#f4f6fb',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'tool-preload.js'),
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
ipcMain.handle('tool:init', async () => {
  const ports = [DEFAULT_PORT, 8788, 8789, 8790, 8791, 8792];
  const probe = await probeServer(ports);
  serverPort = probe.ok ? probe.port : 0;
  const opts = loadOpts();
  return {
    ok: probe.ok,
    port: serverPort,
    tool: TOOL_ID,
    opts: { lastInput: opts.lastInput || '' },
    error: probe.ok ? '' : '主 App 没在运行：本工具需要主 App 提供搜索与模型服务。请先启动 Academy 辩论教练。',
  };
});
ipcMain.handle('tool:saveOpts', (_e, patch) => { saveOpts(patch || {}); return { ok: true }; });
ipcMain.handle('tool:proxy', (_e, payload) => proxyFetch(serverPort, payload || {}));
ipcMain.handle('tool:copyText', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
ipcMain.handle('tool:setTitle', (_e, t) => { if (win && !win.isDestroyed()) win.setTitle((t ? t + ' · ' : '') + T.title); return { ok: true }; });
/* 工具窗之间互相跳转（检证 ↔ 溯源）：spawn 一个新的独立进程 */
ipcMain.handle('tool:openTool', (_e, payload) => {
  try {
    const name = String((payload || {}).name || '');
    if (!TOOLS[name]) return { ok: false, error: '未知工具：' + name };
    const { spawn } = require('child_process');
    spawn(process.execPath, [__filename, '--tool=' + name], { cwd: ROOT, windowsHide: false, stdio: 'ignore', detached: true }).unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* 单实例：每个工具一个实例锁（不同工具互不冲突） */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.whenReady().then(() => {
  log('工具窗启动: ' + TOOL_ID);
  createWindow();
}).catch((e) => log('whenReady 失败: ' + e.message));

app.on('window-all-closed', () => { app.quit(); });
