#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · Electron 桌面版主进程
 *
 * 用 Electron（自带 Chromium）把本地 Web 应用封装成
 * 独立桌面窗口：无浏览器标签栏/地址栏、关窗即退。
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

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const SERVER = path.join(ROOT, 'app', 'server.js');
const DATA_DIR = path.join(ROOT, 'data');
const ICON = path.join(ROOT, 'appicon.ico');
const LOG_FILE = path.join(DATA_DIR, 'electron-launch.log');

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

function isServerUp(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/status', timeout: timeoutMs || 1200,
    }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(res.statusCode === 200 && body.indexOf('"version"') !== -1));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitServerUp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp(port, 800)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
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

// 单实例锁：双击多次只开一个窗口，重复启动时聚焦已有窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
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
    title: 'Academy 辩论教练 · 逻敏',
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

  // 关窗前先让前端把未落盘的数据同步写入（小白场景：绝不丢对话）
  let allowClose = false;
  mainWindow.on('close', async (e) => {
    if (allowClose) return;
    e.preventDefault();
    try {
      await mainWindow.webContents.executeJavaScript(
        'typeof flushChatsSync === "function" ? (flushChatsSync(), true) : true', true
      );
    } catch (_) {}
    allowClose = true;
    try { mainWindow.close(); } catch (_) {}
  });

  mainWindow.on('closed', () => {
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
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(html || '')));
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
  } finally {
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
    return { canceled: false, path: fp, name: path.basename(fp), text };
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
    log('MD 阅读器读取: ' + fp + ' (' + text.length + ' 字符)');
    return { ok: true, path: fp, name: path.basename(fp), text };
  } catch (e) { return { ok: false, error: e.message }; }
});


app.whenReady().then(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const effectivePort = Number.isInteger(PORT) && PORT > 0 ? PORT : DEFAULT_PORT;
  const url = 'http://127.0.0.1:' + effectivePort + '/';

  // 1. 确保 server 在跑（复用或自启）
  if (await isServerUp(effectivePort, 1200)) {
    log('检测到 server 已在 ' + effectivePort + ' 运行，直接复用');
  } else {
    log('启动隐藏 server（端口 ' + effectivePort + '）…');
    serverChild = startServer(effectivePort);
    owned = true;
    if (!(await waitServerUp(effectivePort, START_TIMEOUT))) {
      log('server 在超时时间内未就绪，退出');
      cleanup();
      app.quit();
      return;
    }
    log('server 就绪');
  }

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