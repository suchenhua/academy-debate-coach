#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · Electron 桌面版主进程
 *
 * 用 Electron（自带 Chromium）把本地 Web 应用封装成
 * 独立桌面窗口：无浏览器标签栏/地址栏；关窗行为可配
 *（直接退出 / 最小化到托盘，见设置 → 通用 → 关闭窗口时）。
 *
 * 流程：
 *   1. 若本地 server 还没起来，用内置 node 隐藏启动 server.js
 *      （ACADEMY_NO_OPEN=1，不让 server 自己开浏览器）；
 *   2. 等待 http://127.0.0.1:<port> 就绪；
 *   3. 创建 Electron 窗口加载该地址；
 *   4. 窗口关闭 = 退出程序，并清理由本进程拉起的 server。
 *
 * 用法：runtime\electron\dist\electron.exe app\electron-main.js
 * ----------------------------------------------- */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray } = require('electron');
const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { TOOLS } = require('./tool-registry');
const { SELF: INSTANCE_ROOT } = require('./instance-id');

const ROOT = path.resolve(__dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const SERVER = path.join(ROOT, 'app', 'server.js');
/* 与 server.js 同一口径：ACADEMY_DATA_DIR 把用户数据整体指到别处（测试/巡检用）。
   主进程要是写死 ROOT/data，隔离数据目录跑测试时就会读到另一份 config.json。 */
const DATA_DIR = process.env.ACADEMY_DATA_DIR ? path.resolve(process.env.ACADEMY_DATA_DIR) : path.join(ROOT, 'data');
const ICON = path.join(ROOT, 'appicon.ico');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'electron-launch.log');
const WINDOW_TITLE = 'Academy 辩论教练 · 逻敏';

const DEFAULT_PORT = 8787;

// 支持文件关联启动：electron.exe electron-main.js --open "C:\xx\yy.md"
// 这里只取原始串，真正的清洗交给 normalizeOpenPath / pickOpenFile（避免用到后面才初始化的常量）
const OPEN_ARG = (() => {
  const idx = process.argv.indexOf('--open');
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
})();
const PORT = Number(process.env.ACADEMY_PORT || DEFAULT_PORT);
const START_TIMEOUT = 45 * 1000;

// 把 Electron 自己产生的缓存/会话数据隔离到 App 内 data/electron-user-data，
// 不写系统 AppData、不污染用户环境，也方便绿色移动整个文件夹。
app.setName('Academy Debate Coach');
try { app.setPath('userData', path.join(DATA_DIR, 'electron-user-data')); } catch (_) {}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
}

/* 探测某个端口上有没有 server。
   wantRoot 传本副本指纹时，只有「同一个安装目录」的 server 才算命中 ——
   不能只看「端口上有服务就复用」：那正是多副本串台（点哪个快捷方式都是同一个版本）的根因。
   wantRoot 传空时退化为「只看有没有本 App 的服务」，用来判断端口是否被别的副本占着。 */
function isServerUp(port, timeoutMs, wantRoot) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/status', timeout: timeoutMs || 1200,
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200 || body.indexOf('"version"') === -1) return resolve(false);
        if (!wantRoot) return resolve(true);
        let info = null;
        try { info = JSON.parse(body); } catch (_) {}
        /* 老版本 server（不上报 instanceRoot）一律视为「不是自己」：
           宁可自己另起一个，也不复用身份不明的实例。 */
        resolve(!!info && info.instanceRoot === wantRoot);
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* 从 startPort 起挑一个端口：
   - 命中本副本已在跑的 server → 复用它
   - 端口上站着别的副本的本 App 服务 → 跳过，换下一个（否则会显示成别人的界面）
   - 端口没人应答（空着，或被非本 App 的服务占着）→ 就用它，真正的占用竞争由 server.js 的
     EADDRINUSE 自增兜底；挪到哪去了由 waitServerUp 扫端口找回来，不再死盯请求的那个端口。 */
async function resolveOwnPort(startPort, span) {
  const end = startPort + (span || 20);
  for (let p = startPort; p < end; p++) {
    if (await isServerUp(p, 500, INSTANCE_ROOT)) return { port: p, reuse: true };
    if (await isServerUp(p, 350, '')) continue;
    return { port: p, reuse: false };
  }
  return { port: startPort, reuse: false };
}

/* 等本副本的 server 就绪，返回实际端口（0 = 超时）。
   必须扫一段：server.js 撞 EADDRINUSE 会自己 +1，端口未必还是我们请求的那个。 */
async function waitServerUp(port, timeoutMs, span) {
  const deadline = Date.now() + timeoutMs;
  const end = port + (span || 20);
  let i = 0;
  while (Date.now() < deadline) {
    // 前 25 次用很短间隔：server 现在「先能响应、再做后台维护」，通常几十毫秒就绪；
    // 固定的 400ms 轮询会白白多等一拍才开窗。
    for (let p = port; p < end; p++) {
      if (await isServerUp(p, i < 25 ? 500 : 800, INSTANCE_ROOT)) return p;
    }
    await new Promise((r) => setTimeout(r, i < 25 ? 60 : 400));
    i++;
  }
  return 0;
}

/* 静默注册 .md 关联（HKCU，幂等无副作用；失败不影响主流程）
   注意：必须用 spawn 传参数数组，不能用 exec('reg add ... /d "..."')，
   否则 cmd.exe 会把 %1 两侧的引号吃掉，导致含空格的路径被拆成多个参数。 */
function regSet(key, valueName, data) {
  try {
    const args = ['add', key];
    if (valueName) args.push('/v', valueName); else args.push('/ve');
    args.push('/t', 'REG_SZ', '/d', data, '/f');
    const p = spawn('reg', args, { windowsHide: true, stdio: 'ignore' });
    if (p && typeof p.unref === 'function') p.unref();
    return true;
  } catch (_) { return false; }
}

function registerFileAssoc() {
  try {
    if (process.platform !== 'win32') return false;
    const exePath = process.execPath; // electron.exe 完整路径
    // .md / .txt / .srt 一律交给「轻量阅读器」自带的独立小窗，避免看个文件就要开整套 App
    const reader = path.join(__dirname, 'md-reader-window.js');
    const ico = path.join(ROOT, 'appicon.ico');
    const openCmd = '"' + exePath + '" "' + reader + '" --md "%1"';
    regSet('HKCU\\Software\\Classes\\.md', '', 'AcademyMD.md');
    regSet('HKCU\\Software\\Classes\\.md\\OpenWithProgids', 'AcademyMD.md', '');
    regSet('HKCU\\Software\\Classes\\.markdown', '', 'AcademyMD.md');
    regSet('HKCU\\Software\\Classes\\.markdown\\OpenWithProgids', 'AcademyMD.md', '');
    regSet('HKCU\\Software\\Classes\\.txt', 'AcademyMD.txt\\OpenWithProgids', ''); // 占位保底（不抢默认）
    regSet('HKCU\\Software\\Classes\\AcademyMD.md', '', 'Academy MD Document');
    regSet('HKCU\\Software\\Classes\\AcademyMD.md\\DefaultIcon', '', ico);
    regSet('HKCU\\Software\\Classes\\AcademyMD.md\\shell\\open\\command', '', openCmd);
    regSet('HKCU\\Software\\Classes\\AcademyMD.txt', '', 'Academy TXT Document');
    regSet('HKCU\\Software\\Classes\\AcademyMD.txt\\DefaultIcon', '', ico);
    regSet('HKCU\\Software\\Classes\\AcademyMD.txt\\shell\\open\\command', '', openCmd);
    // .srt 走 OpenWith（只加到一个打开方式，不覆盖用户的默认播放/记事本）
    regSet('HKCU\\Software\\Classes\\AcademyMD.srt', '', 'Academy SRT Document');
    regSet('HKCU\\Software\\Classes\\AcademyMD.srt\\DefaultIcon', '', ico);
    regSet('HKCU\\Software\\Classes\\AcademyMD.srt\\shell\\open\\command', '', openCmd);
    return true;
  } catch (_) { return false; }
}

function startServer(port) {
  return spawn(NODE, [SERVER], {
    env: Object.assign({}, process.env, {
      ACADEMY_NO_OPEN: '1',
      ACADEMY_PORT: String(port),
    }),
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
  });
}

function killTree(pid) {
  try { process.kill(pid); } catch (_) {}
  try {
    exec('taskkill /PID ' + pid + ' /T /F', { windowsHide: true }, () => {});
  } catch (_) {}
}

let serverChild = null;
let owned = false;
let mainWindow = null;
/* 本实例最终使用的 server 端口（whenReady 里确定）。
   spawn 独立工具窗/研究台时带上确切端口 —— 不带的话它们自己探端口，
   8787~8792 区间里可能有另一条线（Pro/Flash 双开）的服务，会连错。 */
let serverPort = 0;

/* —— 关闭窗口行为（设置 → 通用 → 关闭窗口时）——
   quit：点关闭 = 退出整个应用（默认，沿用历史行为）；tray：窗口收进系统托盘，server 继续跑。
   主进程直接读 data/config.json：改完立刻生效、不必重启，也不必给 server 加新接口。 */
let tray = null;
let trayHintShown = false;
let allowClose = false;   // 已经落过盘、放行真正关闭
let isQuitting = false;   // 退出意图已确立（托盘菜单/系统退出/僵尸自清），此后再来的 close 不再改判成隐藏

function uiGeneral() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  return {
    closeBehavior: cfg.closeBehavior === 'tray' ? 'tray' : 'quit',
    locale: ['zh-CN', 'zh-TW', 'en'].includes(cfg.locale) ? cfg.locale : 'zh-CN',
  };
}

const TRAY_TEXT = {
  'zh-CN': { show: '显示主窗口', quit: '退出', hint: '已最小化到托盘', hintBody: '点托盘图标唤回窗口，右键托盘图标可退出。' },
  'zh-TW': { show: '顯示主視窗', quit: '結束', hint: '已最小化到托盤', hintBody: '點托盤圖示喚回視窗，右鍵托盤圖示可結束。' },
  en: { show: 'Show window', quit: 'Quit', hint: 'Minimised to the tray', hintBody: 'Click the tray icon to restore the window, right-click it to quit.' },
};
const trayText = (key) => (TRAY_TEXT[uiGeneral().locale] || TRAY_TEXT['zh-CN'])[key];

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* 托盘图标是「隐藏态」的唯一出口，建不出来就必须按直接退出处理，
   否则窗口消失了又没图标可点 —— 用户只会看到「软件打不开了」。 */
function ensureTray() {
  if (tray) return tray;
  if (!fs.existsSync(ICON)) { log('没有托盘图标（' + ICON + '），本次关闭按直接退出处理'); return null; }
  try {
    tray = new Tray(ICON);
    tray.setToolTip(WINDOW_TITLE);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: trayText('show'), click: showMainWindow },
      { type: 'separator' },
      { label: trayText('quit'), click: quitApplication },
    ]));
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
    log('系统托盘图标已创建');
    return tray;
  } catch (e) {
    log('创建系统托盘图标失败: ' + e.message);
    try { if (tray) tray.destroy(); } catch (_) {}
    tray = null;
    return null;
  }
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch (_) {}
  tray = null;
}

/* 托盘菜单「退出」：走与点关闭按钮完全相同的通道（先落盘、再由 close 处理器放行），
   这里只登记退出意图，不再手动 destroy —— destroy 会跳过落盘。 */
function quitApplication() {
  isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else { destroyTray(); app.quit(); }
}

// 单实例锁：双击多次只开一个窗口，重复启动时聚焦已有窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      // 托盘隐藏态下再点桌面快捷方式 = 唤回窗口（show 对已可见窗口无副作用）
      showMainWindow();
      // 若新实例带 --open 文件，清洗后再转发给前端阅读器
      const openFile = pickOpenFile(argv);
      if (openFile) {
        log('第二实例收到文件: ' + JSON.stringify(openFile) + '（原始参数：' + JSON.stringify(argv.slice(1)) + '）');
        if (mainWindow.webContents) mainWindow.webContents.send('md:open-request', openFile);
      } else {
        log('第二实例未识别到文件参数: ' + JSON.stringify(argv.slice(1)));
      }
    }
  });
}

function cleanup() {
  if (owned && serverChild && serverChild.pid) {
    log('关闭由本启动器拉起的 server（PID ' + serverChild.pid + '）');
    killTree(serverChild.pid);
  }
  serverChild = null;
  owned = false;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(url);

  // 网页里的外链（教程中的 DeepSeek 官网等）一律交给系统默认浏览器打开。
  // 不处理的话 Electron 会开出一个没有 preload 的裸窗口，小白会以为「点坏了」。
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    try { if (/^https?:\/\//i.test(target)) shell.openExternal(target); } catch (_) {}
    return { action: 'deny' };
  });
  // 页面自身也不允许被导航离开本应用（防误点把整个界面顶替掉）
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (String(target).startsWith('http://127.0.0.1:')) return;
    e.preventDefault();
    try { if (/^https?:\/\//i.test(target)) shell.openExternal(target); } catch (_) {}
  });

  /* 关窗前先让前端把未落盘的数据同步写入（小白场景：绝不丢对话）。
     落盘之后才决定去留：最小化到托盘同样要落盘 —— 隐藏期间 Agent 还在写对话。 */
  mainWindow.on('close', async (e) => {
    if (allowClose) return;
    e.preventDefault();
    try {
      await mainWindow.webContents.executeJavaScript(
        'typeof flushChatsSync === "function" ? (flushChatsSync(), true) : true', true
      );
    } catch (_) {}
    if (!isQuitting && uiGeneral().closeBehavior === 'tray') {
      if (ensureTray()) {
        mainWindow.hide();
        if (!trayHintShown && process.platform === 'win32') {
          trayHintShown = true;
          try {
            tray.displayBalloon({ iconType: 'info', title: trayText('hint'), content: trayText('hintBody') });
          } catch (_) {}
        }
        log('按设置最小化到托盘（server 与单实例锁保持运行）');
        return;
      }
    }
    allowClose = true;
    try { mainWindow.close(); } catch (_) {}
  });

  mainWindow.on('closed', () => {
    destroyTray();
    cleanup();
    mainWindow = null;
    app.quit();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, validatedURL) => {
    log('页面加载失败 code=' + code + ' desc=' + desc + ' url=' + validatedURL);
  });

  // 原生右键菜单：复制/剪切/粘贴/全选（Electron 默认没有右键菜单，
  // 没有它，小白用户"选中复制粘贴"会很别扭——尤其输入框和对话内容）。
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const template = [];
    const hasSel = params && params.selectionText && String(params.selectionText).trim().length > 0;
    if (params && params.isEditable) {
      template.push({ role: 'cut', label: '剪切' });
      template.push({ role: 'copy', label: '复制' });
      template.push({ role: 'paste', label: '粘贴' });
      // 输入框内点右键时焦点在该框，role selectAll 只全选框内文字；
      // 页面上点右键不给「全选」，避免把整页 UI 都框进去。
      template.push({ role: 'selectAll', label: '全选' });
    } else if (hasSel) {
      template.push({ role: 'copy', label: '复制' });
    }
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // 防僵尸：主窗口迟迟没完成加载/显示 → 自动退出并清掉自己拉起的 server，
  // 避免「无窗口进程占着单实例锁 / 8787」让用户以为软件打不开。
  let shownTick = 0;
  mainWindow.webContents.on('did-finish-load', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); } });
  const zombieTimer = setTimeout(() => {
    const w = mainWindow;
    if (!w || w.isDestroyed()) return;
    if (!w.isVisible() && !w.isMinimized()) {
      log('主窗口 45s 仍未可见，判定为启动异常，自动退出并清理');
      cleanup();
      app.quit();
    }
  }, 45000);
  mainWindow.on('show', () => { clearTimeout(zombieTimer); });
  mainWindow.on('closed', () => { clearTimeout(zombieTimer); });
}

app.on('window-all-closed', () => {
  app.quit();
});

/* 从系统/任务管理器以外的一切退出路径（app.quit、托盘退出、僵尸自清）都先登记意图：
   没有这一步，app.quit 触发的 close 会被当成「点关闭」而改成隐藏窗口，应用就永远退不掉。 */
app.on('before-quit', () => { isQuitting = true; });

/* PDF 导出：渲染进程传入 HTML，用隐藏窗口 printToPDF 后弹保存框 */
ipcMain.handle('pdf:export', async (_event, { html, title } = {}) => {
  try {
    const pdf = await renderPdfToBuffer(html);
    const defaultName = (String(title || '辩论教练导出').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40) || 'export') + '.pdf';
    const result = await dialog.showSaveDialog(mainWindow || undefined, {
      title: '导出 PDF',
      defaultPath: defaultName,
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, pdf);
    log('PDF 已导出: ' + result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e) {
    log('PDF 导出失败: ' + e.message);
    return { ok: false, error: e.message };
  }
});

/* 静默转 PDF：渲染进程传入 HTML + 目标文件名，直接写入产物空间 data/deliverables/，不弹保存框。
   与 pdf:export 的区别：pdf:export 让用户在任意位置另存；这个走「产物面板 → 存 PDF」，
   行为对齐服务端 deliverConvert(target=pdf)，自动落产物空间、重名加 _2。 */
async function renderPdfToBuffer(html) {
  const preload = path.join(__dirname, 'preload.js');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload },
  });
  // data: URL 有长度上限，超长文档会截断 → 落临时文件用 file:// 装载（与 pdf-worker.js 同款）
  const tmpHtml = path.join(os.tmpdir(), 'academy-pdf-' + Date.now() + '.html');
  try {
    fs.writeFileSync(tmpHtml, String(html || ''), 'utf8');
    await win.loadURL('file://' + tmpHtml.replace(/\\/g, '/'));
    // 页边距（英寸）上下 2cm≈0.79、左右 2.5cm≈0.98；页脚页码，与 pdf-worker.js 同款
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#8A93A6;font-family:\'Microsoft YaHei\',sans-serif">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margins: { top: 0.79, bottom: 0.79, left: 0.98, right: 0.98 },
    });
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
    if (!win.isDestroyed()) win.destroy();
  }
}

ipcMain.handle('pdf:export-silent', async (_event, { html, name } = {}) => {
  let base = String(name || '导出').replace(/\.\w+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'export';
  try {
    const DELIVER_DIR = path.join(DATA_DIR, 'deliverables');
    if (!fs.existsSync(DELIVER_DIR)) fs.mkdirSync(DELIVER_DIR, { recursive: true });
    // 重名自动加 _2 / _3…，避免静默覆盖用户已有产物
    let target = path.join(DELIVER_DIR, base + '.pdf');
    let n = 2;
    while (fs.existsSync(target)) { target = path.join(DELIVER_DIR, base + '_' + n + '.pdf'); n++; }
    const pdf = await renderPdfToBuffer(html);
    fs.writeFileSync(target, pdf);
    log('PDF 已静默导出到产物空间: ' + target);
    return { ok: true, path: target, name: path.basename(target) };
  } catch (e) {
    log('PDF 静默导出失败: ' + e.message);
    return { ok: false, error: e.message };
  }
});

/* 清洗「文件关联 / 命令行」传进来的路径：
   - 去掉 cmd / 注册表带进来的首尾引号（最常见："C:\xx\笔记.md" 连引号一起传进来）
   - 支持 file:/// URL 与 \\?\ 前缀
   - 去掉尾部残留的引号与空白 */
function normalizeOpenPath(raw) {
  if (!raw && raw !== 0) return '';
  let s = String(raw).trim();
  try {
    if (/^file:\/\//i.test(s)) {
      s = decodeURIComponent(s.replace(/^file:\/\/\/?/i, ''));
      s = s.replace(/\//g, '\\');
    }
  } catch (_) {}
  s = s.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
  s = s.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  return s;
}

/* 从 argv 里找要打开的文件：优先 --open 后一个参数；
   没有 --open 时（注册表命令异常 / 其它调用方式）退化为「第一个像本地文件路径的参数」 */
const MD_EXT = ['.md', '.markdown', '.txt', '.srt'];
/* 内置阅读器：打开时的内容指纹（小写路径 -> sha1），用于保存前检测外部修改 */
const mdOpenHashes = new Map();
function mdHash(s) { return require('crypto').createHash('sha1').update(String(s == null ? '' : s), 'utf8').digest('hex'); }
function pickOpenFile(argv) {
  if (!Array.isArray(argv)) return '';
  const oi = argv.indexOf('--open');
  if (oi >= 0 && argv[oi + 1] && String(argv[oi + 1]).charAt(0) !== '-') {
    return normalizeOpenPath(argv[oi + 1]);
  }
  for (const a of argv) {
    if (!a || String(a).charAt(0) === '-') continue;
    if (!/[\\/]/.test(String(a))) continue;
    const ext = path.extname(normalizeOpenPath(a)).toLowerCase();
    if (MD_EXT.includes(ext)) return normalizeOpenPath(a);
  }
  return '';
}

/* MD 阅读器：系统文件对话框选文件 + 读取（仅允许 .md/.markdown/.txt/.srt 且 ≤16MB） */
function sanitizeMdPath(filePath) {
  try {
    if (!filePath || typeof filePath !== 'string') return { ok: false, error: '没有拿到文件路径' };
    const clean = normalizeOpenPath(filePath);
    if (!clean) return { ok: false, error: '没有拿到文件路径' };
    const ext = path.extname(clean).toLowerCase();
    if (!MD_EXT.includes(ext)) return { ok: false, error: '仅支持 .md / .markdown / .txt / .srt 文件（收到：' + clean + '）' };
    const st = fs.statSync(clean);
    if (!st.isFile()) return { ok: false, error: '这不是一个文件' };
    if (st.size > 16 * 1024 * 1024) return { ok: false, error: '文件过大（超过 16MB）' };
    return { ok: true, path: clean };
  } catch (e) { return { ok: false, error: '无法访问该文件（' + (e.code || e.message) + '）' }; }
}
ipcMain.handle('md:open', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown / 文本', extensions: ['md', 'markdown', 'txt', 'srt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { canceled: true };
    const chk = sanitizeMdPath(result.filePaths[0]);
    if (!chk.ok) return { canceled: false, error: chk.error };
    const fp = chk.path;
    const text = fs.readFileSync(fp, 'utf8');
    mdOpenHashes.set(fp.toLowerCase(), mdHash(text));
    return { canceled: false, path: fp, name: path.basename(fp), text, crlf: /\r\n/.test(text) };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});
/* 备份文件保存 / 打开 */
ipcMain.handle('backup:save', async (_evt, { jsonText, defaultName } = {}) => {
  try {
    const fileName = defaultName || ('academy-backup-' + new Date().toISOString().slice(0, 10) + '.json');
    // 默认落在「文档」目录，用户可在对话框里自由选择任意位置（含 U 盘/网盘）
    let defaultPath = fileName;
    try { defaultPath = path.join(app.getPath('documents'), fileName); } catch (_) {}
    // 确保对话框出现在主窗口前面，避免被遮挡
    if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.focus(); } catch (_) {} }
    const result = await dialog.showSaveDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      title: '选择备份文件的保存位置',
      buttonLabel: '保存备份',
      defaultPath,
      filters: [{ name: 'Academy 备份文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, String(jsonText || ''), 'utf8');
    log('备份已导出: ' + result.filePath);
    return { ok: true, path: result.filePath, dir: path.dirname(result.filePath) };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 产物空间：另存到任意路径（用户选位置），返回存到哪里了 */
ipcMain.handle('deliverable:saveAs', async (_evt, { name, text, base64 } = {}) => {
  try {
    const safe = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80) || 'deliverable.txt';
    const r = await dialog.showSaveDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      title: '导出产物到…',
      defaultPath: safe,
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    if (typeof base64 === 'string' && base64) fs.writeFileSync(r.filePath, Buffer.from(base64, 'base64'));
    else fs.writeFileSync(r.filePath, String(text ?? ''), 'utf8');
    log('产物另存: ' + r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 产物空间：在文件管理器中定位产物目录（或指定文件） */
ipcMain.handle('deliverable:folder', (_evt, fileName) => {
  try {
    const { shell } = require('electron');
    const baseDir = path.join(ROOT, 'data', 'deliverables');
    const p = fileName ? path.join(baseDir, path.basename(String(fileName))) : baseDir;
    shell.showItemInFolder(p);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
/* 独立工具窗（研究台 / 证据检证 / 资料溯源……）：
   通用壳 tool-window.js 按 --tool 加载，工具清单的唯一来源是 app/tool-registry.js */
ipcMain.handle('app:openTool', async (_evt, payload) => {
  try {
    const name = String((payload || {}).name || '');
    if (!Object.prototype.hasOwnProperty.call(TOOLS, name)) return { ok: false, error: '未知工具：' + name };
    const exePath = process.execPath;
    const script = path.join(__dirname, 'tool-window.js');
    if (!fs.existsSync(script)) return { ok: false, error: '找不到工具窗程序（app/tool-window.js）' };
    const { spawn } = require('child_process');
    const args = [script, '--tool=' + name];
    if (serverPort > 0) args.push('--port=' + serverPort);
    /* 英文模式下主窗口传 lang，工具窗标题与渲染层据此切英文（localStorage 不跨 file:// 源） */
    if ((payload || {}).lang === 'en') args.push('--lang=en');
    spawn(exePath, args, { cwd: ROOT, windowsHide: false, stdio: 'ignore', detached: true }).unref();
    log('打开工具窗: ' + name);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('shell:showItem', async (_evt, filePath) => {
  try {
    const { shell } = require('electron');
    if (!filePath || typeof filePath !== 'string') return { ok: false, error: '无效路径' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('backup:open', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: '选择备份文件',
      properties: ['openFile'],
      filters: [{ name: 'Academy 备份文件', extensions: ['json'] }, { name: '全部文件', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) return { ok: false, canceled: true };
    const fp = result.filePaths[0];
    const st = fs.statSync(fp);
    if (st.size > 200 * 1024 * 1024) return { ok: false, error: '备份文件过大（>200MB）' };
    const text = fs.readFileSync(fp, 'utf8');
    log('读取备份文件: ' + fp + ' (' + text.length + ' 字符)');
    return { ok: true, path: fp, text };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('md:read', async (_evt, filePath) => {
  const chk = sanitizeMdPath(filePath);
  if (!chk.ok) return { ok: false, error: chk.error };
  const fp = chk.path;
  try {
    const text = fs.readFileSync(fp, 'utf8');
    // 记下内容指纹：保存时用它判断文件是否被外部改过（mtime 分辨率不够，见 md-reader-window.js 注释）
    mdOpenHashes.set(fp.toLowerCase(), mdHash(text));
    log('MD 阅读器读取: ' + fp + ' (' + text.length + ' 字符)');
    return { ok: true, path: fp, name: path.basename(fp), text, crlf: /\r\n/.test(text) };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* 内置阅读器保存：写回原文件。force=true 忽略外部修改冲突 */
ipcMain.handle('md:save', async (_evt, { path: filePath, text, crlf, force } = {}) => {
  const chk = sanitizeMdPath(filePath);
  if (!chk.ok) return { ok: false, error: chk.error };
  const fp = chk.path;
  try {
    if (!force) {
      const opened = mdOpenHashes.get(fp.toLowerCase());
      if (opened) {
        const now = mdHash(fs.readFileSync(fp, 'utf8'));
        if (now !== opened) {
          return { ok: false, conflict: true, error: '这个文件在你编辑期间被其他程序修改过。' };
        }
      }
    }
    let out = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    if (crlf) out = out.replace(/\n/g, '\r\n');
    fs.writeFileSync(fp, out, 'utf8');
    mdOpenHashes.set(fp.toLowerCase(), mdHash(out));
    log('MD 阅读器保存: ' + fp + ' (' + out.length + ' 字符)');
    return { ok: true, path: fp, size: out.length };
  } catch (e) { return { ok: false, error: e.message }; }
});


app.whenReady().then(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const effectivePort = Number.isInteger(PORT) && PORT > 0 ? PORT : DEFAULT_PORT;

  /* 1. 确保 server 在跑：只复用「本副本」的；端口被别的副本或非本 App 的服务挡着就换端口自启。
        绝不能只看「端口上有服务就复用」—— 那会让后启动的副本显示前一个副本的界面；
        也不能只死盯请求端口 —— server 自己 +1 挪走后，这里等不到就会白等 45 秒再静默退出。 */
  let usedPort = 0;
  const pick = await resolveOwnPort(effectivePort, 20);
  if (pick.reuse) {
    usedPort = pick.port;
    log('检测到本副本的 server 已在 ' + usedPort + ' 运行，直接复用');
  } else {
    if (pick.port !== effectivePort) {
      log('端口 ' + effectivePort + ' 被其它副本占用，改用 ' + pick.port + ' 自启（避免显示成别人的界面）');
    }
    log('启动隐藏 server（端口 ' + pick.port + ' 起）…');
    serverChild = startServer(pick.port);
    owned = true;
    usedPort = await waitServerUp(pick.port, START_TIMEOUT, 20);
    if (!usedPort) {
      log('server 在超时时间内未就绪，退出');
      /* 走到这里说明 8787~8807 整段都被本 App 之外的东西占着，或 server 本身起不来。
         静默退出的话用户只看到「双击没反应」，什么线索都没有 —— 至少要告诉他找谁商量。 */
      try {
        dialog.showErrorBox('启动失败',
          '本地服务在 ' + (START_TIMEOUT / 1000) + ' 秒内没能启动。\n\n'
          + '常见原因：端口 ' + pick.port + '~' + (pick.port + 20) + ' 全被其它软件占用，或 data/ 目录不可写。\n'
          + '可以先关掉占用了本地端口的程序再试一次；仍不行请到 QQ 群 386631298 反馈，'
          + '并附上文件：\n' + LOG_FILE);
      } catch (_) {}
      cleanup();
      app.quit();
      return;
    }
    log('server 就绪（端口 ' + usedPort + '）');
  }
  /* 开窗、以及之后 spawn 工具窗/研究台，用的都必须是实际端口而不是请求端口 */
  serverPort = usedPort;
  const url = 'http://127.0.0.1:' + usedPort + '/';

  // 1.5 静默注册 .md 文件关联（幂等）
  try { if (!registerFileAssoc()) log('文件关联注册失败或非 Windows'); else log('已检查/注册 .md 文件关联'); } catch (_) {}

  // 2. 创建桌面窗口
  createWindow(url);
  log('桌面窗口已创建: ' + url);

  // 3. 文件关联启动：把 --open 文件转发给前端阅读器
  const startupFile = normalizeOpenPath(OPEN_ARG) || pickOpenFile(process.argv);
  if (startupFile && mainWindow) {
    const chk = sanitizeMdPath(startupFile);
    if (chk.ok) {
      const fp = chk.path;
      mainWindow.webContents.once('did-finish-load', () => {
        try { mainWindow.webContents.send('md:open-request', fp); } catch (_) {}
      });
      log('文件关联打开: ' + fp);
    } else {
      log('文件关联打开失败: ' + chk.error);
    }
  }

  /* 仅测试用：设置 ACADEMY_TEST_CLOSE_MS 后，到点走一次与「点关闭按钮」完全相同的代码路径 ——
     托盘只能由主窗口的 close 事件触发，渲染层碰不到，只能这样真机验证两种关闭行为。 */
  const testClose = Number(process.env.ACADEMY_TEST_CLOSE_MS || 0);
  if (testClose > 0) {
    setTimeout(() => {
      log('测试模式：模拟点击关闭按钮（closeBehavior=' + uiGeneral().closeBehavior + '）');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, testClose);
  }

  // 仅测试用：设置 ACADEMY_AUTO_QUIT_MS 后，到点自动正常退出并清理自启 server。
  const autoQuit = Number(process.env.ACADEMY_AUTO_QUIT_MS || 0);
  if (autoQuit > 0) {
    setTimeout(() => {
      log('测试模式自动退出');
      cleanup();
      app.quit();
    }, autoQuit);
  }
});