#!/usr/bin/env node
/* 产物空间「切 tab 弹窗跳大小」回归验证（Electron 真实渲染）。
 *
 * 背景：9/12 用 `.deliver-box .modal-body{height:min(660px,78vh)}` 定高解决过；
 * 9/25 设计系统重做时 ui.css 加了 `.modal-body{flex:1}`（= flex: 1 1 0%，basis 0%），
 * basis 0% 让上面那个 height 不再参与主轴尺寸计算，弹窗退回按内容定高，切 tab 又开始抖。
 * 修法：把 basis 改回 auto（`.deliver-box .modal-body{flex:1 1 auto}`）。
 *
 * 本脚本要证明的三件事（静态扫描查不出这类运行时问题）：
 *   1. 文件/辩题/收藏 三个 tab 来回切，弹窗高度恒定
 *   2. 定高确实来自 CSS：.modal-body 的计算 flex-basis 是 auto，且计算高度 = min(660px, 78vh)
 *   3. 负向对照：注入旧的 flex:1 1 0% → basis 归零、高度退回内容高度、切 tab 抖动复现
 *
 * 两个测试脚本自身的坑（踩过，勿改回去）：
 *   a. 隐藏窗口（show:false）不推进 CSS 动画，.modal-box 会永远停在 modal-in 的
 *      from 帧（transform: scale(.97)）。此时 getBoundingClientRect 拿到的是被 0.97
 *      缩放后的值（544.66 的计算高 → 528.32 的 rect 高），会误判「定高没生效」。
 *      对策：先注入 `.modal-box{animation:none !important}` 关掉动画，rect 才等于计算值。
 *   b. getComputedStyle 返回的是**活对象**：若先 remove 注入的 <style> 再读 cs.flexBasis，
 *      读到的是移除后的值（恒为 auto），负向对照会假通过。必须在 remove 之前取快照。
 *
 * 用法（必须用 Electron 跑）：
 *   runtime\electron\dist\electron.exe tools/verify-deliver-tabs.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8795）上已有隔离数据目录的服务在跑。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-deliver-tabs.json');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify-deliver'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 760, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2500);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];

  /* 打开产物空间弹窗，并关掉 modal-in 动画（隐藏窗口不推进动画，否则 rect 会被 scale(.97) 缩掉） */
  const opened = await ex(`(function(){
    var st = document.createElement('style');
    st.id = '__noanim';
    st.textContent = '#deliverModal .modal-box{animation:none !important;}';
    document.head.appendChild(st);
    var b = document.getElementById('btnDeliver');
    if (b) b.click();
    return !document.getElementById('deliverModal').classList.contains('hidden');
  })()`);
  await sleep(600);

  /* 在三个 tab 间切换并记录 modal-box 高度（rect 高，动画已关，等于实际所见） */
  const heights = await ex(`(function(){
    var box = document.querySelector('#deliverModal .modal-box');
    function h(){ return Math.round(box.getBoundingClientRect().height * 100) / 100; }
    var out = {};
    ['files','cases','stars','files','stars','cases','files'].forEach(function(t, i){
      var btn = document.querySelector('.deliver-tab[data-dtab="' + t + '"]');
      if (btn) btn.click();
      out[t + '#' + (i + 1)] = h();
    });
    var body = document.querySelector('#deliverModal .modal-body');
    var cs = getComputedStyle(body);
    return { heights: out, flexBasis: cs.flexBasis, flexGrow: cs.flexGrow, flexShrink: cs.flexShrink,
             bodyH: Math.round(parseFloat(cs.height) * 100) / 100,
             vh78: Math.round(window.innerHeight * 0.78 * 100) / 100 };
  })()`);
  const hs = Object.values(heights.heights);
  const spread = Math.max.apply(null, hs) - Math.min.apply(null, hs);
  results.push({
    case: '三 tab 来回切弹窗高度恒定（修复态）',
    pass: spread < 1,
    got: 'heights=' + JSON.stringify(heights.heights) + ' spread=' + spread
  });
  const pin = Math.min(660, heights.vh78);
  results.push({
    case: '定高来自 CSS：.modal-body 计算 flex-basis=auto 且高度 = min(660px,78vh)',
    pass: heights.flexBasis === 'auto' && Math.abs(heights.bodyH - pin) < 2,
    got: 'flexBasis=' + heights.flexBasis + ' bodyH=' + heights.bodyH + ' min(660,78vh)=' + pin
  });

  /* 负向对照：注入旧的 flex:1 1 0%，复现「退回内容高度 + 切 tab 抖动」。
     注意 flexBasis 必须在 s.remove() **之前**取快照（getComputedStyle 是活对象）。 */
  const neg = await ex(`(function(){
    var s = document.createElement('style');
    s.id = '__neg';
    s.textContent = '.deliver-box .modal-body{flex:1 1 0% !important;}';
    document.head.appendChild(s);
    var box = document.querySelector('#deliverModal .modal-box');
    function h(){ return Math.round(box.getBoundingClientRect().height * 100) / 100; }
    var out = {};
    ['files','cases','stars','files'].forEach(function(t, i){
      var btn = document.querySelector('.deliver-tab[data-dtab="' + t + '"]');
      if (btn) btn.click();
      out[t + '#' + (i + 1)] = h();
    });
    var cs = getComputedStyle(document.querySelector('#deliverModal .modal-body'));
    var basis = cs.flexBasis;   /* 快照：必须在 remove 之前读 */
    s.remove();
    return { heights: out, flexBasis: basis };
  })()`);
  const nhs = Object.values(neg.heights);
  const nspread = Math.max.apply(null, nhs) - Math.min.apply(null, nhs);
  results.push({
    case: '负向对照：注入 flex:1 1 0% → basis 归零、切 tab 抖动复现（非空转）',
    pass: neg.flexBasis === '0%' && nspread > spread && nspread > 5,
    got: 'flexBasis=' + neg.flexBasis + ' heights=' + JSON.stringify(neg.heights) + ' spread=' + nspread
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ opened, ...results }, null, 2), 'utf8');
  const fails = results.filter((r) => !r.pass);
  console.log('产物弹窗 tab 验证：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
  app.quit();
  if (fails.length) process.exitCode = 1;
}).catch(function (e) { console.error('ERR ' + e.message); app.quit(); process.exitCode = 1; });
