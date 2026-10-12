#!/usr/bin/env node
/* 增强检索设置卡（ModSearch）回归验证 —— Electron 真实渲染。
 *
 * 为什么必须真渲染（2026-10-10 立的硬约束 #4）：这张卡的要害在**运行时**——
 *   · 用量行是 fetch 回来再拼进 DOM 的，静态扫描只能看到「读取中…」占位
 *   · 三段长提示 + 琥珀色限额警告叠在一张卡里，窄栏下会不会撑出横向滚动条只有真渲染知道
 *   · 开关保存后要真的写进服务端，重开设置还得回读一致（A 写 B 读的契约）
 *   · 英文模式下用量行是拼出来的串，只有真切一次语言才知道有没有残留汉字
 *
 * 用法（必须用 Electron 跑）：
 *   runtime\\electron\\dist\\electron.exe tools/verify-modsearch-ui.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8797）上已有**隔离数据目录**的服务在跑（用 tools/run-modsearch-tests.js 一键跑）。
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
  console.log((ok ? '  OK  ' : '  FAIL') + ' ' + name + (detail ? ' · ' + detail : ''));
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 820, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2600);
  const ex = (code) => win.webContents.executeJavaScript(code);
  await ex("(function(){var s=document.createElement('style');s.textContent='.modal-box{animation:none !important;}';document.head.appendChild(s);return 1;})()");

  try {
    // 打开设置 → 高级面板
    await ex("(function(){document.getElementById('btnSettings').click();return 1;})()");
    await sleep(700);
    await ex("(function(){var b=document.querySelector('.settings-nav-item[data-settings-pane=\\'advanced\\']');if(b)b.click();return 1;})()");
    await sleep(900);

    const card = await ex(`(function(){
      var pane = document.querySelector('#settingsModal .settings-pane.active');
      if (!pane) return { ok: false };
      var t = document.getElementById('modsearchToggle');
      var lab = document.getElementById('modsearchLabel');
      var quota = document.getElementById('modsearchQuota');
      var testBtn = document.getElementById('btnModsearchTest');
      var saveBtn = document.getElementById('btnModsearchSave');
      var msRow = t ? t.closest('.general-section') : null;
      var csSpan = null;
      pane.querySelectorAll('.gen-label').forEach(function(e){ if (/自定义搜索服务/.test(e.textContent)) csSpan = e.closest('.general-section'); });
      var r = msRow ? msRow.getBoundingClientRect() : null;
      var pr = pane.getBoundingClientRect();
      return {
        ok: true,
        // ★ 这里叫 stateText：下面还有一个 .gen-label 的 labelText，同名键会被静默覆盖（第一次跑就栽在这）
        hasToggle: !!t, checked: !!(t && t.checked), stateText: lab ? lab.textContent.trim() : '',
        quotaText: quota ? quota.textContent.trim() : '',
        hasTestBtn: !!testBtn, hasSaveBtn: !!saveBtn,
        testBtnText: testBtn ? testBtn.textContent.trim() : '',
        beforeCustom: !!(msRow && csSpan && msRow.compareDocumentPosition(csSpan) & 4),
        cardWidth: r ? Math.round(r.width) : -1,
        paneWidth: Math.round(pr.width),
        overflowX: pane.scrollWidth - pane.clientWidth,
        amberVisible: !!(msRow && Array.prototype.some.call(msRow.querySelectorAll('small'), function(s){ return /1,000 credits/.test(s.textContent) && s.getBoundingClientRect().height > 0; })),
        labelFound: !!msRow && !!msRow.querySelector('.gen-label'),
        labelText: msRow && msRow.querySelector('.gen-label') ? msRow.querySelector('.gen-label').textContent.trim() : '',
      };
    })()`);
    check('增强检索卡渲染出来了', card.ok && card.hasToggle && card.labelFound, 'label=' + card.labelText);
    check('★ 默认是开启的（开关勾上、标签显示「开」）', card.checked && card.stateText === '开', 'checked=' + card.checked + ' state=' + card.stateText);
    check('★ 用量行拿到真实数字（不是「读取中…」占位）',
      card.ok && /本月用量/.test(card.quotaText) && !/读取中/.test(card.quotaText) && /credits/.test(card.quotaText),
      JSON.stringify(card.quotaText.slice(0, 90)));
    check('★ 限额说明可见（琥珀色那行讲清 1,000 credits/月）', card.amberVisible);
    check('★ 卡片排在「自定义搜索服务」之前（优先级顺序与检索链一致）', card.beforeCustom === true);
    check('★ 高级面板不撑出横向滚动条（长提示叠三段也不溢出）', card.overflowX <= 1, 'overflowX=' + card.overflowX);
    check('试搜按钮在位且文案标注会消耗额度', card.hasTestBtn && /消耗额度/.test(card.testBtnText), card.testBtnText);

    // 开关保存 → 服务端真的变了 → 重开设置回读一致
    const flip = await ex(`(async function(){
      var t = document.getElementById('modsearchToggle');
      t.checked = false;
      t.dispatchEvent(new Event('change'));
      document.getElementById('btnModsearchSave').click();
      await new Promise(function(r){ setTimeout(r, 900); });
      var lab = document.getElementById('modsearchLabel').textContent.trim();
      var res = document.getElementById('modsearchResult').textContent.trim();
      var g = await (await fetch('/api/search/modsearch')).json();
      return { lab: lab, res: res, serverEnabled: g.enabled, resultOk: /已保存/.test(res) };
    })()`);
    check('★ 关掉并保存：服务端真的写进 false（不是只改了界面）',
      flip.serverEnabled === false && /关/.test(flip.lab), 'server=' + flip.serverEnabled + ' lab=' + flip.lab);
    check('保存后有明确回显（不静默）', flip.resultOk === true, flip.res.slice(0, 40));

    const reopen = await ex(`(async function(){
      document.getElementById('settingsModal').classList.add('hidden');
      document.getElementById('btnSettings').click();
      await new Promise(function(r){ setTimeout(r, 700); });
      var b = document.querySelector('.settings-nav-item[data-settings-pane=\\'advanced\\']');
      if (b) b.click();
      await new Promise(function(r){ setTimeout(r, 900); });
      var t = document.getElementById('modsearchToggle');
      var g = await (await fetch('/api/search/modsearch')).json();
      return { checked: !!(t && t.checked), serverEnabled: g.enabled, quota: (document.getElementById('modsearchQuota') || {}).textContent || '' };
    })()`);
    check('★ 重开设置回读一致（关着的状态没被界面记忆覆盖）',
      reopen.checked === false && reopen.serverEnabled === false, 'checked=' + reopen.checked + ' server=' + reopen.serverEnabled);

    // 恢复开启
    const restore = await ex(`(async function(){
      var t = document.getElementById('modsearchToggle');
      t.checked = true; t.dispatchEvent(new Event('change'));
      document.getElementById('btnModsearchSave').click();
      await new Promise(function(r){ setTimeout(r, 900); });
      var g = await (await fetch('/api/search/modsearch')).json();
      return { serverEnabled: g.enabled };
    })()`);
    check('★ 已恢复为开启（不留测试残留）', restore.serverEnabled === true);

    // 英文模式：整页重载后回高级面板，扫残留汉字
    await ex("(function(){localStorage.setItem('academy.locale.v1','en');return 1;})()");
    await win.webContents.reload();
    await sleep(2600);
    await ex("(function(){document.getElementById('btnSettings').click();return 1;})()");
    await sleep(700);
    await ex("(function(){var b=document.querySelector('.settings-nav-item[data-settings-pane=\\'advanced\\']');if(b)b.click();return 1;})()");
    await sleep(1400);
    const en = await ex(`(function(){
      var t = document.getElementById('modsearchToggle');
      var sec = t ? t.closest('.general-section') : null;
      if (!sec) return { ok: false };
      var texts = [];
      var w = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
      for (var n = w.nextNode(); n; n = w.nextNode()) { if (/\\S/.test(n.nodeValue)) texts.push(n.nodeValue.replace(/\\s+/g, ' ').trim()); }
      var HAN = /[\u4e00-\u9fff]/;   // ★ 页面里没有 Node 侧的 hasHan，必须就地写
      return { ok: true, han: texts.filter(function (x) { return HAN.test(x); }), quota: (document.getElementById('modsearchQuota') || {}).textContent || '', count: texts.length };
    })()`);
    check('★ 英文模式：增强检索卡无残留汉字（用量行是拼出来的串，最容易漏）',
      en.ok && Array.isArray(en.han) && en.han.length === 0,
      en.ok ? (en.han.slice(0, 3).join(' | ') || 'quota=' + en.quota.slice(0, 80)) : 'card missing');
    await ex("(function(){localStorage.setItem('academy.locale.v1','zh-CN');return 1;})()");
    await win.webContents.reload();
    await sleep(2200);

    /* 负向对照（证明上面的断言不是空转）：
       把用量行钉回「读取中…」占位 → 那条断言必须报红。 */
    const neg = await ex("(function(){document.getElementById('modsearchQuota').textContent='本月用量：读取中…';return document.getElementById('modsearchQuota').textContent;})()");
    const negHit = /读取中/.test(neg) && !/credits/.test(neg);
    check('负向对照：占位文案确实会被「真实数字」断言抓住', negHit === true, neg.slice(0, 30));
  } catch (e) {
    check('脚本执行没有抛错', false, String(e && e.message || e));
  } finally {
    const bad = results.filter((r) => !r.ok);
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8'); } catch (_) {}
    console.log('\n增强检索设置卡真渲染：' + (results.length - bad.length) + '/' + results.length + ' 通过');
    app.exit(bad.length ? 1 : 0);
  }
});
