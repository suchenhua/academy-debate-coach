#!/usr/bin/env node
/* 资料库「切分类 chip 弹窗跳大小」回归验证（Electron 真实渲染）。
 *
 * 背景：资料库弹窗按内容定高，分类 chip（全部/文档/Word/PDF/图片OCR/其他）切换时
 * 条目数不同 → .lib-list 高度不同 → 整个弹窗跟着一伸一缩。
 * 与产物空间（tools/verify-deliver-tabs.js）同一个病根：
 *   ui.css 的 .modal-body{flex:1} = flex: 1 1 0%，basis 0% 让 height 不再参与主轴尺寸计算。
 * 修法：`.library-box .modal-body{flex:1 1 auto; height:min(660px,78vh)}` + `.lib-list{flex:1;min-height:0}`。
 *
 * 本脚本要证明的三件事（静态扫描查不出这类运行时问题）：
 *   1. 全部/文档/其他/PDF 分类来回切，弹窗高度恒定
 *   2. 定高确实来自 CSS：.modal-body 的计算 flex-basis 是 auto，且计算高度 = min(660px, 78vh)
 *   3. 负向对照：注入旧的 flex:1 1 0% → basis 归零、高度退回内容高度、切分类抖动复现
 *
 * 两个测试脚本自身的坑（踩过，勿改回去）：
 *   a. 隐藏窗口（show:false）不推进 CSS 动画，.modal-box 会永远停在 modal-in 的
 *      from 帧（transform: scale(.97)）。对策：先注入 `.modal-box{animation:none !important}`。
 *   b. getComputedStyle 返回的是**活对象**：必须在移除注入的 <style> **之前**取 flexBasis 快照。
 *
 * 用法（必须用 Electron 跑）：
 *   runtime\electron\dist\electron.exe tools/verify-library-tabs.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8795）上已有隔离数据目录的服务在跑（脚本会往资料库塞几条测试数据并清理）。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-library-tabs.json');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify-library'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 往隔离服务的资料库塞测试条目（doc 分类 3 条 + other 分类 1 条），返回 id 供清理 */
function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({ raw: s }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seed() {
  const ids = [];
  const seeds = [
    ['__v_lib_doc1.md', '验证资料一：攻防分级与打钉子话术'],
    ['__v_lib_doc2.md', '验证资料二：语境铺陈与击穿战场'],
    ['__v_lib_doc3.md', '验证资料三：偷换预判与质询设计'],
    ['__v_lib_other.xyz', '验证资料四：非文档分类，用于拉出条目数差'],
  ];
  for (const [name, text] of seeds) {
    const r = await api('POST', '/api/library/upload', { name, text });
    if (r && r.ok && r.item && r.item.id) ids.push(r.item.id);
  }
  return ids;
}
async function cleanup(ids) {
  for (const id of ids) { try { await api('POST', '/api/library/delete', { id }); } catch (_) {} }
}

app.whenReady().then(async () => {
  const seeded = await seed();
  const win = new BrowserWindow({ width: 1180, height: 760, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2500);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];

  /* 打开资料库弹窗，并关掉 modal-in 动画（隐藏窗口不推进动画，否则 rect 会被 scale(.97) 缩掉） */
  const opened = await ex(`(function(){
    var st = document.createElement('style');
    st.id = '__noanim';
    st.textContent = '#libraryModal .modal-box{animation:none !important;}';
    document.head.appendChild(st);
    var b = document.getElementById('btnLibrary');
    if (b) b.click();
    return !document.getElementById('libraryModal').classList.contains('hidden');
  })()`);
  await sleep(1200);

  const seededCount = await ex(`document.querySelectorAll('#libList .lib-item').length`);

  /* 在分类 chip 间切换并记录 modal-box 高度（rect 高，动画已关，等于实际所见） */
  const heights = await ex(`(function(){
    var box = document.querySelector('#libraryModal .modal-box');
    function h(){ return Math.round(box.getBoundingClientRect().height * 100) / 100; }
    var out = {};
    ['all','doc','other','pdf','all','other','doc'].forEach(function(t, i){
      var btn = document.querySelector('#libChips .chip[data-lfilter="' + t + '"]');
      if (btn) btn.click();
      out[t + '#' + (i + 1)] = h();
    });
    var body = document.querySelector('#libraryModal .modal-body');
    var cs = getComputedStyle(body);
    return { heights: out, flexBasis: cs.flexBasis, flexGrow: cs.flexGrow, flexShrink: cs.flexShrink,
             bodyH: Math.round(parseFloat(cs.height) * 100) / 100,
             vh78: Math.round(window.innerHeight * 0.78 * 100) / 100 };
  })()`);
  const hs = Object.values(heights.heights);
  const spread = Math.max.apply(null, hs) - Math.min.apply(null, hs);
  results.push({
    case: '已塞入可区分的分类数据（doc 3 / other 1）',
    pass: seededCount >= 4,
    got: 'lib-item 渲染数=' + seededCount + ' 入库成功=' + seeded.length
  });
  results.push({
    case: '分类 chip 来回切弹窗高度恒定（修复态）',
    pass: spread < 1,
    got: 'heights=' + JSON.stringify(heights.heights) + ' spread=' + spread
  });
  const pin = Math.min(660, heights.vh78);
  results.push({
    case: '定高来自 CSS：.modal-body 计算 flex-basis=auto 且高度 = min(660px,78vh)',
    pass: heights.flexBasis === 'auto' && Math.abs(heights.bodyH - pin) < 2,
    got: 'flexBasis=' + heights.flexBasis + ' bodyH=' + heights.bodyH + ' min(660,78vh)=' + pin
  });

  /* 负向对照：注入旧的 flex:1 1 0%，复现「退回内容高度 + 切分类抖动」。
     注意 flexBasis 必须在 s.remove() **之前**取快照（getComputedStyle 是活对象）。 */
  const neg = await ex(`(function(){
    var s = document.createElement('style');
    s.id = '__neg';
    s.textContent = '.library-box .modal-body{flex:1 1 0% !important;}';
    document.head.appendChild(s);
    var box = document.querySelector('#libraryModal .modal-box');
    function h(){ return Math.round(box.getBoundingClientRect().height * 100) / 100; }
    var out = {};
    ['all','doc','other','all'].forEach(function(t, i){
      var btn = document.querySelector('#libChips .chip[data-lfilter="' + t + '"]');
      if (btn) btn.click();
      out[t + '#' + (i + 1)] = h();
    });
    var cs = getComputedStyle(document.querySelector('#libraryModal .modal-body'));
    var basis = cs.flexBasis;   /* 快照：必须在 remove 之前读 */
    s.remove();
    return { heights: out, flexBasis: basis };
  })()`);
  const nhs = Object.values(neg.heights);
  const nspread = Math.max.apply(null, nhs) - Math.min.apply(null, nhs);
  results.push({
    case: '负向对照：注入 flex:1 1 0% → basis 归零、切分类抖动复现（非空转）',
    pass: neg.flexBasis === '0%' && nspread > spread && nspread > 5,
    got: 'flexBasis=' + neg.flexBasis + ' heights=' + JSON.stringify(neg.heights) + ' spread=' + nspread
  });

  await cleanup(seeded);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ opened, ...results }, null, 2), 'utf8');
  const fails = results.filter((r) => !r.pass);
  console.log('资料库分类 chip 验证：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
  app.quit();
  if (fails.length) process.exitCode = 1;
}).catch(function (e) { console.error('ERR ' + e.message); app.quit(); process.exitCode = 1; });
