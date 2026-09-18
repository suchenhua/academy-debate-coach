#!/usr/bin/env node
/* 独立工具窗（证据检证 / 资料溯源）实跑验证。
 *
 * 为什么不直接 spawn tool-window.js 再断言：那是独立进程，外面摸不到渲染层。
 * 本脚本用同一套 IPC 通道（tool:init / tool:proxy…）加载**真实的 renderer.html**，
 * 走真实主 App 服务（ACADEMY_DATA_DIR 隔离数据目录），断言到「服务器返回错误」这一层。
 *
 * 用法（必须用 Electron 跑）：
 *   .\runtime\electron\dist\electron.exe tools/verify-tool-windows.js <项目根> [输出json]
 * 前置：TOOLTEST_PORT（默认 8790）上已有隔离数据目录的服务在跑。
 */
'use strict';
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

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
let lastOpenedTool = '';
function registerIpc() {
  ipcMain.handle('tool:init', async () => ({ ok: true, port: PORT, tool: 'verify', opts: { lastInput: '' } }));
  ipcMain.handle('tool:saveOpts', () => ({ ok: true }));
  ipcMain.handle('tool:proxy', (_e, payload) => proxyFetch(PORT, payload || {}));
  ipcMain.handle('tool:copyText', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
  ipcMain.handle('tool:setTitle', () => ({ ok: true }));
  ipcMain.handle('tool:openTool', (_e, payload) => { lastOpenedTool = String((payload || {}).name || ''); return { ok: true }; });
}

async function testRenderer(win, htmlPath, name, expect) {
  /* ⚠️ 必须复用同一个窗口顺序加载：
     实测「加载 A → destroy → 加载 B」时第二个 loadFile 必报 ERR_FAILED(-2)，
     与加载哪个文件无关；同窗口连续 loadFile 则一直正常。 */
  await win.loadFile(htmlPath);
  await sleep(1200);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const bridge = await ex('!!window.academyTool');
  results.push({ case: name + ' · preload 桥接入', pass: !!bridge });

  /* 初始化后界面展开、连接指示变绿 */
  await sleep(400);
  const conn = await ex('(function(){var c=document.getElementById("connState");return c?c.textContent:"(无)";})()');
  const appVisible = await ex('(function(){var a=document.getElementById("app");return a&&!a.classList.contains("hidden");})()');
  results.push({ case: name + ' · 初始化展开界面', pass: appVisible && conn.indexOf('已连接') !== -1, got: conn + ' / app可见=' + appVisible });

  /* 空输入点击运行 → toast 拦截 */
  await ex('document.getElementById("btnRun").click();');
  await sleep(400);
  const toastEmpty = await ex('(function(){var t=document.getElementById("toast");return t?t.textContent:"";})()');
  results.push({ case: name + ' · 空输入拦截', pass: toastEmpty.indexOf(expect.emptyToast) !== -1, got: toastEmpty });

  /* 填入论据点运行 → 服务端（未配 Key）返回业务错误，证明全链路到服务器 */
  await ex('(function(){var i=document.getElementById("workInput");i.value=' + JSON.stringify(expect.input) + ';document.getElementById("btnRun").click();})()');
  await sleep(6000);
  const resultText = await ex('(function(){var b=document.getElementById("workResult");return b?b.textContent:"(无)";})()');
  results.push({ case: name + ' · 全链路（隔离环境无 Key → 服务端明确报错）', pass: resultText.indexOf(expect.noKeyError) !== -1, got: resultText.slice(0, 90) });

  /* 跨工具跳转按钮 */
  await ex('document.getElementById("' + expect.crossBtn + '").click();');
  await sleep(400);
  results.push({ case: name + ' · 跳转 ' + expect.crossTool, pass: lastOpenedTool === expect.crossTool, got: lastOpenedTool || '(未触发)' });

  /* 深度切换 */
  const deepOn = await ex('(function(){var chips=document.querySelectorAll(".depth-chip");chips[1].click();return chips[1].classList.contains("active");})()');
  results.push({ case: name + ' · 深度切换', pass: !!deepOn });

  return results;
}

app.whenReady().then(async () => {
  registerIpc();
  const all = [];
  const win = new BrowserWindow({ width: 860, height: 720, show: false, webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(ROOT, 'app', 'tool-preload.js') } });
  all.push(...await testRenderer(win, path.join(ROOT, 'app', 'verify', 'renderer.html'), '证据检证', {
    emptyToast: '先把要核查的论据贴进来',
    noKeyError: '未配置 API Key',
    input: '据《柳叶刀》2019 年研究，中国有 9500 万抑郁症患者。',
    crossBtn: 'btnGoTrace', crossTool: 'trace',
  }));
  all.push(...await testRenderer(win, path.join(ROOT, 'app', 'trace', 'renderer.html'), '资料溯源', {
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
