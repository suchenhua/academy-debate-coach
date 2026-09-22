#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · 独立工具窗（通用轻量壳）
 *
 * 「一边查资料，一边和教练交流」这类独立小窗，骨架都是同一套
 *（探端口 → preload 代理 → 复制 / 标题 / 设置持久化），只差标题和渲染目录。
 * 所以统一走这个壳，按 --tool 参数加载 tool-registry.js 里登记的目录：
 *   --tool=research → app/research/  🔍 研究台
 *   --tool=verify   → app/verify/    🛡 证据检证
 *   --tool=trace    → app/trace/     📚 资料溯源
 * 加新工具 = 在 app/tool-registry.js 登记一行 + 写渲染目录，本文件不用动。
 *
 * 通信：IPC → 主进程 http.request 转发到 http://127.0.0.1:<主App端口>
 *（不经页面 fetch：避免 file:// 的 CORS 问题，也让服务端来源校验能放行本机窗口）。
 * 主 App 未运行时给出明确提示，不影响窗口打开。
 *
 * 用法：electron.exe app/tool-window.js --tool=research [--port=8787]
 * ----------------------------------------------- */
'use strict';

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { TOOLS } = require('./tool-registry');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.ACADEMY_DATA_DIR ? path.resolve(process.env.ACADEMY_DATA_DIR) : path.join(ROOT, 'data');
const ICON = path.join(ROOT, 'appicon.ico');
const DEFAULT_PORT = 8787;

/* 工具清单见 app/tool-registry.js —— 那里是唯一来源 */
const TOOL_ID = (process.argv.find((a) => a.startsWith('--tool=')) || '').split('=')[1] || '';
const T = TOOLS[TOOL_ID];
if (!T) {
  console.error('未知工具：' + TOOL_ID + '（可选：' + Object.keys(TOOLS).join(' / ') + '）');
  app.quit();
}

const R_HTML = path.join(T.dir, 'renderer.html');
/* 主窗口 spawn 时会带 --port=（它知道自己 server 的确切端口）；
   没带才退回端口探测 —— 探测区间里有另一条线的服务时会连错。 */
const PORT_ARG = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 0;
const OPTS_FILE = path.join(DATA_DIR, 'tool-options-' + TOOL_ID + '.json');
const LOG_FILE = path.join(DATA_DIR, 'tool-' + TOOL_ID + '-launch.log');

app.setName('Academy Tool · ' + TOOL_ID);
try { app.setPath('userData', path.join(DATA_DIR, 'electron-user-data-tool-' + TOOL_ID)); } catch (_) {}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) {}
}

/* 共享设置：窗口尺寸 + 各工具自己的字段（注册表 defaults 声明） */
function defaultOpts() { return Object.assign({ width: T.width, height: T.height }, T.defaults); }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function loadOpts() {
  const raw = readJson(OPTS_FILE) || readLegacyOpts();
  const opts = Object.assign(defaultOpts(), raw || {});
  if (T.migrateOpts) T.migrateOpts(raw, opts);
  return opts;
}
/* 一次性搬家：各窗独立时代的存档名与壳的 tool-options-<id>.json 不同，
   不接上就会把用户已存的窗口尺寸、最近输入清零。读到就地落成新名，下次不用再翻旧文件。 */
function readLegacyOpts() {
  if (!T.legacyOptsFile) return null;
  const raw = readJson(path.join(DATA_DIR, T.legacyOptsFile));
  if (raw) { try { fs.writeFileSync(OPTS_FILE, JSON.stringify(Object.assign(defaultOpts(), raw), null, 2), 'utf8'); } catch (_) {} }
  return raw;
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
    minWidth: T.minWidth || 640,
    minHeight: T.minHeight || 480,
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
  const ports = PORT_ARG > 0 ? [PORT_ARG] : [DEFAULT_PORT, 8788, 8789, 8790, 8791, 8792];
  const probe = await probeServer(ports);
  serverPort = probe.ok ? probe.port : 0;
  const opts = loadOpts();
  return {
    ok: probe.ok,
    port: serverPort,
    tool: TOOL_ID,
    opts: T.initOpts(opts),
    error: probe.ok ? '' : T.offlineHint,
  };
});
ipcMain.handle('tool:saveOpts', (_e, patch) => { saveOpts(patch || {}); return { ok: true }; });
ipcMain.handle('tool:proxy', (_e, payload) => proxyFetch(serverPort, payload || {}));
ipcMain.handle('tool:copyText', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
ipcMain.handle('tool:setTitle', (_e, t) => { if (win && !win.isDestroyed()) win.setTitle((t ? t + ' · ' : '') + T.title); return { ok: true }; });
/* 工具窗之间互相跳转（研究台 → 检证 ↔ 溯源）：spawn 一个新的独立进程。
   本进程已经知道自己连的是哪个端口，一并带过去 ——
   不带的目标窗会退回盲探 8787~8792，双开时可能连到另一条线的 server（09-19 事故同款）。 */
ipcMain.handle('tool:openTool', (_e, payload) => {
  try {
    const name = String((payload || {}).name || '');
    if (!TOOLS[name]) return { ok: false, error: '未知工具：' + name };
    const args = [__filename, '--tool=' + name];
    if (serverPort > 0) args.push('--port=' + serverPort);
    const { spawn } = require('child_process');
    spawn(process.execPath, args, { cwd: ROOT, windowsHide: false, stdio: 'ignore', detached: true }).unref();
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
