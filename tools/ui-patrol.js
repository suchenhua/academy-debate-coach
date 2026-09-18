#!/usr/bin/env node
/* 断链巡检（Flash 线）：真实点击界面上每个按钮，判断「点了有没有反应」。
 *
 * 为什么需要它：静默失败（window.prompt 被 Electron 禁用、IPC 没注册、
 * 控件渲染分支漏挂事件）共同点是「点了没反应、不报错、界面看不出坏了」，
 * 手点发现不了，静态扫描也查不出运行时分支。
 *
 * 判定：点击前后对比 DOM 快照（模式 / 弹窗 / toast / 隐藏元素数 / 文本）。
 *   有变化 = 有反应；无变化 = 可疑断链。
 * ⚠️ 这是**巡检**不是断言 —— 结果供人工判断，假阳性要逐个核实。
 *
 * 用法（必须用 Electron 跑，它要开渲染进程）：
 *   .\runtime\electron\dist\electron.exe tools/ui-patrol.js <项目根> <输出json>
 * 前置：目标端口上已有**隔离数据目录**的服务在跑（见 tools/run-ui-patrol.js）。
 *
 * 实现注意：
 *   - 注入脚本在 tools/patrol-inject.js（独立文件、可 node --check）
 *   - 日志只写 data/patrol.log，不碰 stdout（后台管道会毒死进程）
 *   - confirm/alert/prompt 在注入层被 hook（防模态卡死 + 保护数据）
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3];
const PORT = process.env.PATROL_PORT || '8795';
app.setPath('userData', path.join(process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data'), 'electron-user-data-patrol'));

const LOGFILE = path.join(process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data'), 'patrol.log');
try { fs.writeFileSync(LOGFILE, '', 'utf8'); } catch (_) {}
function LOG(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  try { fs.appendFileSync(LOGFILE, line + '\n', 'utf8'); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function diffSnap(a, b) {
  if (a.pane !== b.pane) return '界面 ' + (a.pane || '(无)') + ' -> ' + (b.pane || '(无)');
  if (a.modals !== b.modals) return '弹窗 ' + (a.modals || '(无)') + ' -> ' + (b.modals || '(无)');
  if (a.toast !== b.toast) return '提示「' + (b.toast || a.toast || '') + '」';
  if (a.dialogs !== b.dialogs) return '弹了原生对话框';
  if (a.hidden !== b.hidden) return '隐藏元素数 ' + a.hidden + ' -> ' + b.hidden;
  if (a.keySig !== b.keySig) return '输入框类型 ' + a.keySig + ' -> ' + b.keySig;
  if (a.activeSig !== b.activeSig) return '激活元素变化';
  if (a.txtLen !== b.txtLen) return '全文长度 ' + a.txtLen + ' -> ' + b.txtLen;
  if (a.txt !== b.txt) return '文本变化';
  return '';
}

async function exec(win, code) { return win.webContents.executeJavaScript(code); }
async function snap(win) {
  const raw = await exec(win, 'window.__patrol.snapJson()');
  try { return JSON.parse(raw); } catch (_) { return { pane: '', modals: '', hidden: -1, txt: '', toast: '', dialogs: 0 }; }
}

/* 巡检一组元素。enter 是「先切到该界面」的小段代码，每轮点击前都重放一遍 */
async function patrolGroup(win, name, sel, enter) {
  LOG('  · 进入组 ' + name);
  await exec(win, 'window.__patrol.closeAllModals();');
  if (enter) { await exec(win, enter); await sleep(900); }
  LOG('  · 界面已就位，取元素列表');
  const listRaw = await exec(win, 'window.__patrol.listJson(' + JSON.stringify(sel) + ')');
  let list = [];
  try { list = JSON.parse(listRaw); } catch (_) { return { groupName: name, error: '列表解析失败' }; }
  LOG('  · 匹配到 ' + list.length + ' 个元素');

  const results = [];
  for (const it of list) {
    if (!it.visible) { results.push({ id: it.id, text: it.text, verdict: '不可见', why: '跳过' }); continue; }
    if (SKIP_IDS.indexOf(it.id) !== -1 || (it.ds && SKIP_DS.indexOf(it.ds) !== -1)) {
      results.push({ id: it.id, text: it.text, verdict: '跳过', why: '有副作用，巡检不点' });
      LOG('    ~ ' + (it.id || it.ds) + ' 跳过（有副作用）');
      continue;
    }
    await exec(win, 'window.__patrol.closeAllModals();');
    if (enter) { await exec(win, enter); await sleep(700); }
    await exec(win, 'window.__patrol.takeDialogs();');
    const before = await snap(win);
    const clickRes = await exec(win, 'window.__patrol.clickOne(' + JSON.stringify(sel) + ', ' + it.i + ')');
    /* 等 1200ms：很多按钮是异步的（发请求 → 回来才弹提示） */
    await sleep(1200);
    const after = await snap(win);
    const d = diffSnap(before, after);
    let dialogs = [];
    try { dialogs = JSON.parse(await exec(win, 'window.__patrol.takeDialogs();')); } catch (_) {}
    let verdict = '有反应';
    if (clickRes === 'gone') verdict = '已消失';
    else if (String(clickRes).indexOf('err:') === 0) verdict = '抛错';
    else if (!d) verdict = '无反应';
    results.push({ id: it.id, text: it.text, verdict: verdict, why: clickRes === 'ok' ? d : clickRes, dialogs: dialogs });
    if (dialogs.length) {
      LOG('    ▣ ' + (it.id || '(无id)') + ' 「' + it.text + '」 弹了 ' + dialogs[0].type + ': ' + dialogs[0].msg.slice(0, 50));
    }
    if (verdict !== '有反应' && verdict !== '不可见') {
      LOG('    ! ' + (it.id || '(无id)') + ' 「' + it.text + '」 -> ' + verdict + ' ' + (clickRes === 'ok' ? d : clickRes));
    }
  }
  await exec(win, 'window.__patrol.closeAllModals();');
  return { groupName: name, results: results };
}

/* 副作用跳过表（按 id 或 data-export）。
   数据目录虽已隔离（ACADEMY_DATA_DIR），但导出/下载类仍会碰真实下载目录、
   或弹出原生文件框，一律不点。
   会弹 confirm 的破坏性按钮（删除类）不需要列 —— 注入层已把 confirm 换成
   「记录并返回 false」，天然不会执行。 */
const SKIP_IDS = [
  'btnAttach',          // 文件选择框需真实用户手势（已知假阳性）
  'btnSkillImport',     // 同上
  'btnLibPick',         // 同上
  'btnLibPickDir',      // 同上
  'btnExportBackup',    // 触发下载（落真实下载目录）
  'btnImportBackup',    // 触发文件选择框
  'fileInput'
];
const SKIP_DS = ['word', 'pdf', 'markdown']; // 导出当前会话的三个格式项

/* enter 里 openExportMenu 只在导出组用（点开下拉菜单才看得到导出项） */
const GROUPS = [
  { name: '顶栏', sel: '.topbar-actions .btn', enter: '' },
  { name: '模式切换', sel: '.modes .mode-btn', enter: '' },
  { name: '聊天头', sel: '.chat-head-actions .btn', enter: '' },
  { name: '导出下拉项', sel: '.export-item', enter: 'window.__patrol.openExportMenu();' },
  { name: '输入区', sel: '.composer button:not([disabled])', enter: '' },
  { name: '历史区', sel: '.side-section button:not([disabled]), .side-foot button:not([disabled])', enter: '' },
  { name: '设置-模型', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("model");' },
  { name: '设置-通用', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("general");' },
  { name: '设置-联网搜索', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("search");' },
  { name: '设置-高级', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("advanced");' },
  { name: '设置-数据备份', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("backup");' },
  { name: '设置-技能', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("skills");' },
  { name: '设置-统计', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("stats");' },
  { name: '设置-关于', sel: '.settings-pane.active button:not([disabled])', enter: 'window.__patrol.settingsTab("about");' },
  { name: '工具箱', sel: '#toolsModal button:not([disabled])', enter: 'window.__patrol.clickId("btnTools");' },
  { name: '产物空间', sel: '#deliverModal button:not([disabled])', enter: 'window.__patrol.clickId("btnDeliver");' },
  { name: '记忆', sel: '#memoryModal button:not([disabled])', enter: 'window.__patrol.clickId("btnMemory");' },
  { name: '资料库', sel: '#libraryModal button:not([disabled])', enter: 'window.__patrol.clickId("btnLibrary");' }
];

app.whenReady().then(async () => {
  const WATCHDOG_MS = Number(process.env.PATROL_TIMEOUT_MS || 420000);
  const watchdog = setTimeout(function () {
    LOG('[看门狗] 超过 ' + Math.round(WATCHDOG_MS / 1000) + ' 秒未完成，强制退出');
    app.quit();
  }, WATCHDOG_MS);
  app.on('quit', function () { clearTimeout(watchdog); });

  const win = new BrowserWindow({ width: 1440, height: 940, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', function (e, level, message) {
    if (level >= 2) LOG('[渲染进程] ' + message);
  });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(3000);
  LOG('[1] 页面已加载');

  const injectPath = path.join(__dirname, 'patrol-inject.js');
  const injectCode = fs.readFileSync(injectPath, 'utf8');
  let injectRes = '(未执行)';
  try {
    injectRes = await exec(win, injectCode);
  } catch (e) {
    LOG('[2] 注入失败: ' + e.message);
    app.quit();
    return;
  }
  LOG('[3] 注入结果: ' + injectRes);

  const all = [];
  for (const g of GROUPS) {
    try {
      const r = await patrolGroup(win, g.name, g.sel, g.enter);
      all.push(r);
      const vis = (r.results || []).filter(function (x) { return x.verdict !== '不可见'; }).length;
      const bad = (r.results || []).filter(function (x) { return x.verdict === '无反应' || x.verdict === '抛错'; }).length;
      LOG('[组] ' + g.name + '  可见 ' + vis + '  可疑 ' + bad);
    } catch (e) {
      all.push({ groupName: g.name, error: e.message });
      LOG('[组] ' + g.name + '  失败: ' + e.message);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(all, null, 2), 'utf8');
  LOG('巡检完成 -> ' + OUT);
  app.quit();
}).catch(function (e) { LOG('ERR ' + e.message); app.quit(); });
