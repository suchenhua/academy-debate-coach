/* Academy Research · 研究台渲染逻辑（无 Node，经 preload 代理到主 App） */
(function () {
  var A = window.academyResearch;
  var S = { port: 0, mode: 'free', history: [], busy: false };
  var $ = function (id) { return document.getElementById(id); };
  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2600);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  /* ---- 主 App 请求 ---- */
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
    S.mode = (st.opts && st.opts.mode) || 'free';
    if (st.ok) {
      $('connState').textContent = '已连接主 App :' + S.port;
      $('connState').className = 'conn ok';
      $('boot').classList.add('hidden');
      $('app').classList.remove('hidden');
      if (st.opts.lastTopic) $('topic').value = st.opts.lastTopic;
      setMode(S.mode);
    } else {
      $('connState').textContent = '未连接';
      $('connState').className = 'conn bad';
      $('boot').innerHTML = '<p class="hint">⛔ ' + esc(st.error || '') + '<br><br>启动主 App 后，重开本窗口即可。</p>';
    }
  });

  /* ---- 通道切换 ---- */
  function setMode(mode) {
    S.mode = mode;
    document.querySelectorAll('.mode-chip').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
    $('modeNote').textContent = (mode === 'server')
      ? '服务侧：调当前模型商的原生搜索，更准、扣模型余额（仅 DeepSeek 官方支持）。'
      : '端侧：本地抓取 Bing / DuckDuckGo，免费、不需要 Key。';
    A.saveOpts({ mode: mode });
  }
  document.querySelectorAll('.mode-chip').forEach(function (b) {
    b.onclick = function () { setMode(b.dataset.mode); };
  });

  /* ---- 搜索 ---- */
  function doSearch(q) {
    q = (q || $('topic').value || '').trim();
    if (!q) { toast('先输入要搜的内容'); return; }
    A.saveOpts({ lastTopic: q });
    A.setTitle('🔍 ' + q.slice(0, 18) + ' · 研究台');
    var box = $('resultsBox');
    box.innerHTML = '<p class="hint loading">搜索中（' + (S.mode === 'server' ? '服务侧，稍慢' : '端侧') + '）</p>';
    api('/api/search?q=' + encodeURIComponent(q) + '&mode=' + S.mode).then(function (r) {
      var j = r.json || {};
      if (r.status !== 200 || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      var srcs = j.sources || [];
      if (!srcs.length) { box.innerHTML = '<p class="hint">没有结果，换个关键词试试</p>'; return; }
      box.innerHTML = '';
      srcs.forEach(function (s) {
        var d = document.createElement('div'); d.className = 'result';
        d.innerHTML =
          '<a class="t" target="_blank" rel="noopener" href="' + esc(s.url) + '">' + esc(s.title || s.url) + '</a>' +
          '<div class="u">' + esc(s.url) + '</div>' +
          (s.snippet ? '<div class="s">' + esc(s.snippet) + '</div>' : '') +
          '<div class="acts">' +
          '<button class="btn" data-act="cite">📤 给研究助手</button>' +
          '<button class="btn" data-act="copy">📋 复制</button>' +
          '</div>';
        d.querySelector('[data-act=cite]').onclick = function () {
          sendChat('我搜到了这条资料，帮我判断可信度、口径，以及能用在哪个环节：\n\n【' + (s.title || s.url) + '】\n' + (s.url || '') + (s.snippet ? '\n摘要：' + s.snippet : ''));
        };
        d.querySelector('[data-act=copy]').onclick = function () {
          A.copyText((s.title || '') + ' ' + (s.url || '')).then(function () { toast('已复制'); });
        };
        box.appendChild(d);
      });
    }).catch(function (e) { box.innerHTML = '<p class="hint">搜索失败：' + esc(e.message) + '</p>'; });
  }

  /* ---- 建议该搜什么（7 触发条件，走内核）---- */
  function doSuggest() {
    var q = ($('topic').value || '').trim();
    if (!q) { toast('先输入辩题或关键词'); return; }
    var box = $('suggestBox');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="suggest-title">📋 建议该搜什么（按 7 种触发条件分析）</div><p class="hint loading">正在分析（走内核，约 10~30 秒）…</p>';
    $('btnSuggest').disabled = true;
    api('/api/research/suggest', 'POST', { topic: q }).then(function (r) {
      var j = r.json || {};
      $('btnSuggest').disabled = false;
      var hits = j.hits || [];
      if (!hits.length) {
        box.innerHTML = '<div class="suggest-title">📋 建议该搜什么</div><p class="hint">没有拿到结构化建议' + (j.raw ? '，原始输出：<br>' + esc(j.raw).slice(0, 300) : '') + '</p>';
        return;
      }
      box.innerHTML = '<div class="suggest-title">📋 建议该搜什么（' + hits.length + ' 项）</div>';
      hits.forEach(function (h) {
        var d = document.createElement('div'); d.className = 'suggest-item';
        d.innerHTML =
          '<span class="trg">' + esc(h.trigger || '建议') + '</span>' +
          '<div class="q">' + esc(h.query) + (h.reason ? '<div class="why">' + esc(h.reason) + '</div>' : '') + '</div>' +
          '<button class="btn">🔍 搜</button>';
        d.querySelector('button').onclick = function () { doSearch(h.query); };
        box.appendChild(d);
      });
    }).catch(function (e) { $('btnSuggest').disabled = false; box.innerHTML = '<div class="suggest-title">📋 建议该搜什么</div><p class="hint">失败：' + esc(e.message) + '</p>'; });
  }

  $('btnSearch').onclick = function () { doSearch(); };
  $('btnSuggest').onclick = doSuggest;

  /* ---- 证据检证：论据是否被编造 / 曲解（真联网核查） ---- */
  var verifying = false;
  function runVerify() {
    if (verifying) { toast('检证正在进行中…'); return; }
    var claim = ($('verifyInput').value || '').trim();
    if (!claim) { toast('先把要核查的论据贴进来'); return; }
    verifying = true;
    $('btnVerifyRun').disabled = true;
    $('btnVerifyRun').textContent = '🛡 检证中…';
    var box = $('verifyResult');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="loading-bar"></div><p class="hint">研究助手正在联网检索原始出处、核对数字与结论…（约 1~5 分钟，取决于论据数量）</p>';
    api('/api/research/verify', 'POST', { claim: claim, context: ($('topic').value || '').trim() }).then(function (r) {
      var j = r.json || {};
      if (r.status !== 200 || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      box.innerHTML = '<div class="verify-title">🛡 检证报告<button type="button" class="tbtn" id="verifyCopy" title="复制报告">📋</button><button type="button" class="tbtn" id="verifyToChat" title="发给研究助手讨论">💬</button></div><div class="md" id="verifyMd"></div>';
      renderMd(document.getElementById('verifyMd'), j.report || '（空报告）');
      document.getElementById('verifyCopy').onclick = function () {
        A.copyText(j.report || '').then(function () { toast('报告已复制'); });
      };
      document.getElementById('verifyToChat').onclick = function () {
        sendChat('关于我刚做的证据检证报告，有几个点想再讨论：\n\n' + (j.report || '').slice(0, 1200));
      };
    }).catch(function (e) {
      box.innerHTML = '<p class="hint">检证失败：' + esc(e.message) + '</p>';
    }).then(function () {
      // 收尾（无论成败）：恢复按钮状态
      verifying = false;
      $('btnVerifyRun').disabled = false;
      $('btnVerifyRun').textContent = '🛡 开始检证';
    });
  }
  $('btnVerify').onclick = function () {
    var box = $('verifyBox');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
      $('verifyBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };
  $('verifyClose').onclick = function () { $('verifyBox').classList.add('hidden'); };
  $('btnVerifyRun').onclick = runVerify;
  $('topic').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

  /* ---- 独立对话（research 模式，走主 App /api/chat/stream）---- */
  function renderMd(el, text) {
    el.innerHTML = window.MDView ? window.MDView.mdToHtml(text) : '<pre>' + esc(text) + '</pre>';
  }
  function addMsg(role, text) {
    var d = document.createElement('div');
    d.className = 'msg ' + role;
    if (role === 'user') d.textContent = text; else renderMd(d, text || '');
    $('chatLog').appendChild(d);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    return d;
  }
  function sendChat(text) {
    text = (text != null ? text : $('chatInput').value).trim();
    if (!text) return;
    if (S.busy) { toast('研究助手正在回复，稍等…'); return; }
    if (!S.port) { toast('主 App 未连接'); return; }
    addMsg('user', text);
    $('chatInput').value = '';
    S.busy = true;
    $('btnChatSend').disabled = true;
    var holder = addMsg('assistant', '…');
    var acc = '';
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'http://127.0.0.1:' + S.port + '/api/chat/stream');
    xhr.setRequestHeader('Content-Type', 'application/json');
    var seen = 0;
    xhr.onprogress = function () {
      var txt = xhr.responseText;
      var chunk = txt.slice(seen); seen = txt.length;
      chunk.split('\n\n').forEach(function (blk) {
        var lines = blk.split('\n');
        var ev = '', data = '';
        lines.forEach(function (l) {
          if (l.indexOf('event:') === 0) ev = l.slice(6).trim();
          if (l.indexOf('data:') === 0) data += l.slice(5).trim();
        });
        if (!ev || !data) return;
        try {
          var j = JSON.parse(data);
          if (ev === 'delta' && j.text) { acc += j.text; renderMd(holder, acc); $('chatLog').scrollTop = $('chatLog').scrollHeight; }
          else if (ev === 'done') { acc = j.text || acc; renderMd(holder, acc); $('chatLog').scrollTop = $('chatLog').scrollHeight; }
          else if (ev === 'error') { holder.className = 'msg assistant error'; holder.textContent = j.message || '任务失败'; }
        } catch (_) {}
      });
    };
    xhr.onload = function () {
      if (!acc && xhr.responseText) {
        // 兜底：流没给增量时，从 done 里取全文
        var m = xhr.responseText.match(/event: done\ndata: ([\s\S]*?)/);
        try { var j = JSON.parse(xhr.responseText.split('event: done\ndata: ')[1] || '{}'); if (j.text) renderMd(holder, j.text); } catch (_) {}
      }
      S.history.push({ role: 'user', text: text });
      S.history.push({ role: 'assistant', text: acc || '（无回复）' });
      if (S.history.length > 40) S.history = S.history.slice(-40);
      S.busy = false;
      $('btnChatSend').disabled = false;
    };
    xhr.onerror = function () {
      holder.className = 'msg assistant error';
      holder.textContent = '请求失败：主 App 可能已关闭。';
      S.busy = false;
      $('btnChatSend').disabled = false;
    };
    xhr.send(JSON.stringify({ mode: 'research', text: text, history: S.history.slice(0, -1) }));
  }
  $('btnChatSend').onclick = function () { sendChat(); };
  $('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
  });
  $('btnChatClear').onclick = function () {
    if (!S.history.length) { toast('当前对话已为空'); return; }
    if (!confirm('清空本窗口与研究助手的当前对话？（主 App 的对话不受影响）')) return;
    S.history = [];
    $('chatLog').innerHTML = '<p class="hint">已清空。继续问，或把搜索结果贴过来。</p>';
    toast('已清空（仅本面板对话）');
  };
})();
