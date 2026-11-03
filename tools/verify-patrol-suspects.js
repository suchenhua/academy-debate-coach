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

  const BAD = 'https://evil-collector.example/v1';   // 陌生主机探针

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

  /* ---- 3. 获取模型（空 Key）→ settingsResult 或候选选择器应有变化 ---- */
  const pickBefore = await ex('!!document.getElementById("modelPicker") && !document.getElementById("modelPicker").classList.contains("hidden")');
  await ex('document.getElementById("btnLoadModels").click();');
  await sleep(3000);
  const pickAfter = await ex('!!document.getElementById("modelPicker") && !document.getElementById("modelPicker").classList.contains("hidden")');
  const t3 = await resultText();
  results.push({ case: '获取模型（空 Key）给反馈', pass: t3.trim().length > 0 || pickAfter !== pickBefore, got: (t3 || '(无文字)') + ' / 选择器 ' + pickBefore + '->' + pickAfter });

  /* ---- 4. ＋ 添加服务商 → 至少给一句 toast 反馈（Pro 线同款问题已修，Flash 需对齐） ---- */
  await ex('(function(){ var b=document.getElementById("btnAddProvider"); if(b){ b.click(); return 1; } return 0; })()');
  await sleep(600);
  const toast4 = await ex('(function(){var t=document.getElementById("toast");return t&&!t.classList.contains("hidden")?t.textContent:"";})()');
  results.push({ case: '＋添加服务商给反馈', pass: toast4.trim().length > 0, got: toast4 || '(无 toast)' });

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

  /* ============ 7-11：巡检报「无反应」的其余项，逐条给真断言 ============
     共同结论：这些控件在「隔离空态 + 快照只看 body 前 1200 字符」下确实没有可见变化，
     但功能本身是好的 —— 所以断言要打在它们真正会改的东西上（输入框、激活态、筛选态）。 */

  await closeModals();

  /* ---- 7. 顶栏 · 新对话：空会话点它是「正确地没反应」；先造出输入内容才看得出清空 ---- */
  const n7 = await ex(
    '(function(){var i=document.getElementById("input");i.value="巡检临时输入";' +
    'document.getElementById("btnNew").click();' +
    'return JSON.stringify({cleared:i.value==="",focused:document.activeElement===i,msgs:state.messages.length});})()'
  );
  const c7 = JSON.parse(n7);
  results.push({ case: '顶栏·新对话清空输入并聚焦', pass: c7.cleared && c7.focused && c7.msgs === 0, got: n7 });

  /* ---- 8. 模式切换 · 自由问答：默认就停在它身上，点自己不改快照是对的；点别的必须改 ---- */
  const n8 = await ex(
    '(function(){var b=Array.prototype.slice.call(document.querySelectorAll(".mode-btn"));' +
    'var free=b.filter(function(x){return x.dataset.mode==="free";})[0];' +
    'var other=b.filter(function(x){return x.dataset.mode!=="free";})[0];' +
    'var t0=document.getElementById("modeTitle").textContent;' +
    'var wasActive=!!(free&&free.classList.contains("active"));' +
    'if(free)free.click(); var sameSelf=document.getElementById("modeTitle").textContent===t0;' +
    'if(other)other.click(); var tOther=document.getElementById("modeTitle").textContent; var modeOther=state.mode;' +
    'if(free)free.click();' +
    'return JSON.stringify({wasActive:wasActive,sameSelf:sameSelf,modeOther:modeOther,titleChanged:tOther!==t0,titleBack:document.getElementById("modeTitle").textContent===t0});})()'
  );
  const c8 = JSON.parse(n8);
  results.push({ case: '模式切换·自由问答默认激活且切模式真的生效', pass: c8.wasActive && c8.sameSelf && c8.titleChanged && c8.modeOther !== 'free' && c8.titleBack, got: n8 });

  /* ---- 9. 输入区 · 发送：空输入只聚焦输入框；有内容必须走真实分支（无 Key → 打开设置） ---- */
  const n9a = await ex(
    '(function(){var i=document.getElementById("input");i.value="";' +
    'document.getElementById("btnSend").click();' +
    'return JSON.stringify({msgs:state.messages.length,running:state.running,focused:document.activeElement===i});})()'
  );
  const c9a = JSON.parse(n9a);
  results.push({ case: '发送·空输入不发消息只聚焦', pass: c9a.msgs === 0 && !c9a.running && c9a.focused, got: n9a });
  const n9b = await ex(
    '(function(){var i=document.getElementById("input");i.value="巡检发送探测";' +
    'document.getElementById("btnSend").click();' +
    'var sm=document.getElementById("settingsModal");' +
    'return JSON.stringify({settingsOpen:!!(sm&&!sm.classList.contains("hidden")),msgs:state.messages.length,running:state.running});})()'
  );
  const c9b = JSON.parse(n9b);
  results.push({ case: '发送·未配 Key 时打开设置而非静默', pass: c9b.settingsOpen || c9b.msgs > 0, got: n9b });
  await closeModals();

  /* ---- 10. 产物空间 · 「文件」tab 与「全部」chip 都在默认激活位；换一个必须真的改筛选态 ---- */
  await ex('document.getElementById("btnDeliver").click();');
  await sleep(1200);
  const n10 = await ex(
    '(function(){var tabF=document.querySelector(".deliver-tab[data-dtab=files]");' +
    'var tabC=document.querySelector(".deliver-tab[data-dtab=cases]");' +
    'var chipAll=document.querySelector("#deliverChips .chip[data-dfilter=all]");' +
    'var chipDoc=document.querySelector("#deliverChips .chip[data-dfilter=doc]");' +
    'var r={tabFilesActive:!!(tabF&&tabF.classList.contains("active")),chipAllActive:!!(chipAll&&chipAll.classList.contains("active"))};' +
    'if(chipDoc)chipDoc.click(); r.filterDoc=deliverState.filter; r.chipAllAfter=!!(chipAll&&chipAll.classList.contains("active"));' +
    'if(chipAll)chipAll.click(); r.filterBack=deliverState.filter;' +
    'if(tabC)tabC.click(); r.tabCases=deliverState.tab;' +
    'if(tabF)tabF.click(); r.tabBack=deliverState.tab;' +
    'return JSON.stringify(r);})()'
  );
  const c10 = JSON.parse(n10);
  results.push({ case: '产物空间·tab/chip 默认激活且切换改筛选态', pass: c10.tabFilesActive && c10.chipAllActive && c10.filterDoc === 'doc' && !c10.chipAllAfter && c10.filterBack === 'all' && c10.tabCases === 'cases' && c10.tabBack === 'files', got: n10 });

  /* ---- 11. 资料库 · 「全部」chip 同上 ---- */
  await closeModals();
  await ex('document.getElementById("btnLibrary").click();');
  await sleep(1500);
  const n11 = await ex(
    '(function(){var chipAll=document.querySelector("#libChips .chip[data-lfilter=all]");' +
    'var chipDoc=document.querySelector("#libChips .chip[data-lfilter=doc]");' +
    'var r={chipAllActive:!!(chipAll&&chipAll.classList.contains("active")),filter0:libState.filter};' +
    'if(chipDoc)chipDoc.click(); r.filterDoc=libState.filter; r.docActive=!!(chipDoc&&chipDoc.classList.contains("active"));' +
    'if(chipAll)chipAll.click(); r.filterBack=libState.filter;' +
    'return JSON.stringify(r);})()'
  );
  const c11 = JSON.parse(n11);
  results.push({ case: '资料库·全部 chip 默认激活且切换改筛选态', pass: c11.chipAllActive && c11.filterDoc === 'doc' && c11.docActive && c11.filterBack === 'all', got: n11 });
  await closeModals();

  /* ---- 12. 设置-模型 · 「＋ 自定义接口」卡片：地址保持原值、焦点落到地址框、护栏提示同步 ---- */
  await openSettingsTab('model'); await sleep(800);
  const n12 = await ex(
    '(function(){var b=document.getElementById("baseUrlInput");var cur=b.value;' +
    'var cards=Array.prototype.slice.call(document.querySelectorAll(".provider-card"));' +
    'var norm=cards.filter(function(c){return c.dataset.id!=="custom";});' +
    'var hit=norm.filter(function(c){return String(cur).startsWith(c.dataset.baseurl||"___");})[0];' +
    'var expectId=hit?hit.dataset.id:"custom";' +
    'document.querySelector(\'.provider-card[data-id="custom"]\').click();' +
    'var hint=document.getElementById("endpointHint");' +
    'var active=document.querySelector(".provider-card.active");' +
    'return JSON.stringify({valueKept:b.value===cur,expectActive:expectId,' +
    'activeId:active?active.dataset.id:null,hintText:hint.textContent,hintWarn:hint.classList.contains("warn")});})()'
  );
  const c12 = JSON.parse(n12);
  results.push({ case: '自定义接口卡片·地址不变且护栏提示同步', pass: c12.valueKept && c12.activeId === c12.expectActive && !c12.hintWarn && c12.hintText.indexOf('api.deepseek.com') >= 0, got: n12 });

  /* ---- 13. 手输地址 → 护栏提示必须实时跟着变（陌生主机要标红） ---- */
  const n13 = await ex(
    '(function(){var b=document.getElementById("baseUrlInput");var orig=b.value;' +
    'b.value="' + BAD + '";b.dispatchEvent(new Event("input"));' +
    'var h=document.getElementById("endpointHint");' +
    'var r={badText:h.textContent,badWarn:h.classList.contains("warn")};' +
    'b.value=orig;b.dispatchEvent(new Event("input"));' +
    'r.backText=h.textContent;r.backWarn=h.classList.contains("warn");' +
    'b.value=orig;return JSON.stringify(r);})()'
  );
  const c13 = JSON.parse(n13);
  results.push({ case: '手输陌生地址实时标红、改回来实时撤销', pass: c13.badWarn && c13.badText.indexOf('evil-collector.example') >= 0 && !c13.backWarn && c13.backText.indexOf('api.deepseek.com') >= 0, got: n13 });

  /* ---- 14. 设置-高级 · 增强检索「保存」写 #modsearchResult（弹窗内，快照不可见） ---- */
  await openSettingsTab('advanced'); await sleep(800);
  await ex('document.getElementById("btnModsearchSave").click();');
  await sleep(1500);
  const t13 = await ex('(document.getElementById("modsearchResult")||{textContent:""}).textContent');
  results.push({ case: '增强检索·保存给出结果文案', pass: /已保存|失败/.test(t13), got: String(t13).slice(0, 60) });
  await closeModals();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const fails = results.filter((r) => !r.pass);
  console.log('可疑项复核：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
  app.quit();
  if (fails.length) process.exitCode = 1;
}).catch(function (e) { console.error('ERR ' + e.message); app.quit(); process.exitCode = 1; });
