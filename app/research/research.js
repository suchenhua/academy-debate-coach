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
    S.mode = (st.opts && st.opts.mode) || 'server';   // 默认深度检索：『能用』比『免费』重要
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
      ? '结果更准、覆盖更全，用当前模型的额度。'
      : '不花钱，但覆盖有限：部分网络下免费搜索源会被限制，可能搜不到相关结果。';
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

      // 基础检索（免费）被反爬/降级页面挡住时，服务端会标记 lowQuality。
      // 这时必须明确告诉用户「没搜到」并给出下一步，而不是把无关结果当正常结果显示。
      if (j.lowQuality) {
        box.innerHTML =
          '<div class="search-warn">' +
          '<b>⚠️ 基础检索没找到相关结果</b><br>' +
          esc(j.notice || '当前网络下免费搜索源被限制。') +
          '<div class="acts">' +
          '<button class="btn primary" id="warnSwitch">⭐ 改用深度检索</button>' +
          '<button class="btn" id="warnCopy">📋 复制关键词去浏览器搜</button>' +
          '</div>' +
          '</div>';
        var sw = document.getElementById('warnSwitch');
        if (sw) sw.onclick = function () { setMode('server'); doSearch(q); };
        var cp = document.getElementById('warnCopy');
        if (cp) cp.onclick = function () { A.copyText(q).then(function () { toast('关键词已复制，可粘贴到浏览器搜索'); }); };
        return;
      }

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

  /* ---- 证据检证：已独立成工具窗（app/verify/），这里只留跳转入口 ---- */
  $('btnVerify').onclick = function () {
    if (A.openVerify) {
      A.openVerify().then(function (r) {
        if (!(r && r.ok)) toast('打开失败：' + ((r && r.error) || ''));
      });
    } else {
      toast('证据检证是独立小窗，需要桌面版（Electron）环境');
    }
  };
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
