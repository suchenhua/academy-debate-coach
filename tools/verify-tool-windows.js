#!/usr/bin/env node
/* 独立工具窗（研究台 / 证据检证 / 资料溯源）实跑验证。
 *
 * 为什么不直接 spawn tool-window.js 再断言：那是独立进程，外面摸不到渲染层。
 * 本脚本用同一套 IPC 通道（tool:init / tool:proxy…）加载**真实的 renderer.html**，
 * 走真实主 App 服务（ACADEMY_DATA_DIR 隔离数据目录），断言到「服务器返回错误」这一层。
 *
 * init 的返回体不随手造：直接 require app/tool-registry.js，用真实注册项的
 * initOpts(defaults) 生成 —— 壳和测试壳对渲染层说同一套话，注册表一改这边立刻照得出来。
 *
 * 用法（必须用 Electron 跑）：
 *   .\runtime\electron\dist\electron.exe tools/verify-tool-windows.js <项目根> [输出json]
 * 前置：TOOLTEST_PORT（默认 8796）上已有隔离数据目录的服务在跑。
 */
'use strict';
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { TOOLS } = require(path.join(process.argv[2], 'app', 'tool-registry.js'));

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-tool-windows.json');
const PORT = Number(process.env.TOOLTEST_PORT || 8796); // 8787~8792 是应用/启动器端口，测试绝不占用

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 与 tool-window.js 相同的转发逻辑（测试壳，验证的是渲染层与服务端协议） ---- */
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
/* currentTool 决定 tool:init 按哪个注册项出话；currentStub 模拟存档里已有的字段。
   面板类工具给空 stub —— 它们第一步测的就是「空输入拦截」，不能预填。 */
let currentTool = '';
let currentStub = {};
let lastOpenedTool = '';
let lastTitle = null;
function registerIpc() {
  ipcMain.handle('tool:init', async () => {
    const T = TOOLS[currentTool];
    const merged = Object.assign({ width: T.width, height: T.height }, T.defaults, currentStub);
    return { ok: true, port: PORT, tool: currentTool, opts: T.initOpts(merged), error: '' };
  });
  ipcMain.handle('tool:saveOpts', () => ({ ok: true }));
  ipcMain.handle('tool:proxy', (_e, payload) => proxyFetch(PORT, payload || {}));
  ipcMain.handle('tool:copyText', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
  ipcMain.handle('tool:setTitle', (_e, t) => { lastTitle = String(t == null ? '' : t); return { ok: true }; });
  ipcMain.handle('tool:openTool', (_e, payload) => { lastOpenedTool = String((payload || {}).name || ''); return { ok: true }; });
}

/* spec = [用例名, 是否通过, 实测值]；用例名前自动拼上工具名 */
function push(results, toolName, spec) {
  results.push({ case: toolName + ' · ' + spec[0], pass: !!spec[1], got: spec[2] || '' });
}
const readEl = (id, prop) => '(function(){var e=document.getElementById("' + id + '");return e?e.' + prop + ':"(无)";})()';
const appVisibleJs = '(function(){var a=document.getElementById("app");return a&&!a.classList.contains("hidden");})()';

/* 面板类工具（证据检证 / 资料溯源）：DOM 结构一致，共用一套步骤 */
async function testPanelRenderer(win, htmlPath, tool, name, expect) {
  /* ⚠️ 必须复用同一个窗口顺序加载：
     实测「加载 A → destroy → 加载 B」时第二个 loadFile 必报 ERR_FAILED(-2)，
     与加载哪个文件无关；同窗口连续 loadFile 则一直正常。 */
  currentTool = tool; currentStub = {}; lastOpenedTool = '';
  await win.loadFile(htmlPath);
  await sleep(1200);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];

  push(results, name, ['preload 桥接入', await ex('!!window.academyTool')]);

  /* 初始化后界面展开、连接指示变绿 */
  await sleep(400);
  const conn = await ex(readEl('connState', 'textContent'));
  const appVisible = await ex(appVisibleJs);
  push(results, name, ['初始化展开界面', appVisible && conn.indexOf('已连接') !== -1, conn + ' / app可见=' + appVisible]);

  /* 空输入点击运行 → toast 拦截 */
  await ex('document.getElementById("btnRun").click();');
  await sleep(400);
  const toastEmpty = await ex(readEl('toast', 'textContent'));
  push(results, name, ['空输入拦截', toastEmpty.indexOf(expect.emptyToast) !== -1, toastEmpty]);

  /* 填入论据点运行 → 服务端（未配 Key）返回业务错误，证明全链路到服务器 */
  await ex('(function(){var i=document.getElementById("workInput");i.value=' + JSON.stringify(expect.input) + ';document.getElementById("btnRun").click();})()');
  await sleep(6000);
  const resultText = await ex(readEl('workResult', 'textContent'));
  push(results, name, ['全链路（隔离环境无 Key → 服务端明确报错）', resultText.indexOf(expect.noKeyError) !== -1, resultText.slice(0, 90)]);

  /* 跨工具跳转按钮 */
  await ex('document.getElementById("' + expect.crossBtn + '").click();');
  await sleep(400);
  push(results, name, ['跳转 ' + expect.crossTool, lastOpenedTool === expect.crossTool, lastOpenedTool || '(未触发)']);

  /* 深度切换 */
  const deepOn = await ex('(function(){var chips=document.querySelectorAll(".depth-chip");chips[1].click();return chips[1].classList.contains("active");})()');
  push(results, name, ['深度切换', deepOn]);

  return results;
}

/* 研究台：界面形态与面板类工具不同（搜索框 + 双栏 + 独立对话），单独一套步骤 */
async function testResearchRenderer(win, htmlPath) {
  const name = '研究台';
  currentTool = 'research'; currentStub = { lastTopic: '抑郁症患病率' }; lastOpenedTool = ''; lastTitle = null;
  await win.loadFile(htmlPath);
  await sleep(1200);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];

  push(results, name, ['桥接已改用壳的 academyTool', await ex('!!window.academyTool')]);
  push(results, name, ['旧的 academyResearch 桥已下线', !(await ex('!!window.academyResearch'))]);

  await sleep(500);
  const conn = await ex(readEl('connState', 'textContent'));
  const appVisible = await ex(appVisibleJs);
  push(results, name, ['初始化展开界面', appVisible && conn.indexOf('已连接') !== -1, conn + ' / app可见=' + appVisible]);

  push(results, name, ['initOpts 回灌最近辩题', (await ex(readEl('topic', 'value'))) === '抑郁症患病率']);

  /* 检索方式：注册表 defaults 声明默认深度检索，chip 的 active 必须跟着 initOpts 走 */
  const chipSig = '(function(){var c=document.querySelectorAll(".mode-chip");return (c[0].classList.contains("active")?"S":"-")+(c[1].classList.contains("active")?"F":"-");})()';
  const modeServer = await ex(chipSig);
  push(results, name, ['默认深度检索（存档 mode=server）', modeServer === 'S-', modeServer]);
  await ex('document.querySelectorAll(".mode-chip")[1].click();');
  const modeFree = await ex(chipSig);
  push(results, name, ['检索方式可切换', modeFree === '-F', modeFree]);
  await ex('document.querySelectorAll(".mode-chip")[0].click();');

  await ex('(function(){document.getElementById("topic").value="";document.getElementById("btnSearch").click();})()');
  await sleep(400);
  const toastEmpty = await ex(readEl('toast', 'textContent'));
  push(results, name, ['空输入拦截', toastEmpty.indexOf('先输入要搜的内容') !== -1, toastEmpty]);

  await ex('(function(){document.getElementById("topic").value="中国抑郁症患病率 流行病学";document.getElementById("btnSearch").click();})()');
  await sleep(6000);
  const boxText = await ex(readEl('resultsBox', 'textContent'));
  push(results, name, ['搜索全链路（隔离环境无 Key → 服务端明确报错）', boxText.indexOf('未配置 API Key') !== -1, boxText.slice(0, 90)]);

  /* 渲染层只上交关键词，「 · 工具名」由壳的 setTitle 拼接。
     拼接责任错位就会让窗口标题出现两遍「研究台」，所以钉住上交的内容。 */
  push(results, name, ['标题只交关键词（拼接归壳）', !!lastTitle && lastTitle.indexOf('研究台') === -1, String(lastTitle)]);

  await ex('document.getElementById("btnVerify").click();');
  await sleep(400);
  push(results, name, ['跳转 verify', lastOpenedTool === 'verify', lastOpenedTool || '(未触发)']);

  await ex('(function(){document.getElementById("topic").value="";document.getElementById("btnSuggest").click();})()');
  await sleep(400);
  const toastSug = await ex(readEl('toast', 'textContent'));
  push(results, name, ['建议词空输入拦截', toastSug.indexOf('先输入辩题或关键词') !== -1, toastSug]);

  return results;
}

app.whenReady().then(async () => {
  registerIpc();
  const all = [];
  const win = new BrowserWindow({ width: 1080, height: 780, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(ROOT, 'app', 'tool-preload.js') } });
  all.push(...await testResearchRenderer(win, path.join(ROOT, 'app', 'research', 'renderer.html')));
  all.push(...await testPanelRenderer(win, path.join(ROOT, 'app', 'verify', 'renderer.html'), 'verify', '证据检证', {
    emptyToast: '先把要核查的论据贴进来',
    noKeyError: '未配置 API Key',
    input: '据《柳叶刀》2019 年研究，中国有 9500 万抑郁症患者。',
    crossBtn: 'btnGoTrace', crossTool: 'trace',
  }));
  all.push(...await testPanelRenderer(win, path.join(ROOT, 'app', 'trace', 'renderer.html'), 'trace', '资料溯源', {
    emptyToast: '先把要溯源的资料贴进来',
    noKeyError: '未配置 API Key',
    input: '「爱因斯坦说过，疯子就是重复做同一件事却期待不同结果。」',
    crossBtn: 'btnGoVerify', crossTool: 'verify',
  }));
  await win.destroy();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(all, null, 2), 'utf8');
  const fails = all.filter((r) => !r.pass);
  console.log('工具窗验证：' + (all.length - fails.length) + '/' + all.length + ' 通过');
  for (const r of all) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
  app.quit();
  if (fails.length) process.exitCode = 1;
}).catch(function (e) { console.error('ERR ' + e.message); app.quit(); process.exitCode = 1; });
