'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-motion.json');
const PORT = process.env.PATROL_PORT || '8796';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-motion'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const results = [];
  const check = (n, ok, d) => { results.push({ name: n, ok: !!ok, detail: d || '' }); console.log((ok ? '  OK  ' : '  FAIL') + ' ' + n + (d ? ' · ' + d : '')); };
  try {
    await fetch('http://127.0.0.1:' + PORT + '/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test-1111',
        models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], model: 'deepseek-flash' }),
    }).then((x) => x.json());

    const win = new BrowserWindow({ width: 1280, height: 880, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await win.loadURL('http://127.0.0.1:' + PORT + '/');
    await sleep(2200);
    const ex = (c) => win.webContents.executeJavaScript(c);
    await ex('(function(){ ["welcomeModal","libraryModal","toolsModal","memoryModal","deliverModal"].forEach(function(id){ var e=document.getElementById(id); if(e) e.classList.add("hidden"); }); return 1; })()');
    await sleep(200);

    /* ---- 1. 弹窗退场：不能立刻隐藏，必须先播 .is-closing ---- */
    await ex('document.getElementById("btnSettings").click();');
    await sleep(900);
    const immediate = await ex('(function(){ var m=document.getElementById("settingsModal"); m.classList.remove("hidden"); closeModalAnimated(m); return { closing: m.classList.contains("is-closing"), hidden: m.classList.contains("hidden") }; })()');
    check('★ 关闭弹窗：立刻挂 is-closing，且**不**立刻隐藏', immediate.closing === true && immediate.hidden === false, JSON.stringify(immediate));
    await sleep(600);
    const settled = await ex('(function(){ var m=document.getElementById("settingsModal"); return { closing: m.classList.contains("is-closing"), hidden: m.classList.contains("hidden") }; })()');
    check('★ 关闭弹窗：动画结束后才真正隐藏，并摘掉 is-closing', settled.hidden === true && settled.closing === false, JSON.stringify(settled));

    /* ---- 2. 打断保护：关闭后立刻重开，不能被收尾定时器又藏起来 ---- */
    const interrupt = await ex('(async function(){ var m=document.getElementById("settingsModal"); closeModalAnimated(m); openModalAnimated(m); await new Promise(function(r){setTimeout(r,500);}); return { hidden: m.classList.contains("hidden") }; })()');
    check('★ 重开能取消未完成的收尾（不会被定时器再藏起来）', interrupt.hidden === false, JSON.stringify(interrupt));

    /* ---- 3. 设置面板切换：真的挂着 pane-in 动画 ---- */
    await ex('(function(){ switchSettingsPane("general"); return 1; })()');
    await sleep(60);
    const paneAnim = await ex('(function(){ var p=document.querySelector(".settings-pane[data-settings-pane=\'general\']"); var cs=getComputedStyle(p); return { name: cs.animationName, dur: cs.animationDuration, opacity: cs.opacity }; })()');
    check('★ 切设置面板挂了 pane-in 动画', /pane-in/.test(paneAnim.name), JSON.stringify(paneAnim));

    /* ---- 4. 关键过渡都声明了（不是硬跳） ---- */
    const decls = await ex('(function(){ function t(sel){ var e=document.querySelector(sel); return e? getComputedStyle(e).transitionProperty + " / " + getComputedStyle(e).transitionDuration : "(missing)"; } return { sidebar: t(".sidebar"), nav: t(".settings-nav-item"), mode: t(".mode-btn"), btn: t(".btn"), icon: t(".icon-btn") }; })()');
    check('★ 侧边栏宽度参与过渡（不再硬跳）', /width/.test(decls.sidebar), decls.sidebar);
    check('★ 二级导航 / 模式 / 按钮都有过渡声明', [decls.nav, decls.mode, decls.btn, decls.icon].every((s) => s !== '(missing)' && !/all 0s|^none/.test(s)), JSON.stringify(decls));

    /* ---- 4b. 模式切换：主区真的挂淡入（不是静默硬换） ---- */
    const modeSwap = await ex('(function(){ switchMode("prep"); return new Promise(function(res){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ var el=document.querySelector(".main"); var cs=getComputedStyle(el); res({ enter: el.classList.contains("mode-enter"), name: cs.animationName }); }); }); }); })()');
    check('★ 模式切换时主区挂了 pane-in 淡入', modeSwap.enter === true && /pane-in/.test(modeSwap.name), JSON.stringify(modeSwap));

    /* ---- 5. 弹窗 / 弹出层进场动画在场 ---- */
    const enters = await ex('(function(){ var m=document.getElementById("settingsModal"); return { modalBox: getComputedStyle(document.querySelector("#settingsModal .modal-box")).animationName }; })()');
    check('★ 弹窗卡片有进场动画', /modal-in/.test(enters.modalBox), JSON.stringify(enters));

    /* ---- 6. prefers-reduced-motion：用 CDP 真实模拟系统「减弱动态效果」 ---- */
    const dbg = win.webContents.debugger;
    let emulated = false;
    try {
      if (!dbg.isAttached()) dbg.attach();
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      emulated = true;
    } catch (err) {
      check('CDP 可用来模拟系统设置', false, String(err && err.message));
    }
    await sleep(400);
    /* 注意：.typing 只有在流式输出时才存在于 DOM，这里必须判空 —— 
       直接 getComputedStyle(null) 会让整段脚本抛错，把后面的断言全带没。 */
    const rm = await ex('(function(){ var cs=getComputedStyle(document.documentElement); var t=document.querySelector(".typing i"); return { matches: matchMedia("(prefers-reduced-motion: reduce)").matches, durSlow: cs.getPropertyValue("--dur-slow").trim(), durBase: cs.getPropertyValue("--dur-base").trim(), typingPresent: !!t, typingAnim: t ? getComputedStyle(t).animationName : null }; })()');
    if (emulated) check('★ 模拟「减弱动态效果」后媒体查询真的命中', rm.matches === true, JSON.stringify(rm));
    /* 令牌是 "80ms" 这样的字符串，parseFloat 拿到的是 80 —— 阈值得按毫秒写，
       按秒写会把正确的 80ms 误判成 80 秒（上一轮的 FAIL 就是这个单位 bug，不是动画错了）。 */
    const msOf = (v) => /ms$/.test(v) ? parseFloat(v) : parseFloat(v) * 1000;
    check('★ 减弱动态时：时长令牌被压短（动画变快而非消失）', msOf(rm.durSlow) <= 80 && msOf(rm.durSlow) > 0, 'dur-slow=' + rm.durSlow + ' dur-base=' + rm.durBase);
    check('★ 减弱动态时：装饰性重复动画（打字光标）被停掉', rm.typingPresent === false || rm.typingAnim === 'none', 'present=' + rm.typingPresent + ' anim=' + rm.typingAnim);

    const rmPane = await ex('(async function(){ var m=document.getElementById("settingsModal"); m.classList.remove("hidden"); closeModalAnimated(m); await new Promise(function(r){setTimeout(r,400);}); return { hidden: m.classList.contains("hidden") }; })()');
    check('减弱动态下关闭依然能正常收尾（动画变快但不失灵）', rmPane.hidden === true, JSON.stringify(rmPane));

    try { dbg.detach(); } catch (_) {}
  } catch (e) {
    check('验证过程未抛错', false, e.message);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const bad = results.filter((x) => !x.ok);
  console.log('---- ' + (results.length - bad.length) + '/' + results.length + ' 通过 ----');
  app.exit(bad.length ? 1 : 0);
});
