/* 证据检证 · 独立工具窗渲染逻辑（无 Node，经 preload 代理到主 App）。
 * 2026-09-19 从研究台面板独立成整页工具，端点与判定逻辑不变：
 *   快速 → /api/research/verify-quick（单轮检索 + 模型判定，任何服务商可用）
 *   完整 → /api/research/verify（内核多轮检索 + 交叉验证） */
(function () {
  var A = window.academyTool;
  var S = { port: 0, depth: 'quick', busy: false };
  var $ = function (id) { return document.getElementById(id); };
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function api(path, method, body) {
    return A.proxy({ method: method || 'GET', path: path, body: body || null }).then(function (r) {
      if (r.status === 0) throw new Error('主 App 未响应（可能已关闭）');
      var j = null;
      try { j = JSON.parse(r.body); } catch (_) {}
      return { status: r.status, json: j };
    });
  }

  /* ---- 初始化 ---- */
  A.init().then(function (st) {
    S.port = st.port || 0;
    if (st.ok) {
      $('connState').textContent = '已连接主 App :' + S.port;
      $('connState').className = 'conn ok';
      $('boot').classList.add('hidden');
      $('app').classList.remove('hidden');
      if (st.opts && st.opts.lastInput) $('workInput').value = st.opts.lastInput;
    } else {
      $('connState').textContent = '未连接';
      $('connState').className = 'conn bad';
      $('boot').innerHTML = '<p class="hint">⛔ ' + esc(st.error || '') + '<br><br>启动主 App 后，重开本窗口即可。</p>';
    }
  });

  /* ---- 深度切换 ---- */
  function setDepth(d) {
    S.depth = d;
    document.querySelectorAll('.depth-chip').forEach(function (b) { b.classList.toggle('active', b.dataset.depth === d); });
    // 说明写在 placeholder 里：单独一行会因宽度不足看不全
    $('workInput').placeholder = (d === 'quick')
      ? '贴一条论据，如：据《柳叶刀》2019 年研究，中国有 9500 万抑郁症患者。（快速检证一次只查一条，任何服务商都能用）'
      : '可一次贴多条论据，逐条核查。如：\n据《柳叶刀》2019 年研究，中国有 9500 万抑郁症患者。\n「青岛 2023 年 GDP 1.5 万亿，超过济南」。';
  }
  document.querySelectorAll('.depth-chip').forEach(function (b) {
    b.onclick = function () { setDepth(b.dataset.depth); };
  });
  setDepth('quick');

  /* ---- 检证 ---- */
  function runVerify() {
    if (S.busy) { toast('检证正在进行中…'); return; }
    var claim = ($('workInput').value || '').trim();
    if (!claim) { toast('先把要核查的论据贴进来'); return; }
    A.saveOpts({ lastInput: claim });
    var quick = S.depth === 'quick';
    if (quick) {
      var lines = claim.split('\n').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
      if (lines.length > 1) { toast('快速检证一次只查一条（' + lines.length + ' 条待检）。请删到只剩一条，或切「完整检证」。'); return; }
    }
    S.busy = true;
    $('btnRun').disabled = true;
    // 文案固定宽度避免按钮伸缩；emoji 显示宽不稳定不用在按钮里
    $('btnRun').textContent = quick ? '快速检证中…' : '完整检证中…';
    var box = $('workResult');
    box.classList.remove('hidden');
    box.innerHTML = quick
      ? '<div class="loading-bar"></div><p class="hint">⚡ 快速检证中：联网检索原始出处并核对…（约 20~40 秒）</p>'
      : '<div class="loading-bar"></div><p class="hint">🛡 完整检证中：多轮检索 + 交叉验证…（约 1~5 分钟，取决于论据数量）</p>';
    var req = quick
      ? api('/api/research/verify-quick', 'POST', { claim: claim })
      : api('/api/research/verify', 'POST', { claim: claim });
    req.then(function (r) {
      var j = r.json || {};
      if (r.status !== 200 || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      var report = j.report || '（空报告）';
      if (quick && j.disclaimer) report += '\n\n> ' + j.disclaimer;
      if (quick && (j.sources || []).length) {
        report += '\n\n**本轮检索到的来源：**\n' + j.sources.map(function (s) { return '- [' + (s.title || s.url) + '](' + s.url + ')'; }).join('\n');
      }
      box.innerHTML = '<div class="panel-title">🛡 检证报告' + (quick ? '（快速）' : '') + '<span><button type="button" class="tbtn" id="resCopy" title="复制报告">📋</button></span></div><div class="md" id="resMd"></div>';
      renderMd(document.getElementById('resMd'), report);
      document.getElementById('resCopy').onclick = function () {
        A.copyText(report).then(function () { toast('报告已复制'); });
      };
      A.setTitle(claim.slice(0, 14) || '证据检证');
    }).catch(function (e) {
      box.innerHTML = '<p class="hint">检证失败：' + esc(e.message) + '</p>';
    }).then(function () {
      S.busy = false;
      $('btnRun').disabled = false;
      $('btnRun').textContent = '开始检证';
    });
  }
  $('btnRun').onclick = runVerify;
  /* Ctrl/Cmd+Enter 直接开始 */
  $('workInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runVerify(); }
  });

  /* ---- 跳转资料溯源 ---- */
  $('btnGoTrace').onclick = function () {
    A.openTool('trace').then(function (r) {
      if (!(r && r.ok)) toast('打开失败：' + ((r && r.error) || ''));
    });
  };

  function renderMd(el, text) {
    el.innerHTML = window.MDView ? window.MDView.mdToHtml(text) : '<pre>' + esc(text) + '</pre>';
  }
})();
