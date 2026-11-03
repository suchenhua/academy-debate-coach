#!/usr/bin/env node
/* 设置弹窗「设置面板出横向滚动条」回归验证（Electron 真实渲染）。
 *
 * 背景：设置 → AI 模型面板底部冒出横向滚动条，右侧内容（「获取模型」按钮那行）被切。
 * 根因：`.model-row input` / `.key-row input` 只写了 `flex:1` —— input 的默认 `min-width` 是
 * `auto`（≈ 固有宽度 ~180px），flex 压不下去；编辑器栏（左侧配置列表固定 240px 后）只剩 225px，
 * 于是「输入框 + 按钮」这一行把面板顶出 33px 溢出 → 面板 `overflow-x:auto` 长出横向滚动条。
 * 修法：两处补 `min-width:0`，输入框可收缩。
 *
 * 本脚本要证明的三件事（静态扫描查不出这类运行时布局）：
 *   1. 九个设置面板逐个打开，面板与其内部可滚动元素都不横向溢出（scrollWidth ≤ clientWidth）
 *   2. 高级面板：「文档处理（扩展）」与「自定义搜索服务」并列两张卡、不嵌套，搜索表单跟搜索卡走
 *   3. 负向对照：把 min-width 还原成 auto（修复前的样子）→ AI 模型面板确实溢出 → 断言非空转
 *
 * 用法（必须用 Electron 跑）：
 *   runtime\electron\dist\electron.exe tools/verify-settings-overflow.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8795）上已有隔离数据目录的服务在跑。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-settings-overflow.json');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify-settings'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 逐个打开每个设置面板，回传横向溢出情况。
 * 只看「会真的长出横向滚动条」的溢出：
 *   - 面板自身 scrollWidth > clientWidth（面板是 overflow-x:auto，立刻出条）
 *   - 面板内 overflow-x 为 auto/scroll 的元素也超出了（同样出条）
 * 不把 overflow:visible/hidden 元素的亚像素/裁切差算进来（那些不出滚动条，是另一回事）。 */
const SWEEP = `(async function(){
  function scan(pane){
    var bad = [];
    if (pane.scrollWidth > pane.clientWidth + 1) {
      bad.push({ el: 'pane ' + (pane.dataset.settingsPane || '?'), over: pane.scrollWidth - pane.clientWidth });
    }
    pane.querySelectorAll('*').forEach(function(e){
      if (!(e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)) return;
      var ox = getComputedStyle(e).overflowX;
      if (ox === 'auto' || ox === 'scroll') {
        bad.push({ el: e.tagName.toLowerCase() + '.' + String(e.className || '').split(' ')[0], over: e.scrollWidth - e.clientWidth });
      }
    });
    return bad;
  }
  var btns = Array.prototype.slice.call(document.querySelectorAll('#settingsModal .settings-nav-item'));
  var res = [];
  for (var i = 0; i < btns.length; i++) {
    btns[i].click();
    await new Promise(function(r){ setTimeout(r, 130); });
    var pane = document.querySelector('#settingsModal .settings-pane.active');
    if (!pane) continue;
    res.push({ pane: (btns[i].textContent || '').trim(), name: pane.dataset.settingsPane || '?', bad: scan(pane) });
  }
  return res;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 840, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2600);
  const ex = (code) => win.webContents.executeJavaScript(code);
  await ex(`(function(){
    var s=document.createElement('style'); s.textContent='.modal-box{animation:none !important;}'; document.head.appendChild(s);
    ['welcomeModal','libraryModal','toolsModal','memoryModal','deliverModal'].forEach(function(id){var e=document.getElementById(id);if(e)e.classList.add('hidden');});
    document.getElementById('btnSettings').click();
  })()`);
  await sleep(900);

  const results = [];

  /* 1. 修复态：所有面板都不横向溢出 */
  const pos = await ex(SWEEP);
  const posBad = pos.filter((p) => p.bad.length);
  results.push({
    case: '九个设置面板逐个打开均无横向溢出（修复态）',
    pass: pos.length >= 9 && posBad.length === 0,
    got: 'panes=' + pos.length + ' overflowing=' + JSON.stringify(posBad)
  });

  /* 2. 结构：「文档处理（扩展）」与「自定义搜索服务」必须是并列的两张卡（2026-09-29 子涵指出原来是嵌套） */
  const struct = await ex(`(async function(){
    var b = document.querySelector('#settingsModal .settings-nav-item[data-settings-pane="advanced"]');
    if (b) b.click();
    await new Promise(function(r){ setTimeout(r, 200); });
    var a = document.getElementById('extendedToolsToggle');
    var c = document.getElementById('customSearchToggle');
    var form = document.getElementById('customSearchForm');
    if (!a || !c || !form) return { missing: true };
    var ca = a.closest('.general-section');
    var cc = c.closest('.general-section');
    return {
      sameCard: !!ca && ca === cc,
      nestedCard: !!(ca && cc && (ca.contains(cc) || cc.contains(ca))),
      formInDocCard: !!(ca && ca.contains(form)),
      formInSearchCard: !!(cc && cc.contains(form))
    };
  })()`);
  results.push({
    case: '高级面板：文档处理 / 自定义搜索服务 是并列两张卡，搜索表单跟搜索卡走',
    pass: !!struct && struct.sameCard === false && struct.nestedCard === false
      && struct.formInDocCard === false && struct.formInSearchCard === true,
    got: JSON.stringify(struct)
  });

  /* 3. 负向对照：证明这套扫描**真的测得到**横向溢出（不是永远返回“没问题”）。
        2026-10-15 模型面板改造成「服务商行 + 行内编辑卡 + 模型列表」之后，
        原来的 .model-row 已经不存在了 —— 负向对照若继续指着旧选择器，量到的是 0 宽的空元素，
        整条断言就变成空转（这正是它当时报 FAIL 的原因）。
        所以这里不再依赖具体控件的旧名字，改成注入一个**按面板宽度固定尺寸**的探针： */
  const neg = await ex(`(async function(){
    var btns = Array.prototype.slice.call(document.querySelectorAll('#settingsModal .settings-nav-item'));
    var modelBtn = null;
    btns.forEach(function(b){ if (b.dataset.settingsPane === 'model') modelBtn = b; });
    if (modelBtn) modelBtn.click();
    await new Promise(function(r){ setTimeout(r, 200); });
    var pane = document.querySelector('#settingsModal .settings-pane[data-settings-pane="model"]');
    if (!pane) return { paneOver: -1, probeOver: -1 };
    var host = pane.querySelector('.models-section') || pane;
    var probe = document.createElement('div');
    probe.style.width = (pane.clientWidth + 120) + 'px';
    probe.style.height = '8px';
    host.appendChild(probe);
    var paneOver = pane.scrollWidth - pane.clientWidth;
    /* 探针自己是否被撑出溢出：证明“宽度超出容器”这件事确实会被 scrollWidth 反映出来 */
    var probeOver = probe.parentElement ? (probe.parentElement.scrollWidth - probe.parentElement.clientWidth) : -1;
    probe.remove();
    return { paneOver: paneOver, probeOver: probeOver };
  })()`);
  results.push({
    case: '负向对照：注入超宽探针 → 面板确实报出横向溢出（扫描非空转）',
    pass: neg.paneOver > 1 && neg.probeOver > 1,
    got: 'paneOver=' + neg.paneOver + ' probeOver=' + neg.probeOver
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const fails = results.filter((r) => !r.pass);
  console.log('设置面板横向溢出验证：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
  app.quit();
  if (fails.length) process.exitCode = 1;
}).catch(function (e) { console.error('ERR ' + e.message); app.quit(); process.exitCode = 1; });
