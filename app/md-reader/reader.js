/* Academy MD Reader · 渲染逻辑（纯浏览器，无 Node） */
(function () {
  var A = window.academyReader;
  var S = { path:'', name:'', text:'', opts:null };
  var $ = function (id) { return document.getElementById(id); };
  var toastTimer = null;
  function showToast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.classList.remove('show'); }, ms || 2600);
  }
  function applyOpts(o) {
    var d = document.documentElement;
    d.style.setProperty('font-size', (o.fontSize || 16) + 'px');
    d.dataset.theme = o.theme === 'light' ? 'light' : (o.theme === 'dark' ? 'dark' : '');
    $('pin').classList.toggle('active', !!o.pin);
    $('sizeVal').textContent = o.fontSize || 16;
  }
  function renderText() {
    $('fileName').textContent = S.name; $('fileName').title = S.path;
    $('meta').textContent = S.path + ' · ' + S.charCount.toLocaleString() + ' 字';
    document.title = '📖 ' + S.name;
    $('content').innerHTML = '<article class="md-content">' + (window.MDView ? MDView.mdToHtml(S.text) : '<pre>' + escapeHtml(S.text) + '</pre>') + '</article>';
  }
  function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function emptyState() {
    $('fileName').textContent = 'Academy MD 阅读';
    $('fileName').title = '';
    $('meta').textContent = '没有指定要打开的文件';
    $('content').innerHTML = '<p class="hint">没用这种姿势启动。<br>右键 .md → 打开方式 → 选择「Academy 辩论教练」，<br>或双击让它用本阅读器打开。</p>';
  }
  function setOpt(partial) {
    S.opts = Object.assign({}, S.opts, partial);
    applyOpts(S.opts);
  }
  $('pin').onclick = function(){ setOpt({ pin: !S.opts.pin }); showToast(S.opts.pin ? '已置顶' : '已取消置顶'); };
  $('inc').onclick = function(){ var n = Math.min(28, (S.opts.fontSize||16)+2); setOpt({ fontSize: n }); };
  $('dec').onclick = function(){ var p = Math.max(11, (S.opts.fontSize||16)-2); setOpt({ fontSize: p }); };
  $('theme').onclick = function(){
    var cur = S.opts.theme || 'auto';
    var next = cur === 'light' ? 'dark' : (cur === 'dark' ? 'auto' : 'light');
    var label = next === 'light' ? '浅色' : (next === 'dark' ? '深色' : '跟随系统');
    setOpt({ theme: next }); showToast('主题：' + label);
  };
  $('copy').onclick = function(){ if (!S.text) { showToast('没有内容'); return; } A.copyText(S.text).then(function(r){ showToast(r && r.ok ? '已复制 ' + S.charCount.toLocaleString() + ' 字' : '复制失败'); }); };
  $('word').onclick = function(){ if (!S.text) { showToast('没有内容'); return; } A.saveWord({ text:S.text, title:S.name }).then(function(r){ if(r && r.ok) showToast('已导出：' + r.path); else if(r && !r.canceled) showToast('导出失败'); }); };
  $('academy').onclick = function(){ if (!S.path) { showToast('没有文件可交给 Academy'); return; } A.openInAcademy(S.path).then(function(){ showToast('已交给 Academy'); }); };

  A.onLoad(function(d){
    S.path = d.path || ''; S.name = d.name || '未命名'; S.text = d.text || ''; S.charCount = d.charCount || (S.text.length|0); S.opts = d.opts || { pin:false, fontSize:16 };
    applyOpts(S.opts); renderText();
    try { console.log('[reader] rendered ' + S.name); } catch (_) {}
  });
  A.onEmpty(function(){ applyOpts({ pin:false, fontSize:16, theme:'auto' }); emptyState(); });
})();
