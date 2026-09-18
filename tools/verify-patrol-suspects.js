#!/usr/bin/env node
/* 巡检可疑项的定向复核（Electron 实跑）。
 *
 * 背景：ui-patrol 的快照看的是 body 前 1200 字符 + hidden 元素数，
 * 设置弹窗在 DOM 末尾，#settingsResult 的反馈、input type 切换、
 * 纯 class 切换对快照都不可见 —— 这些「无反应」多数是假阴性。
 * 本脚本对「快照判不了」的项逐一给真断言。
 *
 * 用法（必须用 Electron 跑）：
 *   .\runtime\electron\dist\electron.exe tools/verify-patrol-suspects.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8795）上已有隔离数据目录的服务在跑。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-patrol-suspects.json');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 940, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2500);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];

  const openSettingsTab = (tab) => ex(
    'document.getElementById("btnSettings").click();' +
    '(function(){var i=document.querySelector(".settings-nav .settings-nav-item[data-settings-pane=\\"' + tab + '\\"]");if(i)i.click();return !!i;})()'
  );
  const closeModals = () => ex(
    'Array.prototype.slice.call(document.querySelectorAll(".modal")).forEach(function(m){m.classList.add("hidden");});'
  );
  const resultText = () => ex('(document.getElementById("settingsResult")||{textContent:""}).textContent');

  /* ---- 1. 保存配置（空表单）→ settingsResult 应提示必填 ---- */
  await openSettingsTab('model'); await sleep(800);
  await ex('document.getElementById("btnSaveProfile").click();');
  await sleep(500);
  const t1 = await resultText();
  results.push({ case: '保存配置（空表单）给提示', pass: /API Key/.test(t1), got: t1 });

  /* ---- 2. 测试连接（空 Key）→ settingsResult 应有反馈 ---- */
  await ex('document.getElementById("btnTestKey").click();');
  await sleep(3000);
  const t2 = await resultText();
  results.push({ case: '测试连接（空 Key）给反馈', pass: t2.trim().length > 0, got: t2.slice(0, 80) });

  /* ---- 3. 获取模型（空 Key）→ settingsResult 或模型下拉应有变化 ---- */
  const optBefore = await ex('document.querySelectorAll("#modelSelect option").length');
  await ex('document.getElementById("btnLoadModels").click();');
  await sleep(3000);
  const optAfter = await ex('document.querySelectorAll("#modelSelect option").length');
  const t3 = await resultText();
  results.push({ case: '获取模型（空 Key）给反馈', pass: t3.trim().length > 0 || optAfter !== optBefore, got: (t3 || '(无文字)') + ' / 选项 ' + optBefore + '->' + optAfter });

  /* ---- 4. ＋ 新建配置 → 至少给一句 toast 反馈（Pro 线同款问题已修，Flash 需对齐） ---- */
  await ex('document.getElementById("btnNewProfile").click();');
  await sleep(600);
  const toast4 = await ex('(function(){var t=document.getElementById("toast");return t&&!t.classList.contains("hidden")?t.textContent:"";})()');
  results.push({ case: '＋新建配置给反馈', pass: toast4.trim().length > 0, got: toast4 || '(无 toast)' });

  /* ---- 5. 记忆 · ＋新增长期记忆 → #memNewBox 应出现 ---- */
  await closeModals();
  await ex('document.getElementById("btnMemory").click();');
  await sleep(1200);
  await ex('(function(){var b=Array.prototype.slice.call(document.querySelectorAll("#memoryModal button"));' +
    'for(var i=0;i<b.length;i++){if((b[i].textContent||"").indexOf("新增长期记忆")>=0){b[i].click();return;}}}())');
  await sleep(800);
  const memBox = await ex('!!document.getElementById("memNewBox")');
  results.push({ case: '记忆·新增输入框出现', pass: !!memBox, got: String(memBox) });

  /* ---- 6. 资料库 · 试检索（空库）→ 结果区应有文字反馈 ---- */
  await closeModals();
  await ex('document.getElementById("btnLibrary").click();');
  await sleep(1200);
  const r6 = await ex('(function(){var inp=document.getElementById("libSearchInput");if(inp){inp.value="测试关键词";}var b=document.getElementById("btnLibSearch");if(b){b.click();return true;}return false;})()');
  await sleep(2500);
  const r6b = await ex('(function(){var els=document.querySelectorAll("#libraryModal .lib-result, #libraryModal .lib-empty, #libraryModal [class*=result]");' +
    'for(var i=0;i<els.length;i++){if((els[i].textContent||"").trim())return els[i].textContent.trim().slice(0,60);}return "";})()');
  results.push({ case: '资料库·试检索给反馈', pass: !!r6 && String(r6b).length > 0, got: '点了=' + r6 + ' 反馈=' + String(r6b).slice(0, 60) });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const fails = results.filter((r) => !r.pass);
  console.log('可疑项复核：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
  app.quit();
  if (fails.length) process.exitCode = 1;
}).catch(function (e) { console.error('ERR ' + e.message); app.quit(); process.exitCode = 1; });
