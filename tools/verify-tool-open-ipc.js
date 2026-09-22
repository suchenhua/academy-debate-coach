#!/usr/bin/env node
/* 工具箱按钮 → preload 桥 → IPC 载荷 这一段是巡检的盲区：
 * ui-patrol.js 的巡检窗故意不挂 preload，所以它只能看到「点了有没有反馈」，
 * 摸不到 window.academyElectron —— 按钮改名、桥方法改名、name 传错这类断链它一概测不出。
 * 09-19 那轮的「辩题改名 prompt 断链」就是这一类的孪生问题。
 *
 * 本脚本自己**不跑** electron-main（那是另一个主进程入口），而是给 app:openTool 挂一个
 * 记账用的假处理器：只验「渲染层有没有把正确的工具名送到主进程」，
 * 主进程拿到名字后 spawn 得对不对，由 run-tool-window-tests.js 起真壳、核对启动日志来管。
 *
 * 用法：electron.exe tools/verify-tool-open-ipc.js <项目根> <端口> [输出json]
 */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { TOOLS } = require(path.join(process.argv[2], 'app', 'tool-registry.js'));

const ROOT = process.argv[2];
const PORT = Number(process.argv[3]);
const OUT = process.argv[4] || path.join(ROOT, '.build', 'verify-tool-open-ipc.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setName('Academy Tool Open Probe');
try { app.setPath('userData', path.join(ROOT, '.build', 'tooltest-data', 'electron-user-data-open-probe')); } catch (_) {}

const opened = [];
ipcMain.handle('app:openTool', (_e, payload) => { opened.push(String((payload || {}).name || '')); return { ok: true }; });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    /* 真实 preload —— 这条链要验的就是桥本身 */
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(ROOT, 'app', 'preload.js') },
  });
  const results = [];
  const push = (c, pass, got) => results.push({ case: c, pass: !!pass, got: got == null ? '' : String(got) });
  try {
    await win.loadURL('http://127.0.0.1:' + PORT + '/');
    await sleep(2500);
    const ex = (code) => win.webContents.executeJavaScript(code);

    push('主窗口 preload 暴露 openToolWindow', await ex('!!(window.academyElectron && window.academyElectron.openToolWindow)'));
    push('旧的三个近重复入口已收口', !(await ex('!!(window.academyElectron.openResearch || window.academyElectron.openVerifyTool || window.academyElectron.openTraceTool)')));

    /* 逐个工具：工具箱里存在带 data-tool 的按钮 → 点它 → 主进程收到正确的 name */
    for (const id of Object.keys(TOOLS)) {
      opened.length = 0;
      const clicked = await ex('(function(){var b=document.querySelector(\'[data-tool="' + id + '"]\');if(!b)return false;b.click();return true;})()');
      push('工具箱按钮 data-tool=' + id + ' 存在', clicked);
      await sleep(400);
      push('点击后主进程收到 name=' + id, opened.length === 1 && opened[0] === id, JSON.stringify(opened));
    }

    /* 成功打开后工具箱弹窗自动收起（app.js 的 onclick 收尾，断了就是「点了没反应」） */
    push('打开成功后弹窗自动收起', await ex('document.getElementById("toolsModal").classList.contains("hidden")'));
  } catch (e) {
    push('探测过程异常', false, e.message);
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
    const fails = results.filter((r) => !r.pass);
    console.log('工具箱入口链：' + (results.length - fails.length) + '/' + results.length + ' 通过');
    for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
    app.quit();
    if (fails.length) process.exitCode = 1;
  }
}).catch(function (e) {
  console.error('ERR ' + e.message);
  app.quit();
  process.exitCode = 1;
});
