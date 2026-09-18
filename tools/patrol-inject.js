/* 巡检注入脚本 —— 作为独立文件存在，可由 node --check 校验。
 *
 * 为什么不写在主进程里用字符串拼：引号转义极易错，且报错只出现在渲染进程，
 * 主进程只看到 "Script failed to execute"。写成文件后 node --check 阶段就暴露。
 *
 * 与 Pro 线同名文件的差异（Flash 是单页聊天布局，没有 .pane / .rail）：
 *   - snap 的「界面标识」= 侧栏激活模式 + 打开的弹窗 + 设置页激活标签
 *   - 弹窗打开走真实入口按钮（openBtn），保证弹窗内容照常加载
 */
(function () {
  'use strict';

  /* ---- 原生对话框 hook ----
     confirm() 在 Electron 里是模态阻塞的 —— 一旦弹出渲染进程就挂住，
     executeJavaScript 永不返回（巡检表现为「卡死且无报错」）。
     替换成记录 + 立即返回，既不会卡，还能顺便发现「哪些按钮会弹框」。
     顺带兜底 window.prompt：Electron 本来就不支持，真被调用会抛错。 */
  var dialogCalls = [];
  window.confirm = function (msg) { dialogCalls.push({ type: 'confirm', msg: String(msg || '').slice(0, 120) }); return false; };
  window.alert = function (msg) { dialogCalls.push({ type: 'alert', msg: String(msg || '').slice(0, 120) }); };
  window.prompt = function (msg) { dialogCalls.push({ type: 'prompt', msg: String(msg || '').slice(0, 120) }); return null; };

  function activeMode() {
    var btns = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].classList.contains('active')) return btns[i].dataset.mode || '';
    }
    return '';
  }

  function inputSig() {
    /* input type 切换（如 Key 的 👁 明暗文）对文本快照不可见 */
    var k = document.getElementById('apiKeyInput');
    return k ? k.type : '';
  }

  function snap() {
    var modals = Array.prototype.slice.call(document.querySelectorAll('.modal'));
    var open = modals.filter(function (m) { return !m.classList.contains('hidden'); })
      .map(function (m) { return m.id; }).join(',');
    var sPane = document.querySelector('.settings-pane.active');
    var drop = document.getElementById('exportDropdown');
    var dropOpen = drop && !drop.classList.contains('hidden') ? 'exportDropdown' : '';
    var toastEl = document.getElementById('toast');
    var fullTxt = (document.body.innerText || '').replace(/\s+/g, ' ');
    /* 激活元素签名：筛选 chips / 主题选择 / 模式切换只改 class，
       不改文本和 hidden 数，快照不看 active 签名就会误判「无反应」 */
    var activeSig = Array.prototype.slice.call(document.querySelectorAll('.active'))
      .map(function (e) { return e.id || e.dataset.mode || e.dataset.export || (e.textContent || '').trim().slice(0, 10); })
      .filter(Boolean).sort().join(',');
    return {
      pane: activeMode() + (sPane ? '|' + (sPane.dataset.settingsPane || '') : ''),
      modals: [open, dropOpen].filter(Boolean).join(','),
      hidden: document.querySelectorAll('.hidden').length,
      /* toast 单独取出：靠 innerText 截断会漏 */
      toast: toastEl ? (toastEl.textContent || '').trim().slice(0, 80) : '',
      dialogs: dialogCalls.length,
      /* 设置弹窗在 DOM 末尾，前 1200 字符截不到它的反馈区 → 加全文长度兜底 */
      txtLen: fullTxt.length,
      txt: fullTxt.slice(0, 1200),
      activeSig: activeSig.slice(0, 400),
      keySig: inputSig()
    };
  }

  function list(sel) {
    return Array.prototype.slice.call(document.querySelectorAll(sel)).map(function (el, i) {
      return {
        i: i,
        id: el.id || '',
        ds: el.dataset ? (el.dataset.export || el.dataset.go || '') : '',
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        visible: !!(el.offsetParent || el.offsetWidth || el.offsetHeight)
      };
    });
  }

  /* 点击第 idx 个匹配元素。返回 'ok' 或错误信息（不抛给主进程） */
  function clickOne(sel, idx) {
    var els = document.querySelectorAll(sel);
    var el = els[idx];
    if (!el) return 'gone';
    try { el.click(); return 'ok'; } catch (e) { return 'err:' + e.message; }
  }

  function closeAllModals() {
    Array.prototype.slice.call(document.querySelectorAll('.modal'))
      .forEach(function (m) { m.classList.add('hidden'); });
    var drop = document.getElementById('exportDropdown');
    if (drop) drop.classList.add('hidden');
  }

  /* ---- 界面切换辅助：弹窗一律点真实入口按钮（内容是打开时加载的） ---- */
  function clickId(id) {
    var b = document.getElementById(id);
    if (!b) return false;
    b.click();
    return true;
  }
  function settingsTab(name) {
    clickId('btnSettings');
    var items = document.querySelectorAll('.settings-nav .settings-nav-item');
    for (var i = 0; i < items.length; i++) {
      if ((items[i].dataset.settingsPane || '') === name) { items[i].click(); return true; }
    }
    return false;
  }
  function openExportMenu() { return clickId('btnExportSession'); }

  window.__patrol = {
    snap: snap,
    snapJson: function () { return JSON.stringify(snap()); },
    listJson: function (sel) { return JSON.stringify(list(sel)); },
    clickOne: clickOne,
    closeAllModals: closeAllModals,
    takeDialogs: function () { var d = dialogCalls.slice(); dialogCalls.length = 0; return JSON.stringify(d); },
    clickId: function (id) { return JSON.stringify(clickId(id)); },
    settingsTab: function (n) { return JSON.stringify(settingsTab(n)); },
    openExportMenu: function () { return JSON.stringify(openExportMenu()); }
  };

  return 'patrol-inject-ok';
})();
