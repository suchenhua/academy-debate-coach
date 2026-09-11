#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · MD 独立阅读窗（轻量版主进程）
 *
 * 双击 .md/.txt/.srt → 直开一个小阅读窗，秒开、不启动主软件，
 * 可开多个窗口并排，也可和主软件（electron-main.js）同时运行。
 *
 * 「在 Academy 接着做」＝ 向主 App 转发该文件（spawn electron-main.js --open），
 * 主 App 在跑就聚焦，没跑就冷启动，由主 App 在它自己的阅读器里继续。
 *
 * 用法a：electron.exe app/md-reader-window.js --md "C:\yy\note.md"
 * 依赖：./md-reader/renderer.html + reader.js + reader.css + md-view.js + ../docx.js
 * ----------------------------------------------- */
'use strict';

const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const R_HTML = path.join(__dirname, 'md-reader', 'renderer.html');
const R_PRELOAD = path.join(__dirname, 'md-reader', 'preload.js');
const ICON = path.join(ROOT, 'appicon.ico');
const LOG_FILE = path.join(DATA_DIR, 'reader-launch.log');
const OPTS_FILE = path.join(DATA_DIR, 'reader-options.json');

const MAIN_ELECTRON = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
const MAIN_SCRIPT = path.join(ROOT, 'app', 'electron-main.js');

let mainWindow = null;      // 上次创建的首窗（focus）—— 但我们允许多窗口
const MD_EXT = ['.md', '.markdown', '.txt', '.srt'];

/* 编辑态跟踪（按窗口 id）：脏标记用于标题提示与关窗拦截 */
const dirtyMap = new Map();   // winId -> bool
/* 打开时的内容指纹（按窗口 id）：保存时比对，判断文件是否被外部改过。
   不用 mtime —— NTFS 分辨率不够（实测快速写入时 20 次里 16 次 mtime 不变）。 */
const openHashMap = new Map(); // winId -> sha1
function hashContent(s) {
  return require('crypto').createHash('sha1').update(String(s == null ? '' : s), 'utf8').digest('hex');
}
function baseTitleOf(name) { return '📖 ' + name; }
function setDirty(win, dirty) {
  if (!win || win.isDestroyed()) return;
  dirtyMap.set(win.id, !!dirty);
  let name = '';
  try { name = win.__fileName || ''; } catch (_) {}
  if (!name) return;
  win.setTitle(baseTitleOf(name) + (dirty ? ' •' : ''));
}

app.setName('Academy MD Reader');
try { app.setPath('userData', path.join(DATA_DIR, 'electron-user-data-reader')); } catch (_) {}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (_) {}
}

/* ---- 与主 App 一致的启动路径清洗 / 候选收集 ---- */
function normalizeOpenPath(raw) {
  if (!raw && raw !== 0) return '';
  let s = String(raw).trim();
  try {
    if (/^file:\/\//i.test(s)) { s = decodeURIComponent(s.replace(/^file:\/\/\/?/i, '')); s = s.replace(/\//g, '\\'); }
  } catch (_) {}
  s = s.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
  s = s.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  return s;
}
function pickFiles(argv) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const clean = normalizeOpenPath(raw);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    const ext = path.extname(clean).toLowerCase();
    if (!MD_EXT.includes(ext)) return;
    try { if (fs.statSync(clean).isFile()) out.push(clean); } catch (_) {}
  };
  if (Array.isArray(argv)) {
    const mi = Math.max(argv.indexOf('--md'), argv.indexOf('--open'));
    if (mi >= 0) for (let i = mi + 1; i < argv.length; i++) push(argv[i]);
    else for (const a of argv) push(a);
  }
  return out;
}

/* ---- 阅读器公共设置（多窗口共享，磁盘持久化） ---- */
function defaultOpts() { return { pin: false, fontSize: 16, theme: 'auto' }; }
function loadOpts() {
  try { return Object.assign(defaultOpts(), JSON.parse(fs.readFileSync(OPTS_FILE, 'utf8'))); }
  catch (_) { return defaultOpts(); }
}
function saveOpts(patch) {
  const next = Object.assign(loadOpts(), patch || {});
  try { fs.writeFileSync(OPTS_FILE, JSON.stringify(next, null, 2), 'utf8'); } catch (_) {}
  return next;
}

/* ---- 创建阅读窗口 ---- */
function createReaderWindow(filePath, text, name) {
  const win = new BrowserWindow({
    width: 860,
    height: 760,
    minWidth: 420,
    minHeight: 360,
    title: '📖 ' + name,
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: R_PRELOAD,
    },
  });
  const opts = loadOpts();
  win.setAlwaysOnTop(opts.pin);
  let delivered = false;
  let failTries = 0;
  // 关键：内容必须在页面真正加载完（did-finish-load，此时 preload 与页面脚本都已就绪）后再投递。
  // 不能用「刚建窗时 isLoading() 判断」——新窗 isLoading() 恒为 false，会立刻 send 导致事件丢失，
  // 前端就一直停在「正在打开…」。
  const onReady = () => {
    if (delivered) return;
    delivered = true;
    if (!win || win.isDestroyed()) return;
    win.show();
    // 记录原始行尾 + 内容指纹：保存时保持行尾风格，并检测「文件被别的程序改过」。
    // 用内容哈希而不是 mtime —— NTFS 时间戳分辨率不够，实测快速连续写入时
    // 20 次里有 16 次 mtime 完全不变，靠它判冲突会大量漏检。
    let mtimeMs = 0, crlf = /\r\n/.test(text);
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) {}
    openHashMap.set(win.id, hashContent(text));
    setDirty(win, false);
    win.__fileName = name;
    win.webContents.send('reader:load', {
      path: filePath,
      name,
      text,
      charCount: text.length,
      opts,
      mtimeMs,
      crlf,
    });
    log('阅读: ' + filePath);
  };
  const onFail = (_e, code, desc, url) => {
    // 偶发 ERR_FAILED(-2)：内容还没送出时重试一次加载，避免白屏停在加载中
    if (!delivered && failTries < 2) {
      failTries += 1;
      log('reader 加载失败(code=' + code + ')，重试 ' + failTries + '/2');
      win.loadFile(R_HTML).catch(() => {});
    } else if (!delivered) {
      log('reader 页面加载失败: ' + desc + ' url=' + url);
    }
  };
  win.webContents.once('did-finish-load', onReady);
  win.webContents.on('did-fail-load', onFail);
  win.webContents.on('console-message', (_e, _level, message) => {
    const msg = String(message || '');
    if (msg.indexOf('[reader]') === 0) log('渲染进程: ' + msg);
  });
  win.loadFile(R_HTML).catch(() => {});
  // 有未保存修改时关窗要拦一下，避免手滑丢内容
  win.on('close', (e) => {
    if (!dirtyMap.get(win.id)) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['保存并关闭', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      title: '有未保存的修改',
      message: '「' + (win.__fileName || '文件') + '」还有未保存的修改。',
      detail: '关闭前要保存吗？',
    });
    if (choice === 2) { e.preventDefault(); return; }
    if (choice === 0) {
      // 交给渲染进程触发保存；此时先拦下关闭，等保存完再关
      e.preventDefault();
      win.webContents.send('reader:save-and-close');
    }
  });
  win.on('closed', () => {
    dirtyMap.delete(win.id);
    openHashMap.delete(win.id);
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function openFiles(argv) {
  const files = pickFiles(argv);
  if (!files.length) {
    // 没有可打开文件却被认真启动（如从命令行裸启），开一个引导窗
    const win = new BrowserWindow({
      width: 620, height: 300, autoHideMenuBar: true,
      icon: fs.existsSync(ICON) ? ICON : undefined,
      webPreferences: { preload: R_PRELOAD },
    });
    mainWindow = win;
    win.removeMenu();
    win.loadFile(R_HTML);
    win.webContents.once('did-finish-load', () => win.webContents.send('reader:empty'));
    return;
  }
  for (const fp of files) {
    try {
      const text = fs.readFileSync(fp, 'utf8');
      const win = createReaderWindow(fp, text, path.basename(fp));
      if (!mainWindow) mainWindow = win;
    } catch (e) { log('读取失败 ' + fp + ' : ' + e.message); }
  }
}

/* ---- ipc ---- */
ipcMain.handle('reader:copyText', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
ipcMain.handle('reader:saveWord', async (_e, { text, title } = {}) => {
  try {
    const { markdownToDocx } = require('./docx');
    const safe = (String(title || '阅读导出').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40)) || 'export';
    const r = await dialog.showSaveDialog(mainWindow || undefined, {
      title: '导出为 Word',
      defaultPath: safe + '.docx',
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, markdownToDocx(String(text || ''), { title: safe }));
    log('导出 Word: ' + r.filePath);
    return { ok: true, path: r.filePath };
  } catch (e) { log('导出 Word 失败: ' + e.message); return { ok: false, error: e.message }; }
});
/* 保存：写回原文件。force=true 时忽略「外部已修改」冲突 */
ipcMain.handle('reader:save', (e, { path: filePath, text, mtimeMs, crlf, force } = {}) => {
  try {
    const fp = normalizeOpenPath(filePath);
    if (!fp) return { ok: false, error: '没有可保存的文件路径' };
    if (!fs.existsSync(fp)) return { ok: false, error: '原文件已不存在：' + fp };

    // 冲突检测：比对「打开时的内容指纹」与「当前磁盘内容」。
    // 早先试过 mtime 方案（1s 容差 → 1ms 容差）都不行：NTFS 时间戳分辨率不够，
    // 实测 20 次快速连续写入里有 16 次 mtime 完全不变，大量漏检。
    // 内容哈希是确定性判据，不受时间戳精度影响。
    if (!force) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const openedHash = win && !win.isDestroyed() ? openHashMap.get(win.id) : null;
      if (openedHash) {
        try {
          const onDisk = hashContent(fs.readFileSync(fp, 'utf8'));
          if (onDisk !== openedHash) {
            return { ok: false, conflict: true, error: '这个文件在你编辑期间被其他程序修改过。' };
          }
        } catch (_) {}
      }
    }

    // 保持原文件的行尾风格，避免整篇 diff 噪音
    let out = String(text == null ? '' : text);
    out = out.replace(/\r\n/g, '\n');
    if (crlf) out = out.replace(/\n/g, '\r\n');

    fs.writeFileSync(fp, out, 'utf8');
    const st = fs.statSync(fp);
    log('保存: ' + fp + ' (' + out.length + ' 字符)');
    return { ok: true, path: fp, mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    log('保存失败: ' + err.message);
    return { ok: false, error: err.message };
  }
});

/* 渲染进程同步脏标记 */
ipcMain.handle('reader:setDirty', (e, dirty) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  setDirty(win, dirty);
  return { ok: true };
});

/* 「保存并关闭」流程结束后由渲染进程回调，真正关窗 */
ipcMain.handle('reader:closeNow', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) {
    dirtyMap.set(win.id, false);   // 先清脏标记，否则 close 又被拦
    win.close();
  }
  return { ok: true };
});

ipcMain.handle('reader:openInAcademy', (_e, filePath) => {
  try {
    createMainArgsThenSpawn(filePath ? normalizeOpenPath(filePath) : '');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
function createMainArgsThenSpawn(filePath) {
  if (!fs.existsSync(MAIN_ELECTRON) || !fs.existsSync(MAIN_SCRIPT)) {
    dialog.showErrorBox('Academy 辩论教练', '主程序完整版不在本目录（' + MAIN_ELECTRON + '），无法跳转。');
    return;
  }
  const args = [MAIN_SCRIPT];
  if (filePath) args.push('--open', filePath);
  log('跳转到主 App: ' + JSON.stringify(args.slice(1)));
  spawn(MAIN_ELECTRON, args, { cwd: ROOT, windowsHide: true, stdio: 'ignore', detached: true }).unref();
}

// 单实例：读者本身允许多文件多窗，但保证进程唯一（重复双击只是新开窗口）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { openFiles(argv); });
  app.on('open-file', (e, filePath) => { e.preventDefault(); openFiles([filePath]); });
}

app.whenReady().then(() => {
  openFiles(process.argv);
}).catch((e) => log('whenReady 失败: ' + e.message));

app.on('window-all-closed', () => { app.quit(); });
