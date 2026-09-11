/* Academy MD Reader · 渲染逻辑（纯浏览器，无 Node） */
(function () {
  var A = window.academyReader;
  var S = { path:'', name:'', text:'', opts:null, charCount:0, mtimeMs:0, crlf:false };
  var editing = false;      // 是否处于编辑模式
  var dirty = false;        // 是否有未保存修改
  var pendingClose = false; // 关窗流程中（保存并关闭）
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
  function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  function renderText() {
    $('fileName').textContent = S.name + (dirty ? ' •' : '');
    $('fileName').title = S.path;
    renderMeta();
    document.title = (dirty ? '• ' : '') + '📖 ' + S.name;
    $('content').innerHTML = '<article class="md-content">' + (window.MDView ? MDView.mdToHtml(S.text) : '<pre>' + escapeHtml(S.text) + '</pre>') + '</article>';
  }
  function renderMeta() {
    var parts = [S.path];
    parts.push((editing ? ($('editor').value || '').length : S.text.length).toLocaleString() + ' 字');
    if (editing) parts.push(dirty ? '● 有未保存修改' : '○ 已保存');
    parts.push(editing ? 'Ctrl+S 保存 · Ctrl+E 预览' : '双击内容或点「✏️ 编辑」开始编辑');
    $('meta').textContent = parts.join(' · ');
  }

  /* ---- 脏标记：同时同步标题与主进程（主进程据此做关窗拦截）---- */
  function setDirty(v) {
    if (dirty === v) return;
    dirty = v;
    $('save').classList.toggle('dirty', dirty);
    $('save').textContent = dirty ? '💾 保存 •' : '💾 保存';
    try { A.setDirty(dirty); } catch (_) {}
    renderText();
  }

  /* ---- 模式切换 ---- */
  function enterEdit() {
    if (editing) return;
    editing = true;
    $('editor').value = S.text;
    $('editorWrap').classList.remove('hidden');
    $('content').classList.add('hidden');
    $('edit').textContent = '👁 预览';
    $('edit').title = '回到预览（Ctrl+E）';
    $('save').classList.remove('hidden');
    $('editor').focus();
    renderMeta();
  }
  function exitEdit() {
    if (!editing) return;
    // 退出编辑不丢内容：把编辑框内容同步回 S.text（但不落盘，仍算未保存）
    S.text = $('editor').value;
    editing = false;
    $('editorWrap').classList.add('hidden');
    $('content').classList.remove('hidden');
    $('edit').textContent = '✏️ 编辑';
    $('edit').title = '编辑这个文件（Ctrl+E）';
    $('save').classList.add('hidden');
    renderText();
  }
  function toggleEdit() { editing ? exitEdit() : enterEdit(); }

  /* ---- 保存 ---- */
  function doSave(opts) {
    opts = opts || {};
    var text = editing ? $('editor').value : S.text;
    if (!S.path) { showToast('没有可保存的文件'); return Promise.resolve(false); }
    return A.save({ path:S.path, text:text, mtimeMs:S.mtimeMs, crlf:S.crlf, force:!!opts.force })
      .then(function (r) {
        if (r && r.ok) {
          S.text = text;
          S.mtimeMs = r.mtimeMs || S.mtimeMs;
          setDirty(false);
          renderText();
          showToast('已保存到 ' + S.name);
          if (pendingClose) { pendingClose = false; A.closeNow(); }
          return true;
        }
        if (r && r.conflict) {
          // 文件被别的程序改过：交给用户决定，不静默覆盖
          var ok = confirm('这个文件在你编辑期间被其他程序修改过。\n\n覆盖它的修改（保留你现在的版本）？\n\n选「取消」则放弃这次保存，你的编辑仍留在窗口里。');
          if (ok) return doSave({ force: true });
          showToast('已取消保存（外部修改未被覆盖）');
          return false;
        }
        showToast('保存失败：' + ((r && r.error) || '未知错误'));
        return false;
      })
      .catch(function (e) { showToast('保存失败：' + (e && e.message || e)); return false; });
  }

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

  /* ---- 工具栏 ---- */
  $('pin').onclick = function(){ setOpt({ pin: !S.opts.pin }); showToast(S.opts.pin ? '已置顶' : '已取消置顶'); };
  $('inc').onclick = function(){ var n = Math.min(28, (S.opts.fontSize||16)+2); setOpt({ fontSize: n }); };
  $('dec').onclick = function(){ var p = Math.max(11, (S.opts.fontSize||16)-2); setOpt({ fontSize: p }); };
  $('theme').onclick = function(){
    var cur = S.opts.theme || 'auto';
    var next = cur === 'light' ? 'dark' : (cur === 'dark' ? 'auto' : 'light');
    var label = next === 'light' ? '浅色' : (next === 'dark' ? '深色' : '跟随系统');
    setOpt({ theme: next }); showToast('主题：' + label);
  };
  $('copy').onclick = function(){ var t = editing ? $('editor').value : S.text; if (!t) { showToast('没有内容'); return; } A.copyText(t).then(function(r){ showToast(r && r.ok ? '已复制 ' + t.length.toLocaleString() + ' 字' : '复制失败'); }); };
  $('word').onclick = function(){ var t = editing ? $('editor').value : S.text; if (!t) { showToast('没有内容'); return; } A.saveWord({ text:t, title:S.name }).then(function(r){ if(r && r.ok) showToast('已导出：' + r.path); else if(r && !r.canceled) showToast('导出失败'); }); };
  $('academy').onclick = function(){ if (!S.path) { showToast('没有文件可交给 Academy'); return; } A.openInAcademy(S.path).then(function(){ showToast('已交给 Academy'); }); };
  $('edit').onclick = toggleEdit;
  $('save').onclick = function(){ doSave(); };

  /* 编辑器输入 → 脏标记 */
  $('editor').addEventListener('input', function(){
    var changed = $('editor').value !== S.text;
    setDirty(changed);
    renderMeta();
  });
  /* 双击预览区直接进入编辑 */
  $('content').addEventListener('dblclick', function(){ if (S.path) enterEdit(); });

  /* 快捷键 */
  document.addEventListener('keydown', function (e) {
    var meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (S.path) doSave(); return; }
    if (meta && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); if (S.path) toggleEdit(); return; }
    if (e.key === 'Escape' && editing) { e.preventDefault(); exitEdit(); }
    // Tab 在编辑框里插入两个空格，而不是跳出焦点
    if (e.key === 'Tab' && editing && document.activeElement === $('editor')) {
      e.preventDefault();
      var ta = $('editor'), s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 2;
      setDirty(ta.value !== S.text);
      renderMeta();
    }
  });

  /* 主进程请求「保存并关闭」 */
  if (A.onSaveAndClose) {
    A.onSaveAndClose(function () { pendingClose = true; doSave(); });
  }

  A.onLoad(function(d){
    S.path = d.path || ''; S.name = d.name || '未命名'; S.text = d.text || '';
    S.charCount = d.charCount || (S.text.length|0);
    S.mtimeMs = d.mtimeMs || 0; S.crlf = !!d.crlf;
    S.opts = d.opts || { pin:false, fontSize:16 };
    // 换文件时重置编辑态
    editing = false; dirty = false;
    $('editorWrap').classList.add('hidden');
    $('content').classList.remove('hidden');
    $('edit').textContent = '✏️ 编辑';
    $('save').classList.add('hidden');
    $('save').classList.remove('dirty');
    try { A.setDirty(false); } catch (_) {}
    applyOpts(S.opts); renderText();
    try { console.log('[reader] rendered ' + S.name); } catch (_) {}
  });
  A.onEmpty(function(){ applyOpts({ pin:false, fontSize:16, theme:'auto' }); emptyState(); });
})();
