#!/usr/bin/env node
/* 体检整改项（F2/F4/F5/F6）真实渲染验证（Flash 线）。
 *
 * 为什么需要它：这几条全是「运行时才成立」的性质 ——
 *   F4 焦点进弹窗 / Tab 出不去 / 关弹窗焦点回到原按钮；
 *   F5 只有白名单图标能进 DOM，用户文本里的 <svg> 必须变成字；
 *   F6 toast 文案要真的落到 aria-live 播报区；
 *   F2 流式请求卡住时停止按钮必须能把 Promise 打断，而不是界面永久「生成中」。
 * 静态扫描和冒烟测试都只能证明代码在，不能证明它在浏览器里生效。
 *
 * 用法：node tools/run-verify-a11y.js      （自带隔离数据目录 + 独立端口）
 * 产物：.build/verify-a11y.json
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-a11y.json');
const PORT = process.env.VERIFY_PORT || '8797';
const DATA = path.join(ROOT, '.build', 'a11y-verify-data');
app.setPath('userData', path.join(DATA, 'electron-user-data'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 看门狗：卡在哪一步都会留下痕迹并落盘，绝不让进程吊死（正常跑完约 15s）
let step = 'boot';
const mark = (s) => { step = s; console.log('… ' + s); };
function ping() {
  return new Promise((resolve) => {
    const q = http.get({ host: '127.0.0.1', port: Number(PORT), path: '/api/ping', timeout: 1200 }, (s) => { s.resume(); resolve(s.statusCode === 200); });
    q.on('error', () => resolve(false)); q.on('timeout', () => { q.destroy(); resolve(false); });
  });
}

app.whenReady().then(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const { spawn } = require('child_process');
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + PORT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1', ELECTRON_RUN_AS_NODE: '1' }),
    stdio: 'ignore',
    windowsHide: true
  });
  mark('等待本地服务就绪');
  for (let i = 0; i < 40 && !(await ping()); i++) await sleep(500);
  if (!(await ping())) { console.log('✗ 本地服务起不来'); try { server.kill(); } catch (_) {} app.exit(4); }

  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const renderErrors = [];
  win.webContents.on('console-message', (e, level, message) => { if (level >= 2) renderErrors.push(message); });
  mark('加载页面');
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2500);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const push = (name, pass, got) => { results.push({ name, pass, got }); console.log((pass ? '  ✅ ' : '  ❌ ') + name + ' · ' + got); };
  const hardKill = setTimeout(() => {
    console.log('⏰ 看门狗触发，卡在：' + step);
    try { fs.writeFileSync(OUT, JSON.stringify({ watchdog: step, results }, null, 2), 'utf8'); } catch (_) {}
    try { server.kill(); } catch (_) {}
    app.exit(3);
  }, 150000);
  const finish = () => { clearTimeout(hardKill); };

  mark('F4 弹窗语义');
  /* ---- F4-1 语义：每个弹窗都要有 dialog 身份和可用标题 ---- */
  const roles = await ex(`(function () {
    return JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.modal'), function (m) {
      var lbl = m.getAttribute('aria-labelledby');
      var h = lbl ? document.getElementById(lbl) : null;
      return { id: m.id, role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), label: h ? (h.textContent || '').trim() : '' };
    }));
  })()`);
  const list = JSON.parse(roles);
  const badRole = list.filter(function (x) { return x.role !== 'dialog' || x.modal !== 'true' || !x.label; });
  push('F4 弹窗语义 role/aria-modal/aria-labelledby', badRole.length === 0 && list.length >= 8,
    '弹窗 ' + list.length + ' 个，不合格 ' + (badRole.map(function (x) { return x.id; }).join(',') || '0'));

  mark('F4 焦点环');
  /* ---- F4-2 打开即聚焦、Tab 走不出弹窗、关闭焦点回归 ---- */
  const trap = await ex(`(async function () {
    function focusInfo() {
      var a = document.activeElement;
      if (!a) return { tag: 'none', inModal: false, id: '' };
      return { tag: a.tagName, inModal: !!(a.closest && a.closest('.modal')), id: a.id || '', text: (a.textContent || '').trim().slice(0, 12) };
    }
    var trigger = document.getElementById('btnTools');
    trigger.focus();
    trigger.click();
    await new Promise(function (r) { setTimeout(r, 300); });
    var opened = focusInfo();
    var escaped = [];
    for (var i = 0; i < 25; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      await new Promise(function (r) { setTimeout(r, 15); });
      var f = focusInfo();
      if (!f.inModal) escaped.push(i + ':' + f.tag + '#' + f.id);
    }
    var closeBtn = document.querySelector('#toolsModal .modal-close');
    closeBtn.click();
    await new Promise(function (r) { setTimeout(r, 300); });
    return JSON.stringify({ opened: opened, escaped: escaped, afterClose: focusInfo(), hidden: document.getElementById('toolsModal').classList.contains('hidden') });
  })()`);
  const t = JSON.parse(trap);
  push('F4 打开弹窗后焦点自动进入', t.opened.inModal === true, JSON.stringify(t.opened));
  push('F4 Tab 环留在弹窗内（25 次）', t.escaped.length === 0, t.escaped.join(' | ') || '全部留在弹窗内');
  push('F4 关闭弹窗焦点回到触发按钮', t.afterClose.id === 'btnTools' && t.hidden === true, JSON.stringify(t.afterClose));

  mark('F5 注入闸门');
  /* ---- F5 注入闸门 ---- */
  const gate = await ex(`(function () {
    function probe(s) {
      var n = el('div', 'x', s);
      var svg = n.querySelector('svg');
      return { svg: !!svg, use: svg ? (svg.querySelector('use') || {}).getAttribute && svg.querySelector('use').getAttribute('href') : '', tags: Array.prototype.map.call(n.querySelectorAll('*'), function (e) { return e.tagName; }).join(','), text: n.textContent.slice(0, 60) };
    }
    return JSON.stringify({
      icon: probe(ic('settings')),
      trailingText: probe(ic('settings') + '设置'),
      fakeSvg: probe('<svg onload=alert(1)></svg>'),
      svgWithPayload: probe('<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-settings"></use></svg><img src=x onerror=alert(1)>'),
      plain: probe('普通文本 <b>粗体</b>')
    });
  })()`);
  const g = JSON.parse(gate);
  push('F5 合法图标仍然渲染', g.icon.svg === true, JSON.stringify(g.icon));
  push('F5 图标后面的文字保留', g.trailingText.svg === true && g.trailingText.text.indexOf('设置') !== -1, JSON.stringify(g.trailingText));
  push('F5 伪造 <svg onload> 变成纯文本', g.fakeSvg.svg === false && g.fakeSvg.tags === '' , JSON.stringify(g.fakeSvg));
  push('F5 图标尾巴里的 <img onerror> 不成元素', g.svgWithPayload.tags === 'svg,use', JSON.stringify(g.svgWithPayload));
  push('F5 普通富文本不产生元素', g.plain.svg === false && g.plain.tags === '', JSON.stringify(g.plain));

  mark('F6 播报区');
  /* ---- F6 aria-live 播报 ---- */
  const live = await ex(`(async function () {
    var box = document.getElementById('srAnnounce');
    if (!box) return JSON.stringify({ missing: true });
    box.textContent = '';
    toast('验证播报文案');
    await new Promise(function (r) { setTimeout(r, 250); });
    return JSON.stringify({ live: box.getAttribute('aria-live'), text: box.textContent, atomic: box.getAttribute('aria-atomic'), role: box.getAttribute('role'), clipped: (function () { var cs = getComputedStyle(box); return cs.width === '1px' || cs.position === 'absolute'; })() });
  })()`);
  const lv = JSON.parse(live);
  push('F6 播报区存在且 aria-live=polite', lv.missing !== true && lv.live === 'polite', JSON.stringify(lv));
  push('F6 toast 文案进入播报区', (lv.text || '').indexOf('验证播报文案') !== -1, JSON.stringify(lv.text));
  push('F6 播报区视觉隐藏', lv.clipped === true, JSON.stringify({ role: lv.role, atomic: lv.atomic }));
  push('F4 对话区是 aria-live 日志', await ex(`(function(){var m=document.getElementById('messages');return m.getAttribute('role')==='log' && m.getAttribute('aria-live')==='polite';})()`) === true, 'role=log aria-live=polite');

  mark('F2 打断挂死请求');
  /* ---- F2 停止按钮能打断挂死的流式请求 ---- */
  const stop = await ex(`(async function () {
    var real = window.fetch;
    var hung = 0;
    window.fetch = function (url, init) {          // 模拟上游卡死：连接永不完成，但尊重 abort 信号（真实 fetch 语义）
      hung++;
      return new Promise(function (resolve, reject) {
        var sig = init && init.signal;
        function aborted() { var e = new Error('The user aborted a request.'); e.name = 'AbortError'; reject(e); }
        if (sig) { if (sig.aborted) { aborted(); return; } sig.addEventListener('abort', aborted, { once: true }); }
      });
    };
    var out;
    var p = streamChat('free', '验证', [], function () {});
    await new Promise(function (r) { setTimeout(r, 200); });
    var haveAbort = !!activeStreamAbort;
    if (haveAbort) activeStreamAbort.stop('manual');
    try { await p; out = { resolved: true }; } catch (e) { out = { rejected: true, msg: String(e && e.message || e) }; }
    window.fetch = real;
    return JSON.stringify({ out: out, haveAbort: haveAbort, hung: hung, stillRunning: !!(window.state && state.running) });
  })()`);
  const s = JSON.parse(stop);
  push('F2 挂死的流式请求可被停止打断', s.haveAbort === true && s.out.rejected === true, JSON.stringify(s));
  push('F2 停止后给出中文说明而非技术错误', /停止|超时|中断|取消/.test(s.out.msg || ''), JSON.stringify(s.out.msg));

  push('无渲染进程报错', renderErrors.length === 0, renderErrors.slice(0, 3).join(' | ') || 'clean');

  finish();
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const fail = results.filter(function (r) { return !r.pass; });
  console.log('\n验证：' + (results.length - fail.length) + '/' + results.length + ' 通过' + (fail.length ? '（有失败项）' : '，全部通过'));
  finish();
  try { server.kill(); } catch (_) {}
  app.exit(fail.length ? 1 : 0);
}).catch((e) => { console.log('ERR ' + (e && e.stack || e)); try { fs.writeFileSync(OUT, JSON.stringify({ error: String(e && e.stack || e), results: typeof results === 'undefined' ? [] : results }, null, 2), 'utf8'); } catch (_) {} try { app.exit(1); } catch (_) {} });
