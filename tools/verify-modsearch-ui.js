#!/usr/bin/env node
/* 增强检索设置卡（ModSearch）回归验证 —— Electron 真实渲染。
 *
 * 为什么必须真渲染（2026-10-10 立的硬约束 #4）：这张卡的要害在**运行时**——
 *   · 用量行是 fetch 回来再拼进 DOM 的，静态扫描只能看到「读取中…」占位
 *   · 三段长提示 + 琥珀色限额警告叠在一张卡里，窄栏下会不会撑出横向滚动条只有真渲染知道
 *   · 开关保存后要真的写进服务端，重开设置还得回读一致（A 写 B 读的契约）
 *   · 「试搜一次」的成功回显是拼出来的 DOM（条数/用时/引擎/credits/样例），
 *     2026-10-12 那次用户一点就红（相关性打分器把阈值下限写死 2，两字查询必不达标），
 *     失败分支早就有人看过，**成功分支从没被渲染验证过** —— 这一支必须钉住
 *   · 英文模式下这些动态串全靠 EN_RULES，只有真切一次语言才知道有没有残留汉字
 *
 * ★ 写页面代码的纪律（本次踩了三轮才挖到的根因）：
 *   注入页面的片段一律用「字符串数组 join」构造，片段里**不写任何正则字面量、
 *   不写任何反斜杠转义**。模板字符串会把 \\s、\\u4e00 这类序列在 Node 侧先吃掉一层，
 *   到页面里就成了坏代码 —— executeJavaScript 报出来的只有一句
 *   「An object could not be cloned.」，根因全丢。需要正则/归一化的地方，
 *   一律把原始字符串取回 Node 侧再处理（字符串永远可序列化）。
 *
 * 用法（必须用 Electron 跑）：
 *   runtime\\electron\\dist\\electron.exe tools/verify-modsearch-ui.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8797）上已有**隔离数据目录**的服务在跑，
 *   且增强检索走**界面替身 CLI**（不烧上游免注册额度）—— 用 tools/run-modsearch-tests.js 一键跑。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-modsearch-ui.json');
const PORT = process.env.PATROL_PORT || '8797';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify-modsearch'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail || '' });
  fs.writeSync(1, (ok ? '  OK  ' : '  FAIL') + ' ' + name + (detail ? ' · ' + detail : '') + '\n');
};

/* 页面回显里可能混着换行/连续空白，回 Node 侧再归一化 */
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const trialDetail = (t) => (t && t.missing ? '缺元素=' + t.missing
  : t && t.err ? '页面异常=' + t.err
  : 'cls=' + ((t && t.cls) || '') + ' text=' + norm(t && t.text).slice(0, 96));
/* 「试搜一次」的回显算不算成功，写成判定器而不是散落的正则：
   正向用它断言，负向对照喂它旧的失败文案，证明它真的会报红、而不是永远为真。 */
const trialOk = (t) => !!(t && typeof t.text === 'string' && typeof t.cls === 'string')
  && /成功：\d+ 条结果，用时 \d+ms/.test(t.text)
  && /credits/.test(t.text) && /样例：/.test(t.text) && /(^|\s)ok(\s|$)/.test(t.cls) && !/err/.test(t.cls);
const trialOkEn = (t) => !!(t && typeof t.text === 'string' && typeof t.cls === 'string')
  && /OK: \d+ results in \d+ms via /.test(t.text)
  && /credits used/.test(t.text) && /Sample: /.test(t.text) && /(^|\s)ok(\s|$)/.test(t.cls) && !/err/.test(t.cls);

/* 注入页面的片段：数组 join，片段内零反斜杠、零正则字面量 */
const snip = (...lines) => lines.join('\n');
const CLICK_TRIAL = snip(
  "(function(){",
  "  var b = document.getElementById('btnModsearchTest');",
  "  if (!b) return 0;",
  "  b.click();",
  "  return 1;",
  "})()");
const READ_TRIAL = snip(
  "(function(){",
  "  var el = document.getElementById('modsearchResult');",
  "  var lab = document.getElementById('modsearchTestLabel');",
  "  var q = document.getElementById('modsearchQuota');",
  "  return JSON.stringify({",
  "    text: el ? String(el.textContent) : '',",
  "    cls: el ? String(el.className) : '',",
  "    label: lab ? String(lab.textContent) : '',",
  "    quota: q ? String(q.textContent) : '',",
  "    missing: (!el || !lab || !q) ? 'result/label/quota' : ''",
  "  });",
  "})()");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const ex = (code) => win.webContents.executeJavaScript(code);
  /* 排障线索：导航 + 控制台（Electron 各版本 console-message 签名不同，两种都兼容） */
  const clueLog = [];
  const pushClue = (s) => { if (clueLog.length < 60) clueLog.push(String(s)); };
  const clues = () => (clueLog.length ? clueLog.slice(-4).join(' ⏩ ') : '(无线索)');
  try {
    win.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
      const u = typeof url === 'string' ? url : (e && e.url) || '';
      pushClue('nav ' + String(u).slice(0, 80));
    });
    win.webContents.on('console-message', (a, b, c, d, e5) => {
      const ev = (a && typeof a.message === 'string') ? a : { level: b, message: c, sourceId: e5 };
      pushClue('c[' + ev.level + '] ' + String(ev.message).slice(0, 100));
    });
  } catch (_) {}

  /* 点「试搜一次」→ Node 侧轮询读回显（每次都是独立的短求值，绝不在页面里挂长 promise）。
     轮询而不是页面内 await：撞上任何上下文销毁，最多损失一次读取，不会把根因吞成乱码。 */
  const pollTrial = async (pat) => {
    try {
      if (await ex(CLICK_TRIAL) !== 1) return { missing: 'btnModsearchTest' };
      let last = { text: '', cls: '', label: '', quota: '' };
      for (let i = 0; i < 50; i++) {
        await sleep(300);
        last = JSON.parse(String(await ex(READ_TRIAL)));
        if (pat.test(norm(last.text))) break;
      }
      await sleep(400);   // 回显落定后再读一次，别抢在写屏之前判成败
      last = JSON.parse(String(await ex(READ_TRIAL)));
      if (!norm(last.text)) last.missing = 'modsearchResult';
      last.text = norm(last.text); last.cls = norm(last.cls);
      last.label = norm(last.label); last.quota = norm(last.quota);
      return last;
    } catch (e) { return { err: String((e && e.message) || e) + ' 线索=' + clues() }; }
  };

  try {
    await win.loadURL('http://127.0.0.1:' + PORT + '/');
    await sleep(2600);
    await ex("(function(){var s=document.createElement('style');s.textContent='.modal-box{animation:none !important;}';document.head.appendChild(s);return 1;})()");

    // 打开设置 → 高级面板
    await ex("(function(){document.getElementById('btnSettings').click();return 1;})()");
    await sleep(700);
    await ex("(function(){var b=document.querySelector('.settings-nav-item[data-settings-pane=\\'advanced\\']');if(b)b.click();return 1;})()");
    await sleep(900);

    const card = await ex(snip(
      "(function(){",
      "  var pane = document.querySelector('#settingsModal .settings-pane.active');",
      "  if (!pane) return { ok: false };",
      "  var t = document.getElementById('modsearchToggle');",
      "  var lab = document.getElementById('modsearchLabel');",
      "  var quota = document.getElementById('modsearchQuota');",
      "  var testBtn = document.getElementById('btnModsearchTest');",
      "  var msRow = t ? t.closest('.general-section') : null;",
      "  var csSpan = null;",
      "  pane.querySelectorAll('.gen-label').forEach(function(e){ if (e.textContent.indexOf('自定义搜索服务') >= 0) csSpan = e.closest('.general-section'); });",
      "  return {",
      "    ok: true,",
      "    // ★ 开关文案叫 stateText：卡片标题叫 labelText，同名键会被静默覆盖（第一次跑就栽在这）",
      "    hasToggle: !!t, checked: !!(t && t.checked), stateText: lab ? String(lab.textContent) : '',",
      "    quotaText: quota ? String(quota.textContent) : '',",
      "    hasTestBtn: !!testBtn,",
      "    testBtnText: testBtn ? String(testBtn.textContent) : '',",
      "    beforeCustom: !!(msRow && csSpan && (msRow.compareDocumentPosition(csSpan) & 4)),",
      "    overflowX: pane.scrollWidth - pane.clientWidth,",
      "    amberVisible: !!(msRow && Array.prototype.some.call(msRow.querySelectorAll('small'), function(s){ return s.textContent.indexOf('1,000 credits') >= 0 && s.getBoundingClientRect().height > 0; })),",
      "    labelFound: !!msRow && !!msRow.querySelector('.gen-label'),",
      "    labelText: msRow && msRow.querySelector('.gen-label') ? String(msRow.querySelector('.gen-label').textContent) : '',",
      "  };",
      "})()"));
    check('增强检索卡渲染出来了', card.ok && card.hasToggle && card.labelFound, 'label=' + norm(card.labelText));
    check('★ 默认是开启的（开关勾上、标签显示「开」）', card.checked && norm(card.stateText) === '开',
      'checked=' + card.checked + ' state=' + norm(card.stateText));
    check('★ 用量行拿到真实数字（不是「读取中…」占位）',
      card.ok && norm(card.quotaText).indexOf('本月用量') >= 0 && norm(card.quotaText).indexOf('读取中') < 0 && norm(card.quotaText).indexOf('credits') >= 0,
      JSON.stringify(norm(card.quotaText).slice(0, 90)));
    check('★ 限额说明可见（琥珀色那行讲清 1,000 credits/月）', card.amberVisible);
    check('★ 卡片排在「自定义搜索服务」之前（优先级顺序与检索链一致）', card.beforeCustom === true);
    check('★ 高级面板不撑出横向滚动条（长提示叠三段也不溢出）', card.overflowX <= 1, 'overflowX=' + card.overflowX);
    check('试搜按钮在位且文案标注会消耗额度', card.hasTestBtn && norm(card.testBtnText).indexOf('消耗额度') >= 0, norm(card.testBtnText));

    // 开关保存 → 服务端真的变了 → 重开设置回读一致
    const flip = await ex(snip(
      "(async function(){",
      "  var t = document.getElementById('modsearchToggle');",
      "  t.checked = false;",
      "  t.dispatchEvent(new Event('change'));",
      "  document.getElementById('btnModsearchSave').click();",
      "  await new Promise(function(r){ setTimeout(r, 900); });",
      "  var lab = document.getElementById('modsearchLabel');",
      "  var res = document.getElementById('modsearchResult');",
      "  var g = await (await fetch('/api/search/modsearch')).json();",
      "  var txt = res ? String(res.textContent) : '';",
      "  return { lab: lab ? String(lab.textContent) : '', res: txt, serverEnabled: g.enabled, resultOk: txt.indexOf('已保存') >= 0 };",
      "})()"));
    check('★ 关掉并保存：服务端真的写进 false（不是只改了界面）',
      flip.serverEnabled === false && norm(flip.lab).indexOf('关') >= 0, 'server=' + flip.serverEnabled + ' lab=' + norm(flip.lab));
    check('保存后有明确回显（不静默）', flip.resultOk === true, norm(flip.res).slice(0, 40));

    const reopen = await ex(snip(
      "(async function(){",
      "  document.getElementById('settingsModal').classList.add('hidden');",
      "  document.getElementById('btnSettings').click();",
      "  await new Promise(function(r){ setTimeout(r, 700); });",
      "  var b = document.querySelector('.settings-nav-item[data-settings-pane=\\'advanced\\']');",
      "  if (b) b.click();",
      "  await new Promise(function(r){ setTimeout(r, 900); });",
      "  var t = document.getElementById('modsearchToggle');",
      "  var g = await (await fetch('/api/search/modsearch')).json();",
      "  var q = document.getElementById('modsearchQuota');",
      "  return { checked: !!(t && t.checked), serverEnabled: g.enabled, quota: q ? String(q.textContent) : '' };",
      "})()"));
    check('★ 重开设置回读一致（关着的状态没被界面记忆覆盖）',
      reopen.checked === false && reopen.serverEnabled === false, 'checked=' + reopen.checked + ' server=' + reopen.serverEnabled);

    // 恢复开启
    const restore = await ex(snip(
      "(async function(){",
      "  var t = document.getElementById('modsearchToggle');",
      "  t.checked = true;",
      "  t.dispatchEvent(new Event('change'));",
      "  document.getElementById('btnModsearchSave').click();",
      "  await new Promise(function(r){ setTimeout(r, 900); });",
      "  var g = await (await fetch('/api/search/modsearch')).json();",
      "  return { serverEnabled: g.enabled };",
      "})()"));
    check('★ 已恢复为开启（不留测试残留）', restore.serverEnabled === true);

    // ★ 中文「试搜一次」成功分支（走界面替身，不烧上游额度）
    const trial = await pollTrial(/成功|失败/);
    check('★ 试搜一次成功分支：绿条报条数/用时/引擎/消耗（旧版这里必红）', trialOk(trial) === true, trialDetail(trial));
    check('★ 试搜后按钮文案复位、用量行同步刷新（额度确实记进了账本）',
      norm(trial.label).indexOf('试搜一次（消耗额度）') >= 0 && /已用 \d+ credits/.test(trial.quota || ''),
      'label=' + (trial.label || '') + ' quota=' + (trial.quota || '').slice(0, 60));

    // 英文模式：整页重载后回高级面板，扫残留汉字
    await ex("(function(){localStorage.setItem('academy.locale.v1','en');return 1;})()");
    await win.webContents.reload();
    await sleep(2600);
    await ex("(function(){document.getElementById('btnSettings').click();return 1;})()");
    await sleep(700);
    await ex("(function(){var b=document.querySelector('.settings-nav-item[data-settings-pane=\\'advanced\\']');if(b)b.click();return 1;})()");
    await sleep(1400);
    const en = await ex(snip(
      "(function(){",
      "  var t = document.getElementById('modsearchToggle');",
      "  var sec = t ? t.closest('.general-section') : null;",
      "  if (!sec) return { ok: false };",
      "  var texts = [];",
      "  var w = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);",
      "  for (var n = w.nextNode(); n; n = w.nextNode()) { var s = String(n.nodeValue).trim(); if (s) texts.push(s); }",
      "  // 汉字判定用码位比较，别在注入片段里写正则/转义",
      "  var han = texts.filter(function (x) {",
      "    for (var i = 0; i < x.length; i++) { var c = x.charCodeAt(i); if (c >= 0x4e00 && c <= 0x9fff) return true; }",
      "    return false;",
      "  });",
      "  var q = document.getElementById('modsearchQuota');",
      "  return { ok: true, han: han, quota: q ? String(q.textContent) : '', count: texts.length };",
      "})()"));
    /* 防「空转绿灯」：一个文本节点都没扫到 = 卡片没渲染，不能算「无残留汉字」通过 */
    check('★ 英文模式：增强检索卡无残留汉字（且真的扫到了文本节点）',
      en.ok && en.count > 5 && Array.isArray(en.han) && en.han.length === 0,
      en.ok ? ('节点数=' + en.count + ' 残留=' + en.han.slice(0, 3).map(norm).join(' | ') + ' quota=' + norm(en.quota).slice(0, 70)) : 'card missing');
    /* ★ 英文模式点同一支按钮：成功文案是拼出来的长串，只能靠 EN_RULES。
       样例题名是**数据**（替身给的是中文标题），所以只断言界面骨架被翻译，不要求整行无汉字。 */
    const trialEn = await pollTrial(/OK:|成功|Failed|失败/);
    check('★ 英文模式：试搜成功回显走 EN_RULES（OK: N results in Xms via … / credits used / Sample:）',
      trialOkEn(trialEn) === true, trialDetail(trialEn));
    await ex("(function(){localStorage.setItem('academy.locale.v1','zh-CN');return 1;})()");
    await win.webContents.reload();
    await sleep(2200);

    /* 负向对照（证明上面的断言不是空转） */
    const negTrial = { text: '失败：增强检索结果相关性不足（返回的 5 条结果里只有 0 条与查询相关）（不影响使用，端侧检索会自动退回基础检索）',
      cls: 'settings-result err', label: '', quota: '' };
    check('负向对照：旧的失败回显确实会被「成功分支」断言抓住',
      trialOk(negTrial) === false && trialOkEn(negTrial) === false,
      'trialOk=' + trialOk(negTrial) + ' trialOkEn=' + trialOkEn(negTrial));
    const neg = await ex("(function(){var q=document.getElementById('modsearchQuota');q.textContent='本月用量：读取中…';return q.textContent;})()");
    const negHit = String(neg).indexOf('读取中') >= 0 && String(neg).indexOf('credits') < 0;
    check('负向对照：占位文案确实会被「真实数字」断言抓住', negHit === true, norm(neg).slice(0, 30));
  } catch (e) {
    check('脚本执行没有抛错', false, String((e && e.message) || e) + ' 线索=' + clues());
  } finally {
    const bad = results.filter((r) => !r.ok);
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8'); } catch (_) {}
    fs.writeSync(1, '\n增强检索设置卡真渲染：' + (results.length - bad.length) + '/' + results.length + ' 通过\n');
    app.exit(bad.length ? 1 : 0);
  }
});
