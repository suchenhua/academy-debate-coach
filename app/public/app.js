/* Academy 辩论教练 · 前端 */
'use strict';

/* ================= 基础状态 ================= */
const LS_KEY = 'academy.chats.v1';
const MODES = {
  free: { title: '自由问答', desc: '直接提问：辩题分析、方法论、辩手风格、赛制规则，都可以问。', prompts: [
    '帮我分析一个辩题：「年轻人应该/不应该先就业再择业」，我持反方',
    '逻敏教练怎么教「打钉子」和「击穿」？',
    '新国辩赛制下一辩稿要写多长、结构怎么排？',
    '华语辩论世界杯的赛制环节和时间是怎样的？',
  ]},
  prep: { title: '备赛', desc: '立论 · 质询 · 攻防 · 一辩稿。请写明：辩题、持方、赛制、需要交付的内容。', prompts: [
    '我的辩题是「应急教育应纳入大学课程/中小学课程」，我持正方，帮我分析辩题+出立论框架',
    '给我一套完整备赛包：定义、判准、论点、一辩稿、弹药库、结辩稿',
    '帮我设计首质链，并预判对方三个最可能的反驳',
    '给我的立论做攻防预判：哪些地方会被击穿，怎么补',
  ]},
  review: { title: '复盘', desc: '粘贴比赛文字稿（txt/md/srt 或直接粘贴），逐帧纠偏、给替代表述。', prompts: [
    '复盘这场比赛（下面贴文字稿）：辩题「…」，赛制新国辩',
    '给这段攻防做逐帧纠偏，并给出可以直接替换的表述',
    '诊断这场比赛的主线形态（1/2/0 型），并给 3 条改进优先级',
  ]},
  judge: { title: '评判', desc: '三票制评分 + 九段式述票。请写明赛制和比赛文字稿。', prompts: [
    '你当评委：三票制给这场比赛打分，并写九段式述票词',
    '给我一份可以直接照着念的述票词，比赛文字稿如下…',
    '咨询判准：印象票、环节票、总结票分别怎么投？',
  ]},
};

const MODE_LS_KEY = 'academy.mode.v1';
function restoreMode() {
  try {
    const m = localStorage.getItem(MODE_LS_KEY);
    return ['free', 'prep', 'review', 'judge'].includes(m) ? m : 'free';
  } catch (_) { return 'free'; }
}

/* ———— 外观（浅色/深色/跟随系统） ———— */
const THEME_LS = 'academy.theme.v1';
function restoreTheme() {
  try {
    const v = localStorage.getItem(THEME_LS);
    return ['light', 'dark', 'system'].includes(v) ? v : 'system';
  } catch (_) { return 'system'; }
}
function resolveTheme(pref) {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  let sysDark = false;
  try { sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) {}
  return sysDark ? 'dark' : 'light';
}
function applyTheme() {
  const pref = restoreTheme();
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  // 同步设置里的三选高亮
  document.querySelectorAll('#themeChoices .gen-choice').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeVal === pref);
  });
  // 广播给工具页（新开窗口读取同一 localStorage 自动适配）
  try { localStorage.setItem(THEME_LS, pref); } catch (_) {}
}
function setTheme(pref) {
  try { localStorage.setItem(THEME_LS, pref); } catch (_) {}
  applyTheme();
  syncToolThemes();
}
/* 工具页主题同步：浅色 → body.light；深色 → 移除 */
function syncToolThemes() {
  const resolved = resolveTheme(restoreTheme());
  // 工具页由各自页面脚本读取 localStorage；这里仅确保主界面一致。
  // 若工具页已在同一窗口(iframe)打开则遍历：
  document.querySelectorAll('iframe.theme-tool').forEach((f) => {
    try {
      const doc = f.contentDocument;
      if (!doc) return;
      if (resolved === 'light') doc.body.classList.add('light');
      else doc.body.classList.remove('light');
    } catch (_) {}
  });
}
/* ———— 界面语言（简体 / 繁体） ———— */
const LOCALE_LS = 'academy.locale.v1';
function restoreLocale() {
  try {
    const v = localStorage.getItem(LOCALE_LS);
    return v === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  } catch (_) { return 'zh-CN'; }
}
function setLocale(val) {
  try { localStorage.setItem(LOCALE_LS, val === 'zh-TW' ? 'zh-TW' : 'zh-CN'); } catch (_) {}
  document.documentElement.lang = restoreLocale();
  syncLocaleChoices();
  // 立即转换 + 多次延迟兜底（覆盖异步渲染写完的界面文案）
  applyLocaleToStatic();
  [200, 600, 1200].forEach((ms) => setTimeout(() => { try { applyLocaleToStatic(); updateModeUI(); } catch (_) {} }, ms));
  refreshStatus().catch(() => {});
}

/* ———— 对话字体大小（设置 → 通用，12–22px，存 localStorage） ———— */
const CHAT_FS_LS = 'academy.chatfs.v1';
const CHAT_FS_DEFAULT = 15;
function clampChatFs(v) {
  // 注意：localStorage 未设置时返回 null，Number(null)===0 是有限数，必须显式排除，否则首装会掉到 12px
  const n = (v === null || v === undefined || String(v).trim() === '') ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(22, Math.max(12, Math.round(n))) : CHAT_FS_DEFAULT;
}
function restoreChatFs() {
  try { return clampChatFs(localStorage.getItem(CHAT_FS_LS)); } catch (_) { return CHAT_FS_DEFAULT; }
}
function applyChatFs() {
  const px = restoreChatFs();
  document.documentElement.style.setProperty('--chat-fs', px + 'px');
  const range = document.getElementById('chatFontRange');
  const label = document.getElementById('chatFontValue');
  if (range && range.value !== String(px)) range.value = String(px);
  if (label) label.textContent = px + 'px';
}
function setChatFs(v) {
  const px = clampChatFs(v);
  try { localStorage.setItem(CHAT_FS_LS, String(px)); } catch (_) {}
  applyChatFs();
}
function syncLocaleChoices() {
  const cur = restoreLocale();
  document.querySelectorAll('#localeChoices .gen-choice').forEach((b) => {
    b.classList.toggle('active', b.dataset.localeVal === cur);
  });
}

const state = {
  mode: restoreMode(),
  chats: [], // 由 loadChatsAsync() 异步填充（文件存储）
  chatId: null,
  messages: [],
  status: null,
  running: false,
  lastRunText: '',
  /* 每个模式各自的"当前对话"指针：切模式时互相不干扰 */
  chatIdByMode: { free: null, prep: null, review: null, judge: null },
  attachments: [], // 待发送的附件（文件卡片）
};

/* ================= 工具函数 ================= */
function $(sel) { return document.querySelector(sel); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}
function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtElapsed(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + ' 秒';
  return Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
}

const CHATS_API = '/api/chats';
const CHATS_LS_MIGRATED = 'academy.chats.v1.migratedAt';

/* 规范化对话数组（补齐 id/mode/messages，兼容旧数据） */
function normalizeChats(arr) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  const MODES_KEYS = ['free', 'prep', 'review', 'judge'];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    if (!MODES_KEYS.includes(c.mode)) c.mode = 'free';
    if (!Array.isArray(c.messages)) c.messages = [];
    if (!c.id) c.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    out.push(c);
  }
  return out;
}

function readLegacyChats() {
  try { return normalizeChats(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); } catch (_) { return []; }
}

/* 异步加载：优先服务端文件存储；服务端为空时自动迁移旧 localStorage 数据 */
async function loadChatsAsync() {
  try {
    const r = await fetchJSON(CHATS_API);
    if (r && r.ok && Array.isArray(r.chats)) {
      if (r.chats.length) return normalizeChats(r.chats);
      const legacy = readLegacyChats();
      if (legacy.length) {
        try {
          await fetchJSON(CHATS_API, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chats: legacy }),
          });
          localStorage.setItem(CHATS_LS_MIGRATED, String(Date.now()));
          console.log('[Academy] 已把 ' + legacy.length + ' 个旧对话迁移到文件存储');
        } catch (_) {}
        return legacy;
      }
      return [];
    }
  } catch (_) {}
  // 兜底：服务端不可用时继续读 localStorage，保证对话不丢
  return readLegacyChats();
}

/* 保存：直接异步写服务端（本地写盘毫秒级，且调用频率低，优先保证不丢数据）；
   服务端失败时降级写 localStorage，关窗前还有同步兜底。 */
function saveChats() {
  flushChats();
}
function flushChats() {
  const chats = state.chats || [];
  fetchJSON(CHATS_API, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chats }),
  }).catch(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(chats.slice(0, 50))); } catch (_) {}
  });
}
/* 关闭窗口/刷新前同步落盘，避免最后 300ms 的改动丢失 */
function flushChatsSync() {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', CHATS_API, false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({ chats: state.chats || [] }));
  } catch (_) {}
}
window.addEventListener('beforeunload', () => { flushChatsSync(); });

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.message || data.error || ('HTTP ' + res.status));
  return data;
}

/* ================= Markdown 渲染（本地实现，离线可用） ================= */
function inlineMd(src) {
  let s = esc(src);
  // 行内代码（先处理，避免内部再被其他规则修改）
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => '<code>' + c + '</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function mdToHtml(src) {
  const text = String(src || '').replace(/\r\n/g, '\n');
  const codeBlocks = [];
  // 提取围栏代码块
  const withPlaceholders = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    codeBlocks.push({ lang, code });
    return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
  });

  const lines = withPlaceholders.split('\n');
  const html = [];
  let i = 0;
  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l) && l.includes('|');

  while (i < lines.length) {
    const line = lines[i];

    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
      const idx = Number(line.trim().match(/CODE(\d+)/)[1]);
      const b = codeBlocks[idx];
      html.push('<pre' + (b.lang ? ' data-lang="' + esc(b.lang) + '"' : '') + '><code>' + esc(b.code) + '</code></pre>');
      i += 1;
      continue;
    }
    if (/^\s*$/.test(line)) { i += 1; continue; }
    if (/^#{1,4}\s+/.test(line)) {
      const m = line.match(/^(#{1,4})\s+(.*)$/);
      const level = m[1].length;
      html.push('<h' + level + '>' + inlineMd(m[2]) + '</h' + level + '>');
      i += 1;
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { html.push('<hr />'); i += 1; continue; }

    // 表格
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:\-|]+\|\s*$/.test(lines[i + 1])) {
      const headCells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i += 1;
      }
      let t = '<table><thead><tr>' + headCells.map((c) => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>';
      t += rows.map((r) => '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('');
      t += '</tbody></table>';
      html.push(t);
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      html.push('<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>');
      continue;
    }

    // 列表
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const buf = [];
      while (i < lines.length) {
        const l = lines[i];
        if (ordered && /^\s*\d+[.)]\s+/.test(l)) { buf.push(l.replace(/^\s*\d+[.)]\s*/, '')); i += 1; continue; }
        if (!ordered && /^\s*[-*+]\s+/.test(l)) { buf.push(l.replace(/^\s*[-*+]\s*/, '')); i += 1; continue; }
        if (/^\s{2,}/.test(l)) { buf[buf.length - 1] += '\n' + l.trim(); i += 1; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push('<' + tag + '>' + buf.map((it) => '<li>' + inlineMd(it) + '</li>').join('') + '</' + tag + '>');
      continue;
    }

    // 普通段落
    const buf = [line];
    i += 1;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s+|\s*(---+|\*\*\*+|___+)\s*$|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(lines[i]) && !isTableRow(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    html.push('<p>' + inlineMd(buf.join(' ')) + '</p>');
  }

  return html.join('');
}

/* ================= 对话持久化 ================= */
function currentChat() {
  return state.chats.find((c) => c.id === state.chatId) || null;
}
function persistChat() {
  const c = currentChat();
  if (!c) return;
  c.messages = state.messages;
  c.updated = Date.now();
  saveChats();
}
function newChat(mode) {
  state.mode = mode || state.mode;
  state.chatId = null;
  state.messages = [];
  state.chatIdByMode[state.mode] = null;
  updateModeUI();
  $('#input').value = ''; // 新建对话清空输入框
  updateCharCount();
  renderMessages();
  renderHistory();
  focusInput();
}
function switchChat(id) {
  const c = state.chats.find((x) => x.id === id);
  if (!c || c.mode !== state.mode) return; // 只允许打开当前模式的对话
  state.chatId = id;
  state.messages = (c.messages || []).slice();
  state.chatIdByMode[state.mode] = id;
  renderMessages();
  renderHistory();
  scrollBottom();
}
function ensureChat(firstText) {
  if (!currentChat()) {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.chats.unshift({
      id,
      mode: state.mode,
      title: String(firstText || '新对话').replace(/\s+/g, ' ').slice(0, 24),
      created: Date.now(),
      updated: Date.now(),
      messages: [],
    });
    state.chatId = id;
    state.chatIdByMode[state.mode] = id;
    renderHistory();
  }
}

/* ================= 消息渲染 ================= */
function renderMessages() {
  resetSmoothStream();
  const box = $('#messages');
  box.innerHTML = '';
  if (!state.messages.length) {
    const modeT = modeMeta[state.mode] || {};
    const empty = el('div', 'msg assistant');
    empty.innerHTML = '<div class="avatar">🎓</div><div class="bubble"><div class="md"><p>你好，我是<b>逻敏</b>。当前在<b>' + (modeT.title || state.mode) + '</b>模式：' + (modeT.desc || '') + '</p><p>这是该模式<b>独立</b>的对话空间，切换模式不会把这段对话带过去。把辩题、比赛文字稿或任何辩论问题发给我即可。</p></div></div>';
    box.appendChild(empty);
    renderUsageSummary();
    return;
  }
  for (const [idx, m] of state.messages.entries()) {
    box.appendChild(renderMessage(idx, m));
  }
  scrollBottom();
  renderUsageSummary();
}

/* 输入框下方常驻 Token 统计栏：本对话累计 输入/缓存命中/输出/推理 + 上下文已使用占比 */
/* 上下文占比口径：最近一条带用量的消息，其当轮输入（输入+缓存读）÷ 该模型上下文窗口，
   约等于当前对话已塞进上下文的比例。 */
function latestContextUsed() {
  for (const m of (state.messages || []).slice().reverse()) {
    const u = m && m.usageTotal;
    if (!u) continue;
    const input = (u.input || 0) + (u.cacheRead || 0);
    if (input <= 0) continue;
    return { used: input, window: m.contextWindow || 0 };
  }
  return null;
}
function renderUsageSummary() {
  const bar = $('#usageSummaryBar');
  if (!bar) return;
  const u = calcSessionUsage();
  const totalInput = u.input + u.cacheRead;
  const hitRate = totalInput > 0 ? (u.cacheRead / totalInput * 100) : 0;
  bar.classList.remove('hidden');
  if (totalInput + u.output + u.reasoning <= 0) {
    const t = el('span', 'usage-summary-item');
    t.innerHTML = '<b>📊 本对话 Token</b> 暂无用量（发消息后显示）';
    bar.innerHTML = '';
    bar.appendChild(t);
    return;
  }
  const p = (label, val, cls) => {
    const s = el('span', 'usage-summary-item' + (cls ? ' ' + cls : ''));
    s.innerHTML = '<b>' + label + '</b> ' + Number(val).toLocaleString();
    return s;
  };
  bar.innerHTML = '';
  const t = el('span', 'usage-summary-item');
  t.innerHTML = '<b>📊 本对话 Token</b>';
  bar.appendChild(t);
  const cu = latestContextUsed();
  if (cu) {
    // 模型未上报窗口时按 1M（与每条回复 usage-box 的默认口径一致）估算
    const win = cu.window > 0 ? cu.window : 1048576;
    const ctxPct = Math.min(99.99, cu.used / win * 100);
    const c = el('span', 'usage-summary-item sum-ctx');
    c.innerHTML = '<b>🧭 上下文已使用占比</b> ' + ctxPct.toFixed(2) + '%';
    c.title = '最近一轮输入 ' + cu.used.toLocaleString() + ' tokens ÷ 上下文窗口 ' + (win / 1024).toFixed(0) + 'K tokens' + (cu.window > 0 ? '' : '（模型未上报窗口，按默认估算）');
    bar.appendChild(c);
  }
  bar.appendChild(p('输入', u.input));
  const hit = el('span', 'usage-summary-item sum-hit');
  hit.innerHTML = '<b>🎯 缓存命中</b> ' + hitRate.toFixed(1) + '%';
  bar.appendChild(hit);
  bar.appendChild(p('输出', u.output));
  if (u.cacheWrite) bar.appendChild(p('缓存写', u.cacheWrite));
  if (u.reasoning) bar.appendChild(p('推理', u.reasoning));
}

/* 隐藏回复末尾的记忆归档内容：剥离 <!-- MEMORY: ... --> 块及常见记忆尾巴 */
function cleanMemoryText(text) {
  if (!text) return text;
  let t = String(text);
  const N = "\x0a";
  // 1. HTML 注释形式的 MEMORY 块
  t = t.replace(/<!--\s*MEMORY:\s*([\s\S]*?)-->/gi, '');
  // 2. 记忆归档段（## 标题 + 内容），只在回复末尾出现时剥离
  t = t.replace(new RegExp(N + '?---+' + '\\s*' + N + '?##+' + '\\s*(长程记忆|记忆归档|记忆更新|新增记忆)[\\s\\S]*?$', 'g'), '');
  t = t.replace(new RegExp(N + '?##+' + '\\s*(长程记忆|记忆归档|记忆更新|新增记忆)[\\s\\S]*?$', 'g'), '');
  // 3. 清理尾部多余空白/分隔线
  t = t.replace(new RegExp(N + '{3,}', 'g'), N + N).replace(/\s+$/, '');
  return t;
}

function renderUsageBox(m) {
  const u = m.usageTotal || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const box = el('div', 'usage-box');
  const totalInput = u.input + u.cacheRead;
  const hitRate = totalInput > 0 ? (u.cacheRead / totalInput * 100) : 0;
  const ctx = m.contextWindow || 1048576;
  const ctxPct = Math.min(99.99, totalInput / ctx * 100);
  const p = (label, val, cls) => {
    const s = el('span', 'usage-item' + (cls ? ' ' + cls : ''));
    s.innerHTML = '<b>' + label + '</b> ' + Number(val).toLocaleString();
    return s;
  };
  box.appendChild(p('输入', u.input));
  box.appendChild(p('缓存读', u.cacheRead));
  const hit = el('span', 'usage-item usage-hit');
  hit.innerHTML = '<b>🎯 缓存命中</b> ' + hitRate.toFixed(1) + '%';
  box.appendChild(hit);
  box.appendChild(p('输出', u.output));
  if (u.cacheWrite) box.appendChild(p('缓存写', u.cacheWrite));
  if (u.reasoning) box.appendChild(p('推理', u.reasoning));
  const ctxItem = el('span', 'usage-item usage-ctx');
  ctxItem.innerHTML = '<b>上下文</b> ' + ctxPct.toFixed(2) + '%';
  box.appendChild(ctxItem);
  box.title = '上下文窗口约 ' + (ctx / 1024).toFixed(0) + 'K tokens；缓存命中率 = 缓存读取 / (输入 + 缓存读取)；缓存写 = 本轮写入缓存量';
  return box;
}

function calcSessionUsage() {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const m of state.messages || []) {
    const u = m.usageTotal;
    if (!u) continue;
    t.input += u.input || 0;
    t.output += u.output || 0;
    t.cacheRead += u.cacheRead || 0;
    t.cacheWrite += u.cacheWrite || 0;
    t.reasoning += u.reasoning || 0;
  }
  return t;
}

function renderMessage(idx, m) {
  const wrap = el('div', 'msg ' + (m.role === 'user' ? 'user' : 'assistant'));
  wrap.dataset.idx = String(idx);
  const avatar = el('div', 'avatar');
  avatar.textContent = m.role === 'user' ? '🧑' : '🎓';
  const bubble = el('div', 'bubble' + (m.error ? ' error' : ''));
  const meta = el('div', 'msg-meta');
  const who = el('span', null, m.role === 'user' ? '你 · ' + fmtTime(m.time) : '逻敏 · ' + fmtTime(m.time));
  meta.appendChild(who);

  if (m.role === 'assistant') {
    const actions = el('div', 'msg-actions');
    const copy = el('button', null, '复制');
    copy.onclick = () => copyText(m.text || m.error || '');
    const exportOne = el('button', null, 'Word');
    exportOne.onclick = () => exportWord(m);
    const exportPdfBtn = el('button', null, 'PDF');
    exportPdfBtn.onclick = () => exportPdf(m);
    if (!(window.academyElectron && window.academyElectron.exportPdf)) exportPdfBtn.classList.add('hidden');
    const exportMd = el('button', null, '导出');
    exportMd.onclick = () => exportMarkdown(m);
    actions.appendChild(copy);
    actions.appendChild(exportOne);
    actions.appendChild(exportPdfBtn);
    actions.appendChild(exportMd);
    meta.appendChild(actions);
  }
  bubble.appendChild(meta);

  // 用户消息里附带的文件
  if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
    const attBox = el('div', 'msg-attachments', '');
    for (const a of m.attachments) {
      attBox.appendChild(el('span', 'msg-attach', fileIcon(a.name) + ' ' + a.name));
    }
    bubble.appendChild(attBox);
  }

  // 本次召回的个人资料（用户自己的备赛资料）
  if (Array.isArray(m.library) && m.library.length) {
    const lb = el('div', 'lib-chips');
    lb.appendChild(el('span', 'lib-chips-label', '📚 本次召回你的资料'));
    for (const d of m.library) {
      const c = el('span', 'lib-chip', '《' + d.name + '》');
      c.title = '相关度 ' + d.score + ' · 全文 ' + Number(d.charCount || 0).toLocaleString() + ' 字';
      lb.appendChild(c);
    }
    bubble.appendChild(lb);
  }

  // 工具调用过程：运行中 + 完成后都保留
  if (Array.isArray(m.tools) && m.tools.length) {
    const toolsBox = el('div', 'tool-log');
    toolsBox.id = 'toolsBox' + idx;
    toolsBox.innerHTML = m.tools.map((t) => (
      '<div class="tool-item ' + (t.done ? 'done' : 'active') + '">' +
      (t.done ? '✅' : '🔧') + ' <b>' + esc(t.name) + '</b>' +
      (t.detail ? '<span class="tool-detail">' + esc(t.detail) + '</span>' : '') +
      '</div>'
    )).join('');
    bubble.appendChild(toolsBox);
  }

  // 思考过程：运行中 + 完成后都保留（运行中默认展开，完成后默认收起）
  if (m.reasoning) {
    const details = document.createElement('details');
    details.className = 'think-box';
    details.id = 'thinkBox' + idx;
    details.open = !!m.running;
    const summary = document.createElement('summary');
    summary.textContent = '💭 思考过程' + (m.running ? '' : '（已完成）');
    details.appendChild(summary);
    const body = el('div', 'md think-md');
    body.id = 'thinkMd' + idx;
    body.innerHTML = mdToHtml(m.reasoning);
    details.appendChild(body);
    bubble.appendChild(details);
  }

  // Token 用量：缓存命中率 / 上下文窗口占比 / 输入输出 / 推理
  if (m.usageTotal) {
    const ub = renderUsageBox(m);
    ub.id = 'usageBox' + idx;
    bubble.appendChild(ub);
  }

  if (m.running) {
    if (!m.streamText) {
      bubble.appendChild(typingIndicator());
    } else {
      const streamMd = el('div', 'md stream-md');
      streamMd.id = 'streamMd' + idx;
      streamMd.innerHTML = mdToHtml(m.streamText);
      bubble.appendChild(streamMd);
    }
    const status = el('div', 'run-status');
    status.id = 'runStatus' + idx;
    status.innerHTML = '<span class="run-elapsed">正在准备…</span>';
    bubble.appendChild(status);
  } else if (m.error) {
    const p = el('div', 'md');
    p.innerHTML = '<p>⚠️ ' + esc(m.error) + '</p>';
    bubble.appendChild(p);
  } else if (m.role === 'assistant') {
    const md = el('div', 'md');
    md.innerHTML = mdToHtml(m.text || '');
    bubble.appendChild(md);
  } else {
    bubble.textContent = m.text;
  }
  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  return wrap;
}

function typingIndicator() {
  const span = el('span', 'typing');
  span.innerHTML = '<i></i><i></i><i></i>';
  const wrap = el('div');
  wrap.appendChild(span);
  wrap.appendChild(document.createTextNode(' Agent 正在阅读知识库并写作…'));
  return wrap;
}

function scrollBottom() {
  const box = $('#messages');
  requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
}

/* ── 流式平滑显示（打字机）：DSH 是批量写入的，一次到一大块，
   这里把文本按帧匀速吐出，视觉上连续；缓冲区大时自动加速追赶。 ── */
let _smBuf = '';          // 待显示文本
let _smShown = '';        // 已显示文本
let _smIdx = -1;
let _smTicking = false;
let _smLastCost = 0;      // 上次 mdToHtml 耗时，用于自适应降频
let _smSkipUntil = 0;

function pushStreamText(idx, fullText) {
  _smIdx = idx;
  const t = String(fullText || '');
  // 增量入缓冲（处理回退/重置场景）
  if (!t.startsWith(_smShown)) { _smShown = ''; _smBuf = t; }
  else { _smBuf = t.slice(_smShown.length); }
  if (!_smTicking) { _smTicking = true; requestAnimationFrame(smoothTick); }
}

function smoothTick() {
  if (_smBuf.length) {
    // 速度：缓冲区越大吐得越快，约 12 帧内追上（≈200ms 延迟上限）
    const take = Math.max(1, Math.ceil(_smBuf.length / 12));
    _smShown += _smBuf.slice(0, take);
    _smBuf = _smBuf.slice(take);
    renderStreamNow();
  }
  if (_smBuf.length) {
    if (performance.now() < _smSkipUntil) {
      // 渲染过慢时降频，避免拖慢整体
      setTimeout(() => { if (_smTicking) requestAnimationFrame(smoothTick); }, 50);
    } else {
      requestAnimationFrame(smoothTick);
    }
  } else {
    _smTicking = false;
  }
}

function renderStreamNow() {
  const md = document.getElementById('streamMd' + _smIdx);
  if (!md) return;
  const t0 = performance.now();
  md.innerHTML = mdToHtml(_smShown);
  _smLastCost = performance.now() - t0;
  if (_smLastCost > 45) _smSkipUntil = performance.now() + 250;
}

/* 完成时立即显示完整文本（不等平滑） */
function flushStreamFinal(idx, fullText) {
  _smShown = String(fullText || '');
  _smBuf = '';
  _smIdx = idx;
  renderStreamNow();
}

/* 重置平滑状态（切换对话 / 新建 / 完成时调用） */
function resetSmoothStream() {
  _smBuf = '';
  _smShown = '';
  _smIdx = -1;
  _smTicking = false;
  _smSkipUntil = 0;
}

/* 思考过程：直接节流渲染（不需要打字机，通常默认折叠） */
let _thinkRaf = 0, _thinkPending = null;
function scheduleThinkRender(idx, text) {
  _thinkPending = { idx, text };
  if (_thinkRaf) return;
  _thinkRaf = requestAnimationFrame(() => {
    _thinkRaf = 0;
    const p = _thinkPending; _thinkPending = null;
    if (!p) return;
    const th = document.getElementById('thinkMd' + p.idx);
    if (th) th.innerHTML = mdToHtml(p.text || '');
  });
}

function updateRunningMessage(patch) {
  const idx = state.messages.findIndex((m) => m.running);
  if (idx < 0) return;
  Object.assign(state.messages[idx], patch);
  const wrap = document.querySelector(`.msg[data-idx="${idx}"]`);
  if (!wrap) { renderMessages(); return; }
  if (patch.text !== undefined || patch.error !== undefined || patch.running === false) {
    renderMessages();
  } else {
    if (patch.statusText !== undefined) {
      const st = document.getElementById('runStatus' + idx);
      if (st && st.textContent !== patch.statusText) st.textContent = patch.statusText;
    }
    if (patch.streamText !== undefined) {
      let md = document.getElementById('streamMd' + idx);
      if (!md) {
        const typing = wrap.querySelector('.typing');
        if (typing && typing.parentElement) typing.parentElement.remove();
        md = el('div', 'md stream-md');
        md.id = 'streamMd' + idx;
        const bubble = wrap.querySelector('.bubble');
        if (bubble) {
          const status = document.getElementById('runStatus' + idx);
          bubble.insertBefore(md, status || null);
        }
      }
      if (md) pushStreamText(idx, state.messages[idx].streamText || '');
    }
    if (patch.tools !== undefined) {
      let box = document.getElementById('toolsBox' + idx);
      const bubble = wrap.querySelector('.bubble');
      if (!box && bubble) {
        box = el('div', 'tool-log');
        box.id = 'toolsBox' + idx;
        const status = document.getElementById('runStatus' + idx);
        const think = document.getElementById('thinkBox' + idx);
        bubble.insertBefore(box, think || status || null);
      }
      if (box) {
        const tools = patch.tools || [];
        box.innerHTML = tools.map((t) => (
          '<div class="tool-item ' + (t.done ? 'done' : 'active') + '">' +
          (t.done ? '✅' : '🔧') + ' <b>' + esc(t.name) + '</b>' +
          (t.detail ? '<span class="tool-detail">' + esc(t.detail) + '</span>' : '') +
          '</div>'
        )).join('');
      }
    }
    if (patch.reasoning !== undefined) {
      let details = document.getElementById('thinkBox' + idx);
      const bubble = wrap.querySelector('.bubble');
      if (!details && bubble) {
        details = document.createElement('details');
        details.className = 'think-box';
        details.id = 'thinkBox' + idx;
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = '💭 思考过程';
        details.appendChild(summary);
        const body = el('div', 'md think-md');
        body.id = 'thinkMd' + idx;
        details.appendChild(body);
        const status = document.getElementById('runStatus' + idx);
        bubble.insertBefore(details, status || null);
      }
      if (details) {
        const body = document.getElementById('thinkMd' + idx);
        if (body) scheduleThinkRender(idx, state.messages[idx].reasoning || '');
      }
    }
    if (patch.usageTotal !== undefined || patch.contextWindow !== undefined) {
      const m = state.messages[idx];
      const bubble = wrap.querySelector('.bubble');
      let ub = document.getElementById('usageBox' + idx);
      if (!ub && bubble && m && m.usageTotal) {
        ub = renderUsageBox(m);
        ub.id = 'usageBox' + idx;
        const status = document.getElementById('runStatus' + idx);
        const think = document.getElementById('thinkBox' + idx);
        bubble.insertBefore(ub, status || think || null);
      } else if (ub && m && m.usageTotal) {
        const fresh = renderUsageBox(m);
        fresh.id = 'usageBox' + idx;
        ub.replaceWith(fresh);
      }
    }
  }
  scrollBottom();
}

function copyText(text) {
  const done = () => toast('已复制到剪贴板');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done));
  } else legacyCopy(text, done);
}
function legacyCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (_) { toast('复制失败，请手动选择复制'); }
  ta.remove();
}

/* ================= Markdown 阅读器 ================= */
let mdReaderState = { path: '', name: '', text: '', crlf: false, dirty: false, editing: false };

/* 从拖入的 File 对象直接读取（Electron 32 已移除 File.path，不依赖本地路径） */
async function openMdReaderFromFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('文件过大（超过 8MB），请先拆分或改用「打开文件」选择'); return; }
  $('#mdModal').classList.remove('hidden');
  $('#mdReaderContent').innerHTML = '<p class="md-reader-empty">正在读取文件…</p>';
  try {
    const text = await file.text();
    // 拖入的文件拿不到真实路径，只能看不能存；编辑按钮会被禁用
    mdReaderState = { path: '', name: file.name || '', text: text || '', crlf: /\r\n/.test(text || ''), dirty: false, editing: false };
    $('#mdReaderTitle').textContent = '📖 ' + (file.name || 'Markdown');
    $('#mdReaderPath').textContent = (file.name || '') + '（拖入）';
    renderMdReader();
  } catch (e) {
    $('#mdReaderContent').innerHTML = '<p class="md-reader-empty">读取失败：' + esc(e.message) + '</p>';
  }
}

async function openMdReader(filePathHint) {
  $('#mdModal').classList.remove('hidden');
  $('#mdReaderContent').innerHTML = '<p class="md-reader-empty">正在读取文件…</p>';
  try {
    const ae = window.academyElectron;
    if (!ae || !ae.openMarkdownFile) { $('#mdReaderContent').innerHTML = '<p class="md-reader-empty">当前运行环境不支持本地文件读取，请使用带 Electron 的桌面版。</p>'; return; }
    let result;
    if (filePathHint) {
      result = await ae.readMarkdownFile(filePathHint);
      if (result && !result.ok) throw new Error(result.error || '读取失败');
    } else {
      result = await ae.openMarkdownFile();
      if (result && result.canceled) { closeMdReader(); return; }
      if (result && result.error) throw new Error(result.error);
    }
    if (!result || result.text === undefined) { closeMdReader(); return; }
    mdReaderState = { path: result.path || '', name: result.name || '', text: result.text || '', crlf: !!result.crlf, dirty: false, editing: false };
    $('#mdReaderTitle').textContent = '📖 ' + (mdReaderState.name || 'Markdown');
    $('#mdReaderPath').textContent = mdReaderState.path || '';
    renderMdReader();
  } catch (e) {
    $('#mdReaderContent').innerHTML = '<p class="md-reader-empty">读取失败：' + esc(e.message) + '</p>';
  }
}

function renderMdReader() {
  const box = $('#mdReaderContent');
  const editable = !!mdReaderState.path;   // 拖入的文件没有路径，存不了
  // 编辑按钮可用性 + 保存按钮显隐
  const bEdit = $('#btnMdEdit');
  if (bEdit) {
    bEdit.disabled = !editable;
    bEdit.title = editable ? '编辑这个文件（Ctrl+E）' : '拖入的文件没有真实路径，无法保存；请用「打开文件」打开后再编辑';
    bEdit.textContent = mdReaderState.editing ? '👁 预览' : '✏️ 编辑';
  }
  const bSave = $('#btnMdSave');
  if (bSave) {
    bSave.classList.toggle('hidden', !mdReaderState.editing);
    bSave.classList.toggle('dirty', !!mdReaderState.dirty);
    bSave.textContent = mdReaderState.dirty ? '💾 保存 •' : '💾 保存';
  }
  const wrap = $('#mdReaderEditorWrap');
  if (wrap) wrap.classList.toggle('hidden', !mdReaderState.editing);
  box.classList.toggle('hidden', !!mdReaderState.editing);

  if (mdReaderState.editing) {
    const ta = $('#mdReaderEditor');
    if (ta && ta.value !== mdReaderState.text) ta.value = mdReaderState.text;
    if (ta) setTimeout(() => { try { ta.focus(); } catch (_) {} }, 0);
    return;
  }
  if (!mdReaderState.text) { box.innerHTML = '<p class="md-reader-empty">（空文件）</p>'; return; }
  box.innerHTML = mdToHtml(mdReaderState.text);
}
function mdReaderEnterEdit() {
  if (!mdReaderState.path) { toast('拖入的文件没有真实路径，无法保存；请用「打开文件」打开'); return; }
  mdReaderState.editing = true;
  renderMdReader();
}
function mdReaderExitEdit() {
  // 退出编辑不丢内容：把编辑框内容同步回内存（仍算未保存）
  const ta = $('#mdReaderEditor');
  if (ta) mdReaderState.text = ta.value;
  mdReaderState.editing = false;
  renderMdReader();
}
function mdReaderSetDirty(v) {
  if (mdReaderState.dirty === v) return;
  mdReaderState.dirty = v;
  const bSave = $('#btnMdSave');
  if (bSave) {
    bSave.classList.toggle('dirty', v);
    bSave.textContent = v ? '💾 保存 •' : '💾 保存';
  }
}
async function mdReaderSave(opts) {
  opts = opts || {};
  if (!mdReaderState.path) { toast('没有可保存的文件'); return false; }
  const ta = $('#mdReaderEditor');
  const text = mdReaderState.editing && ta ? ta.value : mdReaderState.text;
  const ae = window.academyElectron;
  if (!ae || !ae.saveMarkdownFile) { toast('当前环境不支持保存'); return false; }
  try {
    const r = await ae.saveMarkdownFile({ path: mdReaderState.path, text, crlf: mdReaderState.crlf, force: !!opts.force });
    if (r && r.ok) {
      mdReaderState.text = text;
      mdReaderSetDirty(false);
      renderMdReader();
      toast('已保存到 ' + (mdReaderState.name || '文件'));
      return true;
    }
    if (r && r.conflict) {
      const ok = confirm('这个文件在你编辑期间被其他程序修改过。\n\n覆盖它的修改（保留你现在的版本）？\n\n选「取消」则放弃这次保存，你的编辑仍留在窗口里。');
      if (ok) return mdReaderSave({ force: true });
      toast('已取消保存（外部修改未被覆盖）');
      return false;
    }
    toast('保存失败：' + ((r && r.error) || '未知错误'));
    return false;
  } catch (e) { toast('保存失败：' + (e.message || e)); return false; }
}
function closeMdReader() {
  if (mdReaderState.dirty) {
    if (!confirm('「' + (mdReaderState.name || '这个文件') + '」还有未保存的修改，确定关闭吗？')) return;
  }
  $('#mdModal').classList.add('hidden');
  mdReaderState = { path: '', name: '', text: '', crlf: false, dirty: false, editing: false };
}

function bindMdReader() {
  const ae = window.academyElectron;
  $('#btnMdOpen').onclick = () => openMdReader();
  $('#btnMdEdit').onclick = () => { mdReaderState.editing ? mdReaderExitEdit() : mdReaderEnterEdit(); };
  $('#btnMdSave').onclick = () => { mdReaderSave(); };
  // 编辑器输入 → 脏标记
  const ta = $('#mdReaderEditor');
  if (ta) {
    ta.addEventListener('input', () => { mdReaderSetDirty(ta.value !== mdReaderState.text); });
    // Tab 插入两个空格而不是跳出焦点
    ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 2;
      mdReaderSetDirty(ta.value !== mdReaderState.text);
    });
  }
  // 预览区双击进入编辑
  const content = $('#mdReaderContent');
  if (content) content.addEventListener('dblclick', () => { if (mdReaderState.path && !mdReaderState.editing) mdReaderEnterEdit(); });
  $('#btnMdCopy').onclick = () => {
    const t = mdReaderState.editing && ta ? ta.value : mdReaderState.text;
    if (t) copyText(t); else toast('还没有内容');
  };
  $('#btnMdExport').onclick = async () => {
    const t = mdReaderState.editing && ta ? ta.value : mdReaderState.text;
    if (!t) { toast('还没有内容'); return; }
    try { await exportWord({ text: t, title: mdReaderState.name || 'Markdown' }); }
    catch (_) { toast('导出失败'); }
  };
  // 快捷键：仅在阅读器弹窗打开时生效
  document.addEventListener('keydown', (e) => {
    const modal = $('#mdModal');
    if (!modal || modal.classList.contains('hidden')) return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (mdReaderState.path && mdReaderState.editing) mdReaderSave(); return; }
    if (meta && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault();
      if (!mdReaderState.path) return;
      mdReaderState.editing ? mdReaderExitEdit() : mdReaderEnterEdit();
      return;
    }
    if (e.key === 'Escape' && mdReaderState.editing) { e.preventDefault(); mdReaderExitEdit(); }
  });
  // 文件关联双击 / second-instance 转发
  if (ae && ae.onOpenFileRequest) {
    ae.onOpenFileRequest(async (filePath) => {
      try { await openMdReader(filePath); } catch (_) {}
    });
  }
}

/* 拖入 .md 等文档 → 打开阅读器（而非插入输入框） */
function mdFileFromDrop(file) {
  if (!file || !file.name) return null;
  return /.(md|markdown|txt|srt)$/i.test(file.name) ? file : null;
}

/* ================= 模式与界面 ================= */
const modeMeta = MODES;

function updateModeUI() {
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
  });
  $('#modeTitle').textContent = modeMeta[state.mode].title;
  $('#modeDesc').textContent = modeMeta[state.mode].desc;
  $('#input').placeholder = modeMeta[state.mode].title + ' · 输入后 Ctrl+Enter 发送';
  const hs = document.querySelector('.side-head h3');
  if (hs) hs.textContent = '🕘 对话历史 · ' + modeMeta[state.mode].title;
}

/* ================= 拖拽 / 粘贴文件上传 ================= */
function bindDragDrop() {
  const overlay = $('#dropOverlay');
  let dragDepth = 0;
  const inFileDrag = (e) => (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  window.addEventListener('dragenter', (e) => {
    if (!inFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    if (overlay) overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!inFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!inFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    if (overlay) overlay.classList.add('hidden');
    if (!inFileDrag(e)) return;
    e.preventDefault();
    const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
    if (files.length) {
      // 资料库弹窗打开时：拖入的文件直接进资料库，而不是当作聊天附件
      const libOpen = $('#libraryModal') && !$('#libraryModal').classList.contains('hidden');
      if (libOpen) { libUploadFiles(files); return; }
      if (files.length > 5) { toast('一次最多拖 5 个文件'); return; }
      // .md 等文档 → 打开阅读器；其余 → 插入输入框
      // 只有在「MD 阅读器」打开时，拖入 .md 才是"打开阅读"；
      // 否则一律作为附件（和主流 AI 一致），保证能正常发送。
      const mdReaderOpen = !$('#mdModal').classList.contains('hidden');
      const docs = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
      if (mdReaderOpen && docs.length === files.length && docs.length === 1) {
        openMdReaderFromFile(docs[0]);
        return;
      }
      files.forEach((file, i) => setTimeout(() => attachFile(file), i * 50));
    }
  });
  // 防止浏览器把文件打开成新页面（兜底）
  window.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  // 输入框粘贴文件（截图 / 复制文件）
  const input = $('#input');
  if (input) {
    input.addEventListener('paste', (e) => {
      const files = e.clipboardData && Array.from(e.clipboardData.files || []);
      if (files && files.length) {
        e.preventDefault();
        if (files.length > 5) { toast('一次最多粘贴 5 个文件'); return; }
        files.forEach((file, i) => setTimeout(() => attachFile(file), i * 50));
      }
    });
  }
}

function renderHistory() {
  // 搜索态下，历史区显示搜索结果（由搜索模块维护）
  if (typeof historyQuery === 'string' && historyQuery.trim()) {
    try { renderHistorySearch(); return; } catch (_) {}
  }
  const box = $('#historyList');
  box.innerHTML = '';
  // 严格隔离：只显示当前模式的对话，别的模式绝不出现
  const mine = state.chats.filter((c) => c.mode === state.mode);
  if (!mine.length) {
    box.appendChild(el('div', 'history-empty', '当前模式暂无历史（保存在本机浏览器）'));
    return;
  }
  for (const c of mine.slice(0, 20)) {
    const item = el('button', 'history-item' + (c.id === state.chatId ? ' active' : ''), '');
    const t = el('span', 'h-title', c.title || '未命名');
    item.appendChild(t);
    // 重命名按钮（单击标题会切换对话，双击不可靠，改用显式按钮）
    const edit = el('span', 'history-edit', '✎');
    edit.title = '重命名';
    edit.onclick = (e) => { e.stopPropagation(); e.preventDefault(); startRenameChat(c.id, t); };
    item.appendChild(edit);
    const del = el('span', 'history-del', '×');
    del.title = '删除';
    del.onclick = (e) => {
      e.stopPropagation();
      state.chats = state.chats.filter((x) => x.id !== c.id);
      if (state.chatId === c.id) newChat(state.mode);
      if (state.chatIdByMode[state.mode] === c.id) state.chatIdByMode[state.mode] = null;
      saveChats();
      renderHistory();
    };
    item.appendChild(del);
    item.onclick = () => switchChat(c.id);
    box.appendChild(item);
  }
}

/* 首轮对话完成后自动生成标题（用户手动改过则不覆盖） */
let _titleGenerating = {};
async function maybeAutoTitle() {
  let chat = null;
  try {
    chat = currentChat();
    if (!chat) return;
    if (chat.titleLocked) return;                       // 用户手动改过
    if (_titleGenerating[chat.id]) return;              // 正在生成
    const users = (chat.messages || []).filter((m) => m.role === 'user');
    if (users.length !== 1) return;                     // 只在首轮生成
    const firstUser = users[0];
    const firstAssistant = (chat.messages || []).find((m) => m.role === 'assistant' && m.text);
    if (!firstUser || !firstAssistant) return;
    _titleGenerating[chat.id] = true;
    const r = await fetchJSON('/api/generate-title', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userText: firstUser.text || '', assistantText: firstAssistant.text || '' }),
    });
    if (r && r.ok && r.title) {
      // 二次确认：期间用户可能已手动改名
      const c2 = state.chats.find((x) => x.id === chat.id);
      if (c2 && !c2.titleLocked) {
        c2.title = r.title;
        saveChats();
        renderHistory();
      }
    }
  } catch (_) {} finally {
    delete _titleGenerating[chat && chat.id];
  }
}

/* 重命名对话（双击标题进入内联编辑） */
function startRenameChat(chatId, titleEl) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat || !titleEl || !titleEl.parentElement) return;
  if (document.querySelector('#historyList .h-title-input')) return; // 已有编辑框
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'h-title-input';
  input.value = chat.title || '';
  input.maxLength = 60;
  const parent = titleEl.parentElement;
  parent.replaceChild(input, titleEl);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v) {
      chat.title = v.slice(0, 60);
      chat.titleLocked = true; // 手动改过 → 不再自动生成
      saveChats();
    }
    renderHistory();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.onclick = (e) => e.stopPropagation();
}

/* ================= 对话全文搜索（跨所有模式） ================= */
let historyQuery = '';

function searchChats(q) {
  const kw = String(q || '').trim().toLowerCase();
  if (!kw) return [];
  const hits = [];
  for (const c of state.chats || []) {
    const msgs = c.messages || [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const text = String(m.text || '');
      if (!text) continue;
      const pos = text.toLowerCase().indexOf(kw);
      if (pos < 0) continue;
      hits.push({
        chatId: c.id,
        mode: c.mode || 'free',
        title: c.title || '未命名',
        msgIdx: i,
        role: m.role,
        time: m.time || c.updated || c.created,
        text,
        pos,
      });
    }
  }
  hits.sort((a, b) => (b.time || 0) - (a.time || 0));
  return hits.slice(0, 60);
}

function snippetAround(text, pos, kwLen) {
  const pad = 40;
  const start = Math.max(0, pos - pad);
  const end = Math.min(text.length, pos + kwLen + pad);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

function highlightSnippet(text, kw) {
  if (!kw) return esc(text);
  const lower = text.toLowerCase();
  const k = kw.toLowerCase();
  let out = '', i = 0;
  while (true) {
    const p = lower.indexOf(k, i);
    if (p < 0) { out += esc(text.slice(i)); break; }
    out += esc(text.slice(i, p)) + '<mark>' + esc(text.slice(p, p + k.length)) + '</mark>';
    i = p + k.length;
  }
  return out;
}

function renderHistorySearch() {
  const box = $('#historyList');
  const kw = historyQuery.trim();
  box.innerHTML = '';
  if (!kw) { renderHistory(); return; }
  const hits = searchChats(kw);
  const head = el('div', 'search-hits-head', hits.length ? ('找到 ' + hits.length + ' 条匹配（全部模式）') : '没有匹配的内容');
  box.appendChild(head);
  for (const h of hits) {
    const item = el('button', 'search-hit', '');
    const top = el('div', 'search-hit-top', '');
    top.appendChild(el('span', 'search-hit-title', h.title));
    top.appendChild(el('span', 'search-hit-mode', (MODES[h.mode] || {}).title || h.mode));
    item.appendChild(top);
    const snip = el('div', 'search-hit-snippet', '');
    snip.innerHTML = highlightSnippet(snippetAround(h.text, h.pos, kw.length), kw);
    item.appendChild(snip);
    item.onclick = () => openSearchHit(h);
    box.appendChild(item);
  }
}

function openSearchHit(h) {
  const chat = state.chats.find((c) => c.id === h.chatId);
  if (!chat) return;
  // 跨模式：先切到该对话所属模式，再打开对话
  if (chat.mode !== state.mode) switchMode(chat.mode);
  switchChat(chat.id);
  // 滚动并高亮目标消息
  setTimeout(() => {
    const node = document.querySelector('#messages .msg[data-idx="' + h.msgIdx + '"]');
    if (node) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node.classList.add('msg-flash');
      setTimeout(() => node.classList.remove('msg-flash'), 1500);
    }
  }, 260);
}

function bindHistorySearch() {
  const input = $('#historySearchInput');
  const clearBtn = $('#btnHistorySearchClear');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      historyQuery = input.value;
      if (clearBtn) clearBtn.classList.toggle('hidden', !historyQuery.trim());
      renderHistorySearch();
    }, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; historyQuery = ''; if (clearBtn) clearBtn.classList.add('hidden'); renderHistory(); }
  });
  if (clearBtn) clearBtn.onclick = () => {
    input.value = ''; historyQuery = '';
    clearBtn.classList.add('hidden');
    renderHistory();
    input.focus();
  };
}

/* 切换模式：各模式对话彼此独立，绝不把当前对话带到别的模式 */
function switchMode(mode) {
  if (!mode || mode === state.mode) { updateModeUI(); focusInput(); return; }
  const prev = state.mode;
  // 1. 记住当前模式正在看的对话
  if (state.chatId) {
    state.chatIdByMode[prev] = state.chatId;
    persistChat(); // 先落盘当前模式的对话
  }
  // 2. 切到新模式
  state.mode = mode;
  try { localStorage.setItem(MODE_LS_KEY, mode); } catch (_) {}
  const target = state.chatIdByMode[mode];
  if (target && state.chats.some((c) => c.id === target && c.mode === mode)) {
    switchChat(target);
  } else {
    state.chatId = null;
    state.messages = [];
  }
  updateModeUI();
  $('#input').value = ''; // 切换模式不残留任何自动填充
  updateCharCount();
  renderMessages();
  renderHistory();
  focusInput();
}

function focusInput() { $('#input').focus(); }

/* ================= 状态 / 配置 ================= */
async function refreshStatus() {
  try {
    const s = await fetchJSON('/api/status');
    state.status = s;
    renderStatus();
    if (!s.hasKey) {
      $('#keyBanner').classList.remove('hidden');
      $('#welcomeNote').classList.remove('hidden');
    } else {
      $('#keyBanner').classList.add('hidden');
      $('#welcomeNote').classList.add('hidden');
    }
  } catch (e) {
    $('#statusPill').className = 'status-pill err';
    $('#statusPill').textContent = '服务异常';
    $('#engineInfo').textContent = '无法连接本地服务';
  }
}

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const pill = $('#statusPill');
  if (s.busy) {
    pill.className = 'status-pill busy';
    pill.textContent = '⚙️ Agent 运行中…';
  } else if (!s.hasKey) {
    pill.className = 'status-pill err';
    pill.textContent = '未配置 API Key';
  } else if (s.dsh && s.node) {
    pill.className = 'status-pill ok';
    pill.textContent = '✅ 引擎就绪 · ' + (s.model || '');
  } else {
    pill.className = 'status-pill err';
    pill.textContent = '⚠️ 引擎缺失';
  }
  const providerLabel = s.searchMode === 'free' ? '免费端侧' : '服务侧';
  // 本对话 Token 明细已常驻在输入框下方的统计栏里，这里不再重复拼接
  const memoryText = (s.memorySize > 0) ? (' · 🧠 记忆 ' + s.memorySize.toLocaleString() + ' B') : '';
  $('#engineInfo').textContent = 'DSH 内核: ' + (s.dsh ? '✅' : '❌') + ' · 内置 Node: ' + (s.node ? '✅' : '❌') + ' · API: ' + (s.baseUrl || '').replace(/^https?:\/\//, '') + ' · 搜索: ' + providerLabel + '✅' + memoryText;
}

function openSettings() {
  const s = state.status;
  if (s) {
    syncSearchModeChoices(s);
    renderSettingsBadge(s);
    $('#settingsResult').textContent = '';
    $('#settingsResult').className = 'settings-result';
  }
  $('#settingsModal').classList.remove('hidden');
  $('#modelSelect').classList.add('hidden');
  // 打开设置默认落到「AI 模型」面板；若用户点了别的分组（如通用），保留其选择
  try {
    const activeNav = document.querySelector('.settings-nav-item.active');
    if (!activeNav) switchSettingsPane('model');
  } catch (_) {}
  // 载入/刷新多配置档案（编辑当前生效的配置）
  loadProfilesUI();
  try { loadExtToolsToggle(); } catch (_) {}
  setTimeout(() => { const i = $('#apiKeyInput'); if (i) i.focus(); }, 50);
}

/* 二级导航：切换到指定分组面板（model/general/search/advanced） */
function switchSettingsPane(pane) {
  document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.settingsPane === pane));
  document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.settingsPane === pane));
  if (pane === 'stats') { try { renderStatsPane(); } catch (_) {} }
  if (pane === 'skills') { try { loadSkillsUI(); } catch (_) {} }
  if (pane === 'about') { try { renderAboutPane(); } catch (_) {} }
}


/* ———— 关于应用 ———— */
const ABOUT_LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh';
function renderAboutPane() {
  const ver = (state.status && state.status.version) || '2.0.0';
  const v = 'v' + String(ver).replace(/^v/i, '');
  const elVer = $('#aboutVersion');
  if (elVer) elVer.textContent = v;
  const elFoot = $('#aboutFootVer');
  if (elFoot) elFoot.textContent = 'Academy 辩论教练 ' + v;

  // 引擎信息：让用户能自查运行环境是否完整
  const s = state.status || {};
  const parts = [];
  if (s.engine) parts.push('内核 ' + s.engine);
  parts.push('Node ' + (s.node ? '就绪' : '缺失'));
  parts.push('DSH ' + (s.dsh ? '就绪' : '缺失'));
  const elEng = $('#aboutEngine');
  if (elEng) elEng.textContent = parts.join(' · ');
}
function copyAboutQQ() {
  const qq = ($('#aboutQQ') && $('#aboutQQ').textContent || '').trim();
  if (!qq) return;
  const done = () => toast('QQ 群号已复制：' + qq);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(qq).then(done).catch(() => fallbackCopyQQ(qq, done));
  } else {
    fallbackCopyQQ(qq, done);
  }
}
function fallbackCopyQQ(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    done();
  } catch (_) { toast('复制失败，请手动记录群号：' + text); }
}
function bindAboutPane() {
  const btnQQ = $('#aboutCopyQQ');
  if (btnQQ) btnQQ.onclick = copyAboutQQ;
  const openCC = $('#aboutOpenCC');
  if (openCC) openCC.onclick = () => { try { window.open(ABOUT_LICENSE_URL, '_blank'); } catch (_) {} };
  // 本机 LICENSE.md：优先让 Electron 用系统默认程序打开，浏览器模式则退回提示
  const openLic = $('#aboutOpenLicense');
  if (openLic) openLic.onclick = async () => {
    try {
      const r = await fetchJSON('/api/about/license');
      if (r && r.ok && r.path) {
        const ae = window.academyElectron;
        if (ae && ae.showInFolder) { ae.showInFolder(r.path); toast('已在文件夹中定位 LICENSE.md'); }
        else toast('许可文件位置：' + r.path);
      } else {
        toast('未找到 LICENSE.md');
      }
    } catch (e) { toast('打开失败：' + (e.message || '')); }
  };
}

/* ———— 服务商卡片管理（DSH 风格：选服务商即自动填地址） ———— */
function providerCards() {
  return Array.from(document.querySelectorAll('#providerGrid .provider-card'));
}
function providerNormalCards() {
  return providerCards().filter((c) => c.dataset.id !== 'custom');
}
function isCustomProvider(base) {
  return !providerNormalCards().some((c) => String(base).startsWith(c.dataset.baseurl || '___'));
}
function setActiveProviderCard(base) {
  const cards = providerCards();
  const normal = providerNormalCards();
  const hit = normal.find((c) => String(base).startsWith(c.dataset.baseurl || '___'));
  cards.forEach((c) => c.classList.remove('active'));
  if (hit) hit.classList.add('active');
  else {
    const custom = cards.find((c) => c.dataset.id === 'custom');
    if (custom) custom.classList.add('active');
    // 自定义服务商：当前编辑面板由卡片点击控制（跳到高级面板）
  }
}
function currentProviderBaseUrl() {
  const val = ($('#baseUrlInput').value || '').trim() || 'https://api.deepseek.com';
  return val;
}
function bindProviderCards() {
  providerCards().forEach((card) => {
    card.onclick = () => {
      if (card.dataset.id === 'custom') {
        // 进入自定义：保留当前地址便于编辑，并跳到「高级」面板填地址
        const cur = ($('#baseUrlInput').value || '').trim() || 'https://api.deepseek.com';
        $('#baseUrlInput').value = cur;
        setActiveProviderCard(cur);
        switchSettingsPane('advanced');
        setTimeout(() => { const i = $('#baseUrlInput'); if (i) i.focus(); }, 50);
      } else {
        const bu = card.dataset.baseurl;
        $('#baseUrlInput').value = bu;
        setActiveProviderCard(bu);
      }
    };
  });
}
/* 搜索方式：服务侧 / 端侧（高亮当前档位） */
function syncSearchModeChoices(s) {
  const mode = (s && s.searchMode) || '';
  document.querySelectorAll('#searchModeChoices .gen-choice').forEach((b) => {
    b.classList.toggle('active', b.dataset.searchMode === mode);
  });
}
async function setSearchMode(mode) {
  if (!['server', 'free'].includes(mode)) return;
  try {
    const r = await fetchJSON('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchProvider: mode, model: currentModelValue(), baseUrl: currentBaseUrlValue() }),
    });
    if (!r.ok) throw new Error(r.error || '保存失败');
    syncSearchModeChoices({ searchMode: r.searchMode });
    const outEl = $('#searchResultMsg');
    if (outEl) {
      outEl.textContent = mode === 'server' ? '✅ 已切换为服务侧搜索（用当前模型 Key）' : '✅ 已切换为端侧搜索（免费）';
      outEl.className = 'settings-result ok';
      setTimeout(() => { if (outEl) outEl.textContent = ''; }, 2600);
    }
    await refreshStatus();
  } catch (e) {
    const outEl = $('#searchResultMsg');
    if (outEl) { outEl.textContent = '❌ ' + e.message; outEl.className = 'settings-result err'; }
  }
}

function renderSettingsBadge(s) {
  const badge = $('#settingsBadge');
  if (!badge) return;
  if (!s) { badge.textContent = ''; badge.className = 'settings-badge'; return; }
  if (!s.hasKey) badge.dataset.state = 'no-key';
  else if (s.dsh && s.node) badge.dataset.state = 'ok';
  else badge.dataset.state = 'warn';
  badge.textContent = s.hasKey
    ? ('已配置 · ' + (s.keyMasked || ''))
    : '尚未配置 Key';
}

/* ================= 多配置模型档案（profiles） ================= */
/* state.profiles / state.activeProfileId / state.editingProfileId */
state.profiles = [];
state.activeProfileId = null;
state.editingProfileId = null; // null=新建；否则编辑该 id

async function loadProfilesUI() {
  try {
    const r = await fetchJSON('/api/profiles');
    if (!r.ok) throw new Error(r.error || '获取配置失败');
    state.profiles = r.profiles || [];
    state.activeProfileId = r.activeId || null;
    // 若当前没有编辑目标，编辑器载入当前生效配置
    if (!state.editingProfileId) {
      const cur = state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
      if (cur) loadProfileIntoEditor(cur);
      else clearProfileEditor();
    }
    renderProfilesList();
    refreshComposerModelSelect();
  } catch (e) {
    toast('加载配置失败：' + e.message);
  }
}

function loadProfileIntoEditor(p) {
  if (!p) return;
  state.editingProfileId = p.id;
  $('#profileNameInput').value = p.name || '';
  $('#apiKeyInput').value = '';
  $('#apiKeyInput').placeholder = p.hasKey ? ('当前: ' + (p.keyMasked || '已配置') + '，留空保持不变') : 'sk-...';
  $('#modelInput').value = p.model || 'deepseek-flash';
  const base = p.baseUrl || 'https://api.deepseek.com';
  $('#baseUrlInput').value = base;
  setActiveProviderCard(base);
  const out = $('#settingsResult');
  if (out) { out.textContent = ''; out.className = 'settings-result'; }
}

function clearProfileEditor() {
  state.editingProfileId = null;
  $('#profileNameInput').value = '';
  $('#apiKeyInput').value = '';
  $('#apiKeyInput').placeholder = 'sk-...';
  $('#modelInput').value = '';
  const base = 'https://api.deepseek.com';
  $('#baseUrlInput').value = base;
  setActiveProviderCard(base);
  const sel = $('#modelSelect'); if (sel) sel.classList.add('hidden');
  const out = $('#settingsResult');
  if (out) { out.textContent = ''; out.className = 'settings-result'; }
}

function renderProfilesList() {
  const box = $('#profilesListBody');
  if (!box) return;
  box.innerHTML = '';
  if (!state.profiles.length) {
    box.appendChild(el('div', 'profile-empty', '还没有配置，点「＋ 新建」添加第一套。'));
    return;
  }
  for (const p of state.profiles) {
    const item = el('div', 'profile-item' + (p.id === state.activeProfileId ? ' active' : '') + (p.id === state.editingProfileId ? ' editing' : ''), '');
    const main = el('button', 'profile-item-main', '');
    const nameRow = el('span', 'profile-item-name', '');
    nameRow.textContent = (p.id === state.activeProfileId ? '● ' : '') + (p.name || '未命名');
    main.appendChild(nameRow);
    const meta = el('span', 'profile-item-meta', p.model + ' · ' + (p.keyMasked || '无Key'));
    main.appendChild(meta);
    main.onclick = () => activateProfileClient(p.id);
    item.appendChild(main);
    const ops = el('span', 'profile-item-ops', '');
    const edit = el('button', 'profile-op', '✎');
    edit.title = '编辑';
    edit.onclick = (e) => { e.stopPropagation(); loadProfileIntoEditor(p); renderProfilesList(); };
    const del = el('button', 'profile-op danger', '🗑');
    del.title = '删除';
    del.onclick = (e) => { e.stopPropagation(); deleteProfileClient(p.id); };
    ops.appendChild(edit);
    ops.appendChild(del);
    item.appendChild(ops);
    box.appendChild(item);
  }
}

async function activateProfileClient(id) {
  try {
    const r = await fetchJSON('/api/profiles/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (!r.ok) throw new Error(r.error || '切换失败');
    state.activeProfileId = r.activeId;
    const p = state.profiles.find((x) => x.id === id);
    loadProfileIntoEditor(p || null);
    renderProfilesList();
    refreshComposerModelSelect();
    await refreshStatus();
    toast('已切换到：' + (p ? p.name : ''));
  } catch (e) {
    toast('切换失败：' + e.message);
  }
}

async function deleteProfileClient(id) {
  if (!confirm('删除这套配置？')) return;
  try {
    const r = await fetchJSON('/api/profiles/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error(r.error || '删除失败');
    if (state.editingProfileId === id) state.editingProfileId = null;
    await loadProfilesUI();
    await refreshStatus();
    toast('已删除');
  } catch (e) {
    toast('删除失败：' + e.message);
  }
}

async function saveCurrentProfile() {
  const name = ($('#profileNameInput').value || '').trim();
  const apiKey = ($('#apiKeyInput').value || '').trim();
  const model = ($('#modelInput').value || '').trim() || 'deepseek-flash';
  const baseUrl = currentProviderBaseUrl();
  const out = $('#settingsResult');
  if (!apiKey && !state.editingProfileId) {
    if (out) { out.textContent = '请填写 API Key。'; out.className = 'settings-result err'; }
    return;
  }
  try {
    let r;
    if (state.editingProfileId) {
      r = await fetchJSON('/api/profiles/' + encodeURIComponent(state.editingProfileId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, model, baseUrl, apiKey: apiKey || undefined }),
      });
    } else {
      r = await fetchJSON('/api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, baseUrl, model, apiKey }),
      });
    }
    if (!r.ok) throw new Error(r.error || '保存失败');
    if (out) { out.textContent = '✅ 已保存' + (r.activated ? '并已启用' : ''); out.className = 'settings-result ok'; }
    await loadProfilesUI();
    await refreshStatus();
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'settings-result err'; }
  }
}

/* 对话区模型切换下拉 */
function refreshComposerModelSelect() {
  const sel = $('#composerModelSelect');
  if (!sel) return;
  sel.innerHTML = '';
  for (const p of state.profiles) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = (p.id === state.activeProfileId ? '● ' : '') + (p.name || '未命名') + ' · ' + p.model;
    sel.appendChild(o);
  }
  if (state.activeProfileId) sel.value = state.activeProfileId;
  sel.disabled = !state.profiles.length;
}
async function bindComposerModelSelect() {
  const sel = $('#composerModelSelect');
  if (!sel) return;
  sel.onchange = () => {
    if (sel.value) activateProfileClient(sel.value);
  };
}
/* 静默自动拉取模型列表（打开设置时若已有 Key） */
let _autoModelTimer = null;
async function autoLoadModelsSilent() {
  if (_autoModelTimer) { clearTimeout(_autoModelTimer); }
  _autoModelTimer = setTimeout(async () => {
    try {
      const key = ($('#apiKeyInput').value || '').trim() || (state.status && state.status.hasKey ? '__saved__' : '');
      if (!key) return;
      const r = await fetchJSON('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: currentProviderBaseUrl() }) });
      if (r.ok && r.models && r.models.length) {
        const sel = $('#modelSelect');
        sel.innerHTML = '';
        const cur = currentModelValue();
        for (const m of r.models) {
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = m.id + (m.ownedBy ? '  (' + m.ownedBy + ')' : '');
          sel.appendChild(o);
        }
        sel.classList.remove('hidden');
        if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
        // 当前输入框为空时，取第一个模型
        if (!$('#modelInput').value.trim() && sel.value) $('#modelInput').value = sel.value;
      }
    } catch (_) { /* 静默失败 */ }
  }, 400);
}
async function loadModels() {
  const out = $('#settingsResult');
  const apiKey = $('#apiKeyInput').value.trim();
  const baseUrl = currentProviderBaseUrl();
  if (!apiKey && !(state.status && state.status.hasKey)) {
    out.textContent = '请先填写 API Key，再获取模型列表。';
    out.className = 'settings-result err';
    return;
  }
  out.textContent = '正在获取模型列表…';
  out.className = 'settings-result';
  try {
    const body = { baseUrl };
    if (apiKey) body.apiKey = apiKey;
    const r = await fetchJSON('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { out.textContent = '❌ ' + (r.error || '获取失败'); out.className = 'settings-result err'; return; }
    const sel = $('#modelSelect');
    sel.innerHTML = '';
    if (!r.models || !r.models.length) { out.textContent = '服务商未返回模型，请手动输入模型名。'; out.className = 'settings-result'; return; }
    const current = currentModelValue();
    for (const m of r.models) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.id + (m.ownedBy ? '  (' + m.ownedBy + ')' : '');
      sel.appendChild(o);
    }
    sel.classList.remove('hidden');
    if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
    // 同步到输入框
    if (sel.value) $('#modelInput').value = sel.value;
    out.textContent = '✅ 获取到 ' + r.models.length + ' 个模型，请在下拉中选择（也可手动输入）。';
    out.className = 'settings-result ok';
  } catch (e) {
    out.textContent = '❌ ' + e.message;
    out.className = 'settings-result err';
  }
}

function currentModelValue() {
  return $('#modelInput').value.trim() || 'deepseek-flash';
}

function currentBaseUrlValue() {
  return $('#baseUrlInput').value.trim() || 'https://api.deepseek.com';
}

/* ================= 聊天请求（SSE） ================= */
async function streamChat(mode, text, history, onEvent) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, text, history }),
  });
  if (!res.ok || !res.body) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      let event = 'message';
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      let data;
      try { data = JSON.parse(dataStr); } catch (_) { continue; }
      if (onEvent) onEvent(event, data);
    }
  }
}

function sendMessage() {
  if (state.running) return;
  const input = $('#input');
  const userText = input.value.trim();
  const readyAtts = (state.attachments || []).filter((a) => a.status === 'ready' && a.text);
  if (!userText && !readyAtts.length) { focusInput(); return; }
  if ((state.attachments || []).some((a) => a.status === 'loading')) { toast('附件还在读取中，请稍候'); return; }
  if (!state.status || !state.status.hasKey) { openSettings(); return; }
  if (!state.status.dsh || !state.status.node) { toast('Agent 内核缺失，请重新解压完整安装包'); return; }

  // 发给模型的文本 = 附件内容 + 用户输入；气泡里只显示用户输入 + 附件名
  const text = (attachmentsPrefix() + userText).trim();
  const attMeta = readyAtts.map((a) => ({ name: a.name, size: a.size }));
  ensureChat(userText || (attMeta[0] ? attMeta[0].name : '新对话'));
  state.messages.push({ role: 'user', text: userText || '（见附件）', attachments: attMeta, time: Date.now() });
  // 清空附件
  state.attachments = [];
  renderAttachments();
  state.messages.push({ role: 'assistant', text: '', running: true, time: Date.now(), streamText: '', reasoning: '', tools: [] });
  input.value = '';
  updateCharCount();
  input.style.height = 'auto';
  persistChat();
  renderMessages();
  renderHistory();

  state.running = true;
  state.status = { ...(state.status || {}), busy: true };
  renderStatus();
  $('#btnSend').disabled = true;
  $('#btnStop').classList.remove('hidden');
  $('#btnSend').classList.add('hidden');

  const history = state.messages.slice(0, -1).map((m) => ({ role: m.role, text: m.text }));
  const startedAt = Date.now();
  let lastStatus = '';
  let streamed = '';

  streamChat(state.mode, text, history, (event, data) => {
    const runningMsg = () => state.messages.find((x) => x.running);
    if (event === 'start') {
      lastStatus = '引擎已启动，正在加载知识库…';
    } else if (event === 'status') {
      if (data.stage === 'launching') lastStatus = data.message || lastStatus;
      else if (data.stage === 'running') lastStatus = 'Agent 工作中… 已运行 ' + fmtElapsed(data.elapsedMs || 0);
    } else if (event === 'delta') {
      streamed += (data.text || '');
      updateRunningMessage({ streamText: streamed, statusText: lastStatus });
    } else if (event === 'reasoning') {
      const m = runningMsg();
      if (m) {
        m.reasoning = (m.reasoning || '') + (data.text || '');
        updateRunningMessage({ reasoning: m.reasoning, statusText: lastStatus });
      }
    } else if (event === 'tool') {
      const m = runningMsg();
      if (m) {
        if (!Array.isArray(m.tools)) m.tools = [];
        if (data.state === 'start') {
          m.tools.push({ callId: data.callId, name: data.name || '工具', detail: data.detail || '', done: false });
        } else {
          const t = m.tools.find((x) => x.callId && data.callId && x.callId === data.callId) || m.tools.find((x) => !x.done && x.name === data.name);
          if (t) { t.done = true; if (data.detail) t.detail = data.detail; }
          else m.tools.push({ callId: data.callId, name: data.name || '工具', detail: data.detail || '', done: true });
        }
        updateRunningMessage({ tools: m.tools.slice(), statusText: lastStatus });
      }
    } else if (event === 'library') {
      const m = runningMsg();
      if (m) { m.library = data.items || []; renderMessages(); }
    } else if (event === 'usage') {
      const m = runningMsg();
      if (m) {
        const u = data.usage || {};
        const t = m.usageTotal || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
        t.input += Number(u.inputTokens) || 0;
        t.output += Number(u.outputTokens) || 0;
        t.cacheRead += Number(u.cacheReadTokens) || 0;
        t.cacheWrite += Number(u.cacheWriteTokens) || 0;
        t.reasoning += Number(u.reasoningTokens) || 0;
        m.usageTotal = t;
        if (data.contextWindow) m.contextWindow = data.contextWindow;
        updateRunningMessage({ usageTotal: m.usageTotal, contextWindow: m.contextWindow, statusText: lastStatus });
      }
    } else if (event === 'done') {
      const m = runningMsg();
      if (m) {
        m.text = cleanMemoryText((data.text || streamed || '').trim());
        m.streamText = undefined;
        resetSmoothStream();
        // done 附带 usage（来自 session 兜底提取），写入本轮用量
        if (data.usage && (data.usage.inputTokens || data.usage.outputTokens || data.usage.cacheReadTokens)) {
          m.usageTotal = {
            input: Number(data.usage.inputTokens) || 0,
            output: Number(data.usage.outputTokens) || 0,
            cacheRead: Number(data.usage.cacheReadTokens) || 0,
            cacheWrite: Number(data.usage.cacheWriteTokens) || 0,
            reasoning: Number(data.usage.reasoningTokens) || 0,
          };
          m.contextWindow = data.contextWindow || m.contextWindow;
        }
        // 保留 reasoning / tools，完成后仍可查看
        m.running = false;
        m.time = Date.now();
      }
      persistChat();
      finishRun();
      renderStatus();
      toast('已完成 · 用时 ' + fmtElapsed(Date.now() - startedAt));
      try { maybeAutoTitle(); } catch (_) {}
    } else if (event === 'error') {
      const m = runningMsg();
      if (m) {
        m.text = cleanMemoryText(streamed.trim()) || undefined;
        m.streamText = undefined;
        resetSmoothStream();
        // 保留 reasoning / tools，失败后仍可查看
        m.error = data.message || '运行失败';
        m.running = false;
      }
      persistChat();
      finishRun();
      renderStatus();
    }
    if (event !== 'delta' && event !== 'reasoning' && event !== 'tool') updateRunningMessage({ statusText: lastStatus });
  }).catch((err) => {
    const m = state.messages.find((x) => x.running);
    if (m) { m.error = err.message || '请求失败'; m.running = false; }
    persistChat();
    finishRun();
    renderMessages();
  });
}

function finishRun() {
  state.running = false;
  $('#btnSend').disabled = false;
  $('#btnSend').classList.remove('hidden');
  $('#btnStop').classList.add('hidden');
  renderMessages();
  refreshStatus().catch(() => {});
}

function stopRun() {
  fetchJSON('/api/cancel', { method: 'POST' })
    .then(() => {
      const m = state.messages.find((x) => x.running);
      if (m) updateRunningMessage({ statusText: '正在停止…' });
    })
    .catch((e) => toast(e.message));
}

/* ================= 导出 ================= */
function buildMarkdown(single = null) {
  const msgs = single ? [single] : state.messages.filter((m) => !m.running);
  if (!msgs.length) return null;
  const lines = ['# 逻敏 · Academy 辩论教练 对话记录', '', '> 导出时间：' + new Date().toLocaleString('zh-CN'), ''];
  for (const m of msgs) {
    lines.push('## ' + (m.role === 'user' ? '🧑 我' : '🎓 逻敏'));
    lines.push('');
    lines.push(m.error ? ('⚠️ ' + m.error) : m.text);
    lines.push('');
  }
  return lines.join('\n');
}

function exportMarkdown(single = null) {
  const md = buildMarkdown(single);
  if (!md) { toast('没有可导出的内容'); return; }
  const blob = new Blob(['\ufeff' + md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '辩论教练对话_' + new Date().toISOString().slice(0, 10) + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function exportWord(single = null) {
  const md = buildMarkdown(single);
  if (!md) { toast('没有可导出的内容'); return; }
  const title = single
    ? ('辩论教练回复_' + (single.text || '').replace(/\s+/g, ' ').slice(0, 20))
    : ('辩论教练对话_' + new Date().toISOString().slice(0, 10));
  try {
    const res = await fetch('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: md, title }),
    });
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); msg = j.error || j.message || msg; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (title || '辩论教练导出').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40) + '.docx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Word 文档已生成');
  } catch (e) {
    toast('生成 Word 失败：' + e.message);
  }
}

async function exportPdf(single = null) {
  if (!window.academyElectron || !window.academyElectron.exportPdf) {
    toast('PDF 导出仅在桌面版可用，这里请用 Word 或 Markdown');
    return;
  }
  const md = buildMarkdown(single);
  if (!md) { toast('没有可导出的内容'); return; }
  const title = single
    ? ('辩论教练回复_' + (single.text || '').replace(/\s+/g, ' ').slice(0, 20))
    : ('辩论教练对话_' + new Date().toISOString().slice(0, 10));
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    '<style>body{font-family:"Microsoft YaHei",sans-serif;margin:32px;color:#222;line-height:1.7}' +
    'pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto}code{background:#f0f0f0;padding:2px 4px;border-radius:3px}' +
    'blockquote{border-left:3px solid #ccc;margin:8px 0;padding:4px 12px;color:#555}h1,h2,h3{border-bottom:1px solid #eee;padding-bottom:6px}</style>' +
    '</head><body>' + mdToHtml(md) + '</body></html>';
  try {
    const r = await window.academyElectron.exportPdf(html, title);
    if (r && r.ok) toast('PDF 已保存：' + r.path);
    else toast('PDF 导出已取消');
  } catch (e) {
    toast('PDF 导出失败：' + e.message);
  }
}

/* 导出当前会话：单按钮 + 下拉菜单选格式（Word / Markdown / PDF） */
function bindExportMenu() {
  const menu = $('#exportMenu');
  const btn = $('#btnExportSession');
  const drop = $('#exportDropdown');
  if (!menu || !btn || !drop) return; // 旧缓存页面没有新控件时静默跳过
  const closeMenu = () => drop.classList.add('hidden');
  // 浏览器模式不支持 PDF → 菜单里隐藏该项
  if (!(window.academyElectron && window.academyElectron.exportPdf)) {
    const pdfItem = drop.querySelector('[data-export="pdf"]');
    if (pdfItem) pdfItem.classList.add('hidden');
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    drop.classList.toggle('hidden');
  });
  drop.addEventListener('click', (e) => {
    e.stopPropagation();
    const item = e.target.closest('.export-item');
    if (!item) return;
    closeMenu();
    const kind = item.dataset.export;
    if (kind === 'word') exportWord(null);
    else if (kind === 'pdf') exportPdf(null);
    else exportMarkdown(null);
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
}

/* ================= 输入框 ================= */
function updateCharCount() {
  $('#charCount').textContent = $('#input').value.length.toLocaleString() + ' 字';
}
function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/* ================= 附件（上传资料） =================
   与主流 AI 一致：文件以「附件卡片」形式挂在输入框上方，随消息一起发送，
   不再把文件全文塞进输入框。 */
function fmtFileSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  if (n >= 1024) return Math.round(n / 1024) + 'KB';
  return n + 'B';
}

function fileIcon(name) {
  if (/\.pdf$/i.test(name)) return '📕';
  if (/\.docx?$/i.test(name)) return '📘';
  if (/\.(md|markdown)$/i.test(name)) return '📝';
  if (/\.srt$/i.test(name)) return '💬';
  return '📄';
}

function renderAttachments() {
  const box = $('#attachList');
  if (!box) return;
  box.innerHTML = '';
  for (const a of state.attachments || []) {
    const chip = el('div', 'attach-chip' + (a.status === 'loading' ? ' loading' : '') + (a.status === 'error' ? ' error' : ''));
    chip.appendChild(el('span', 'ac-icon', fileIcon(a.name)));
    const nm = el('span', 'ac-name', a.name);
    nm.title = a.name + (a.note ? '（' + a.note + '）' : '');
    chip.appendChild(nm);
    chip.appendChild(el('span', 'ac-size', a.status === 'loading' ? '读取中…' : (a.status === 'error' ? '失败' : fmtFileSize(a.size || 0))));
    const del = el('button', 'ac-del', '×');
    del.type = 'button';
    del.title = a.status === 'error' ? '移除（' + (a.note || '读取失败') + '）' : '移除附件';
    del.onclick = () => {
      state.attachments = (state.attachments || []).filter((x) => x.id !== a.id);
      renderAttachments();
    };
    chip.appendChild(del);
    box.appendChild(chip);
  }
}

let _attachSeq = 0;
async function attachFile(file) {
  if (!file) return;
  const name = file.name || 'file';
  const isPdf = /\.pdf$/i.test(name);
  const isDocx = /\.docx$/i.test(name);
  const isDoc = /\.doc$/i.test(name);
  const isText = /\.(txt|md|markdown|srt)$/i.test(name);

  if (isDoc) { toast('不支持旧版 .doc，请用 Word 另存为 .docx 后再上传'); return; }
  if (!isPdf && !isDocx && !isText) {
    toast('支持格式：Word(.docx) / PDF / txt / md / srt');
    return;
  }
  if (file.size > 20 * 1024 * 1024) { toast('文件过大（超过 20MB）'); return; }

  const id = 'att' + (++_attachSeq) + '_' + Date.now().toString(36);
  const item = { id, name, size: file.size, text: '', status: 'loading', note: '' };
  state.attachments = state.attachments || [];
  state.attachments.push(item);
  renderAttachments();

  try {
    if (isPdf || isDocx) {
      const b64 = await fileToBase64(file);
      const api = isPdf ? '/api/extract-pdf' : '/api/extract-docx';
      const res = await fetch(api, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, data: b64 }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || '提取失败');
      item.text = j.text || '';
      item.note = '已提取 ' + (j.charCount || item.text.length) + ' 字';
      item.status = 'ready';
    } else {
      item.text = await file.text();
      item.status = 'ready';
      item.note = item.text.length + ' 字';
    }
    toast('已添加附件：' + name + (item.note ? '（' + item.note + '）' : ''));
  } catch (e) {
    item.status = 'error';
    item.note = e.message;
    toast('读取失败：' + e.message);
  }
  renderAttachments();
}

/* 把附件内容拼成发给模型的前缀 */
function attachmentsPrefix() {
  const ready = (state.attachments || []).filter((a) => a.status === 'ready' && a.text);
  if (!ready.length) return '';
  return ready.map((a) => '【附件：' + a.name + '】\n' + a.text).join('\n\n') + '\n\n';
}

/* ================= 工具列表 ================= *//* ================= 工具列表 ================= */
const TOOL_INFO = [
  ['__research__', '🔍 研究台', '边查资料边和教练聊：搜索 + 7 触发条件建议 + 独立研究对话（独立小窗）'],
  ['__mdReader__', '📖 MD 阅读器', '打开本地 Markdown / 文本文件阅读'],
  ['辩案工作台-Case-Workbench.html', '辩案工作台', '九步法构建完整辩案'],
  ['简易流水单-Flowing-Tool.html', '简易流水单', '比赛攻防流水记录'],
];

function renderTools() {
  const box = $('#toolsList');
  box.innerHTML = '';
  for (const [file, name, desc] of TOOL_INFO) {
    if (file === '__research__') {
      // 独立轻量窗：研究台（搜索 + 独立研究对话）
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool-link';
      b.innerHTML = '<span><b>' + esc(name) + '</b><br><small>' + esc(desc) + '</small></span><span>🔍</span>';
      b.onclick = async () => {
        try {
          const ae = window.academyElectron;
          if (ae && ae.openResearch) {
            const r = await ae.openResearch();
            if (r && r.ok) { $('#toolsModal').classList.add('hidden'); return; }
            toast('打开研究台失败：' + ((r && r.error) || ''));
          } else {
            toast('研究台是独立小窗，需要桌面版（Electron）环境；浏览器模式下请用双击文件的方式打开');
          }
        } catch (e) { toast('打开失败：' + (e.message || e)); }
      };
      box.appendChild(b);
      continue;
    }
    if (file === '__mdReader__') {
      // 内置能力：打开本地 MD 阅读器（非外链工具）
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool-link';
      b.innerHTML = '<span><b>' + esc(name) + '</b><br><small>' + esc(desc) + '</small></span><span>📂</span>';
      b.onclick = () => { $('#toolsModal').classList.add('hidden'); openMdReader(); };
      box.appendChild(b);
      continue;
    }
    const a = document.createElement('a');
    a.className = 'tool-link';
    a.href = '/tools/' + encodeURIComponent(file);
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = '<span><b>' + esc(name) + '</b><br><small>' + esc(desc) + '</small></span><span>↗</span>';
    box.appendChild(a);
  }
}

/* ================= 产物空间 ================= */
const deliverState = { items: [], search: '' };
function deliverFileIcon(name) {
  const e = String(name||'').split('.').pop().toLowerCase();
  if (e==='md'||e==='markdown') return '📝';
  if (e==='csv') return '📊';
  if (e==='xlsx') return '📗';
  if (e==='docx') return '📘';
  if (e==='pdf') return '📕';
  if (e==='txt') return '📄';
  return '📦';
}
async function loadDeliverables() {
  try {
    const r = await fetchJSON('/api/deliverables');
    deliverState.items = (r.items || []);
    $('#deliverMeta').textContent = '共 ' + r.count + ' 个文件 · 位置 data/deliverables/';
    renderDeliverList();
  } catch (e) { $('#deliverMeta').textContent = '读取失败：' + e.message; }
}
function renderDeliverList() {
  const box = $('#deliverList'); if (!box) return;
  box.innerHTML = '';
  const q = deliverState.search.toLowerCase().trim();
  const items = deliverState.items.filter((i) => !q || i.name.toLowerCase().includes(q));
  if (!items.length) { box.appendChild(el('div','skill-empty', q ? '没有匹配的文件。' : '产物空间还空着——让教练写一份备赛包/复盘报告，它就会存到这里。')); return; }
  for (const it of items) {
    const card = el('div','deliver-item');
    const head = el('div','deliver-item-head');
    head.appendChild(el('span','deliver-item-icon', deliverFileIcon(it.name)));
    const nm = el('span','deliver-item-name', it.name); nm.title = it.name; head.appendChild(nm);
    head.appendChild(el('span','deliver-item-size', (it.size>=1048576 ? (it.size/1048576).toFixed(1)+'MB' : Math.max(1,Math.round(it.size/1024))+'KB')));
    card.appendChild(head);
    const meta = el('div','deliver-item-meta');
    meta.appendChild(el('span',null,'🕘 '+ fmtTime(it.mtime) + (it.textType ? ' · 文本' : ' · 文件')));
    card.appendChild(meta);
    const acts = el('div','deliver-item-actions');
    const bPrev = el('button','btn ghost small','预览'); bPrev.type='button'; bPrev.onclick = () => deliverPreview(it);
    const bSave = el('button','btn ghost small','导出到文件夹'); bSave.type='button'; bSave.onclick = () => deliverSaveAs(it);
    acts.appendChild(bPrev); acts.appendChild(bSave);
    if (it.textType && /md|markdown|txt/.test(it.ext)) { const bW=el('button','btn ghost small','转 Word'); bW.type='button'; bW.onclick=()=>deliverConvert(it,'docx'); acts.appendChild(bW); }
    if (it.ext==='csv') { const bX=el('button','btn ghost small','转 Excel'); bX.type='button'; bX.onclick=()=>deliverConvert(it,'xlsx'); acts.appendChild(bX); }
    if (it.textType) { const bP=el('button','btn ghost small','存 PDF'); bP.type='button'; bP.onclick=()=>deliverPdf(it); acts.appendChild(bP); }
    const bOpen = el('button','btn ghost small','所在文件夹'); bOpen.type='button'; bOpen.onclick=()=>deliverOpenFolder(it.name); acts.appendChild(bOpen);
    const bDel = el('button','btn ghost small danger','删除'); bDel.type='button'; bDel.onclick=()=>deliverDelete(it.name); acts.appendChild(bDel);
    card.appendChild(acts);
    box.appendChild(card);
  }
}
async function deliverPreview(it) {
  const box = $('#deliverPreviewBody');
  $('#deliverPreviewTitle').textContent = '预览：' + it.name;
  $('#deliverPreview').classList.remove('hidden');
  if (!it.textType) { box.innerHTML = '<p class=\'hint\'>非文本文件，请点「导出到文件夹」用本机应用打开。</p>'; return; }
  box.innerHTML = '<p class=\'hint\'>加载中…</p>';
  try {
    const r = await fetchJSON('/api/deliverables/read?name=' + encodeURIComponent(it.name));
    if (!r.file) throw new Error('读取失败');
    if (it.ext==='csv') box.innerHTML = '<pre style=\'white-space:pre;overflow:auto\'>' + esc(r.file.text.slice(0,12000)) + '</pre>';
    else box.innerHTML = (window.MDView ? MDView.mdToHtml(r.file.text.slice(0,60000)) : '<pre>'+esc(r.file.text.slice(0,60000))+'</pre>');
  } catch (e) { box.innerHTML = '<p class=\'hint\'>' + esc(e.message || '读取失败') + '</p>'; }
}
async function deliverConvert(it, target) {
  const r = await libApi('/api/deliverables/convert', { name: it.name, target });
  if (r && r.ok) { toast('已生成：' + r.item.name); loadDeliverables(); } else toast('转换失败：' + ((r&&r.error)||''));
}
/* 产物「存 PDF」的打印样式：与 app/pdf-worker.js 同一套排版规格（页边距由 printToPDF 控制，body 不留边距） */
const DELIVER_PDF_CSS =
  'html{color-scheme:light}' +
  'body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;margin:0;color:#1c2434;line-height:1.6;font-size:14.5px;background:#fff}' +
  'h1{font-size:1.6em;color:#1F3864}' +
  'h2{font-size:1.35em;color:#2F5496}' +
  'h3{font-size:1.15em;color:#333}' +
  'h1,h2,h3{border-bottom:1px solid #e5e7ee;padding-bottom:.3em;margin-top:1.4em;page-break-after:avoid}' +
  'p{margin:.6em 0;orphans:2;widows:2}' +
  'pre{background:#f5f7fb;padding:12px;border-radius:6px;overflow:hidden;font-size:12px;white-space:pre-wrap;word-break:break-all;page-break-inside:avoid}' +
  'code{background:#f0f2f7;padding:1px 5px;border-radius:4px;font-size:.92em}' +
  'blockquote{border-left:3px solid #8496B0;margin:8px 0;padding:2px 14px;color:#445066}' +
  'table{border-collapse:collapse;margin:10px 0;width:100%}' +
  'tr{page-break-inside:avoid}' +
  'th,td{border:1px solid #d5dae6;padding:5px 10px}' +
  'th{background:#eef1f8}' +
  'ul,ol{margin:.5em 0;padding-left:1.6em}li{margin:.25em 0}' +
  'a{color:#0563C1}';

async function deliverPdf(it) {
  try {
    const ae = window.academyElectron;
    if (!ae || !ae.exportPdf) { toast('浏览器模式：PDF 将保存到产物空间…'); deliverConvert(it, 'pdf'); return; }
    const r = await fetchJSON('/api/deliverables/read?name=' + encodeURIComponent(it.name));
    let text = (r.file && r.file.text) || '';
    if (it.ext==='csv') text = text.replace(/\r?\n/g,'\n');
    // 用主窗口自带的 mdToHtml 渲染（window.MDView 在主窗口根本没加载，旧代码一直掉进 <pre> 兜底把原始 Markdown 打进 PDF）
    const body = mdToHtml(text);
    const html = '<!doctype html><html><head><meta charset=\'utf-8\'><title>'+esc(it.name)+'</title><style>'+DELIVER_PDF_CSS+'</style></head><body>'+body+'</body></html>';
    if (ae.exportPdfSilent) {
      const sOut = await ae.exportPdfSilent(html, it.name);
      if (sOut && sOut.ok) { toast('PDF 已存到产物空间：' + sOut.name); loadDeliverables(); return; }
      if (sOut && sOut.error) { toast('PDF 导出失败：' + sOut.error); return; }
    }
    const out = await ae.exportPdf(html, it.name.replace(/\.\w+$/,''));
    if (out && out.ok) toast('PDF 已保存：' + out.path);
  } catch (e) { toast('PDF 导出失败：' + e.message); }
}
async function deliverSaveAs(it) {
  const ae = window.academyElectron;
  if (!ae || !ae.saveDeliverable) { toast('桌面版支持「导出到任意文件夹」，浏览器模式下暂不可用'); return; }
  try {
    if (it.textType) {
      const r = await fetchJSON('/api/deliverables/read?name=' + encodeURIComponent(it.name));
      const out = await ae.saveDeliverable({ name: it.name, text: (r.file && r.file.text) || '' });
      if (out && out.ok) toast('已导出：' + out.path);
    } else {
      // 二进制：经 read 拿 base64（服务端加 base64 支持）
      const r = await fetchJSON('/api/deliverables/read?name=' + encodeURIComponent(it.name) + '&raw=1');
      const out = await ae.saveDeliverable({ name: it.name, base64: (r.file && r.file.base64) || '' });
      if (out && out.ok) toast('已导出：' + out.path);
    }
  } catch (e) { toast('导出失败：' + e.message); }
}
async function deliverOpenFolder(name) {
  const ae = window.academyElectron;
  if (!ae || !ae.showInFolder) { toast('浏览器模式下无法打开文件夹'); return; }
  await ae.showDeliverFolder(name);
}
async function deliverDelete(name) {
  if (!window.confirm('删除产物「' + name + '」？')) return;
  const r = await libApi('/api/deliverables/delete', { name });
  if (r && r.ok) { toast('已删除'); loadDeliverables(); } else toast('删除失败：' + ((r&&r.error)||''));
}
function bindDeliverables() {
  const btn = $('#btnDeliver'); if (btn) btn.onclick = () => { $('#deliverModal').classList.remove('hidden'); loadDeliverables(); };
  const rf = $('#btnDeliverRefresh'); if (rf) rf.onclick = loadDeliverables;
  const srch = $('#deliverSearch');
  if (srch) srch.oninput = () => { deliverState.search = srch.value; renderDeliverList(); };
  const folder = $('#btnDeliverFolder');
  if (folder) folder.onclick = () => { const ae=window.academyElectron; if (ae && ae.showDeliverFolder) ae.showDeliverFolder(); else toast('浏览器模式不可用'); };
  const close = $('#btnDeliverPreviewClose'); if (close) close.onclick = () => $('#deliverPreview').classList.add('hidden');
}

/* ================= 扩展工具：文档处理开关 ================= */
function extToolsLabel(want) { return want ? '开' : '关（默认）'; }
async function loadExtToolsToggle() {
  const t = $('#extendedToolsToggle'); if (!t) return;
  try {
    const r = await fetchJSON('/api/config');
    const on = r && r.config && r.config.extendedTools === true;
    t.checked = on;
    $('#extendedToolsLabel').textContent = extToolsLabel(on);
  } catch (_) {}
}
async function saveExtToolsToggle() {
  const t = $('#extendedToolsToggle'); if (!t) return;
  const want = t.checked;
  if (want) {
    const ok = window.confirm(
      '⚠️ 开启前请认真确认：这相当于让教练能操作你电脑上的文件。\n\n' +
      '开启后，教练可以按你的要求：\n' +
      '· 读取、整理、修改你指定的文件夹里的文件\n' +
      '· 把内容转成 Word / Excel / PDF 等格式，存到你选的位置\n\n' +
      '风险请知悉：\n' +
      '· 教练靠理解你的话来干活，理解偏了就可能改错甚至误删文件\n' +
      '· 误操作造成的文件丢失无法自动恢复\n' +
      '· 建议只授权给你放资料的文件夹，重要文件先备份一份\n\n' +
      '仍要开启吗？'
    );
    if (!ok) { t.checked = false; return; }
  }
  try {
    const r = await fetchJSON('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extendedTools: want }) });
    if (r && r.ok) {
      $('#extendedToolsLabel').textContent = extToolsLabel(want);
      toast(want ? '已开启（从下一条消息起生效）' : '已关闭');
    } else toast('设置失败：' + ((r && r.error) || ''));
  } catch (e) { toast('设置失败：' + e.message); }
}
async function bindExtTools() {
  const t = $('#extendedToolsToggle');
  if (t) t.onchange = saveExtToolsToggle;
}


/* 旧的「搜资料」弹窗已移除：搜索与独立研究对话整合进「研究台」独立轻量窗（app/research-window.js）。 */

/* ———— 记忆中心：多级记忆前端展示（长期 / 流水 / 统计）———— */
let memoryTab = 'long';
function switchMemoryTab(tab) {
  memoryTab = tab || 'long';
  document.querySelectorAll('.memory-tab').forEach((b) => b.classList.toggle('active', b.dataset.mtab === memoryTab));
  document.querySelectorAll('.memory-panel').forEach((p) => p.classList.toggle('active', p.id === ('memory' + (tab === 'daily' ? 'Daily' : tab === 'stats' ? 'Stats' : 'Long') + 'Panel')));
  if (memoryTab === 'long') { /* 已渲染 */ }
}

/* ================= 技能 / 插件（设置面板） ================= */
const skillsUI = { editing: null, all: { user: [], bundled: [] } };
function skillEscape(s){ return esc(s); }
async function loadSkillsUI() {
  const msg = $('#skillMsg'); if (msg) { msg.textContent=''; msg.className='settings-result'; }
  try {
    const r = await fetchJSON('/api/skills');
    skillsUI.all = r;
    $('#skillCount').textContent = (r.user || []).length + '（启用 ' + (r.activeCount||0) + '）';
    renderSkillUserList();
    renderSkillBundledList();
  } catch (e) {
    const el = $('#skillList'); if (el) el.innerHTML = '<div class=\'skill-empty\'>读取失败：' + esc(e.message) + '</div>';
  }
}
function renderSkillUserList() {
  const box = $('#skillList'); if (!box) return;
  box.innerHTML = '';
  const items = (skillsUI.all.user || []);
  if (!items.length) { box.appendChild(el('div','skill-empty','还没有自己的技能。点上方「导入技能文件」或「新建」添加。')); return; }
  for (const s of items) {
    const card = el('div','skill-item' + (s.enabled ? '' : ' off'));
    const head = el('div','skill-item-head');
    head.appendChild(el('span','skill-item-name', s.name));
    const st = el('span','skill-item-state', s.enabled ? '启用' : '已停用');
    st.className += s.enabled ? ' on' : '';
    head.appendChild(st);
    if (!s.valid) head.appendChild(el('span','skill-item-bad','⚠ 缺 frontmatter'));
    card.appendChild(head);
    card.appendChild(el('div','skill-item-desc', s.description));
    const meta = el('div','skill-item-meta');
    meta.appendChild(el('span',null,'📄 ' + s.fileName));
    meta.appendChild(el('span',null,'· ' + Math.round(s.size/1024*10)/10 + 'KB'));
    if (s.whenToUse) meta.appendChild(el('span','skill-item-when','触发：' + s.whenToUse));
    card.appendChild(meta);
    const acts = el('div','skill-item-actions');
    const bToggle = el('button','btn ghost small', s.enabled ? '停用' : '启用'); bToggle.type='button';
    bToggle.onclick = () => skillToggle(s);
    const bEdit = el('button','btn ghost small','编辑'); bEdit.type='button'; bEdit.onclick = () => skillEdit(s);
    const bDel = el('button','btn ghost small danger','删除'); bDel.type='button'; bDel.onclick = () => skillDelete(s);
    acts.append(bToggle, bEdit, bDel);
    card.appendChild(acts);
    box.appendChild(card);
  }
}
function renderSkillBundledList() {
  const box = $('#skillBundledList'); if (!box) return;
  box.innerHTML = '';
  const items = (skillsUI.all.bundled || []);
  if (!items.length) { box.appendChild(el('div','skill-empty','（无）')); return; }
  for (const s of items) {
    const d = el('div','skill-item bundled');
    const head = el('div','skill-item-head');
    head.appendChild(el('span','skill-item-name', s.name));
    if (!s.valid) head.appendChild(el('span','skill-item-bad','⚠ 缺 frontmatter'));
    d.appendChild(head);
    d.appendChild(el('div','skill-item-desc', s.description));
    box.appendChild(d);
  }
}
async function skillToggle(s) {
  const r = await libApi('/api/skills/toggle', { name: s.name, enabled: !s.enabled });
  if (r && r.ok) { toast(s.enabled ? '已停用' : '已启用'); loadSkillsUI(); } else toast('操作失败：' + ((r&&r.error)||''));
}
async function skillDelete(s) {
  if (!window.confirm('删除技能「' + s.name + '」？文件会被移除。')) return;
  const r = await libApi('/api/skills/delete', { name: s.name });
  if (r && r.ok) { toast('已删除'); loadSkillsUI(); } else toast('删除失败：' + ((r&&r.error)||''));
}
function skillEdit(s) {
  skillsUI.editing = s;
  $('#skillEditorTitle').textContent = '编辑：' + s.name;
  $('#skillEditor').classList.remove('hidden');
  $('#skillContent').value = '';
  $('#skillContent').placeholder = '加载中…';
  fetchJSON('/api/skills/view?name=' + encodeURIComponent(s.name)).then((r) => {
    if (r && r.ok && r.skill) { $('#skillContent').value = r.skill.content; $('#skillContent').placeholder = ''; }
  }).catch((e) => { $('#skillContent').placeholder = '读取失败：' + e.message; });
}
function skillNew() {
  skillsUI.editing = null;
  $('#skillEditorTitle').textContent = '新建技能（粘贴内容）';
  $('#skillContent').value = '';
  $('#skillContent').placeholder = '---\nname: 技能名\ndescription: 什么时候用、做什么\nwhenToUse: 可选\n---\n\n正文…';
  $('#skillEditor').classList.remove('hidden');
}
async function skillSaveFromEditor() {
  const content = $('#skillContent').value;
  if (skillsUI.editing) {
    // 编辑既有技能：按文件名保存（frontmatter name 不变）
    const r = await libApi('/api/skills/save', { name: skillsUI.editing.name, content });
    if (r && r.ok) { toast('已保存'); $('#skillEditor').classList.add('hidden'); loadSkillsUI(); }
    else toast('保存失败：' + ((r&&r.error)||'格式不对'));
  } else {
    // 新建：让服务端从 frontmatter 解析 name 并落盘（同名冲突会报错）
    const r = await libApi('/api/skills/import', { content, overwrite: false });
    if (r && r.ok) { toast('已创建技能：' + (r.item ? r.item.name : '')); $('#skillEditor').classList.add('hidden'); loadSkillsUI(); }
    else toast('创建失败：' + ((r&&r.error)||'格式不对'));
  }
}
async function skillImportFiles(files) {
  const list = Array.from(files || []).slice(0, 10);
  if (!list.length) return;
  let ok = 0, fail = 0;
  for (const file of list) {
    try {
      const text = await file.text();
      const r = await libApi('/api/skills/import', { content: text, overwrite: false });
      if (r && r.ok) ok++; else { fail++; console.warn('技能导入失败', file.name, r && r.error); }
    } catch (e) { fail++; }
  }
  toast('导入完成：成功 ' + ok + ' 份' + (fail ? '，失败 ' + fail + ' 份（同名或格式问题，看面板提示）' : ''));
  $('#skillMsg').textContent = (ok ? '✅ 成功 ' + ok + ' 份。' : '') + (fail ? '❌ 失败 ' + fail + ' 份：同名冲突或缺少 frontmatter（name/description）。可改名或勾选覆盖后重试。' : '');
  loadSkillsUI();
}
function bindSkillsUI() {
  const bImp = $('#btnSkillImport'); const inp = $('#skillFileInput');
  if (bImp && inp) { bImp.onclick = () => inp.click(); inp.onchange = () => { if (inp.files.length) skillImportFiles(inp.files); inp.value=''; }; }
  const bNew = $('#btnSkillNew'); if (bNew) bNew.onclick = skillNew;
  const bCancel = $('#btnSkillEditorCancel'); if (bCancel) bCancel.onclick = () => $('#skillEditor').classList.add('hidden');
  const bSave = $('#btnSkillEditorSave'); if (bSave) bSave.onclick = skillSaveFromEditor;
}
async function openMemory() {
  $('#memoryModal').classList.remove('hidden');
  $('#memoryMeta').textContent = '（加载中…）';
  try {
    const res = await fetch('/api/memory');
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || '读取失败');
    renderMemoryViews(j);
  } catch (e) {
    $('#memoryMeta').textContent = '读取失败：' + e.message;
  }
}

function memPanelBar(scope, label) {
  const bar = el('div', 'mem-panel-bar');
  const b = el('button', 'btn ghost small', label);
  b.type = 'button';
  b.onclick = () => openMemoryNew(scope);
  bar.appendChild(b);
  bar.appendChild(el('span', 'mem-panel-tip', '每条记忆都可以编辑或删除'));
  return bar;
}

function memEntryCard(e, scope, date) {
  const d = el('div', 'mem-entry');
  const head = el('div', 'mem-entry-head');
  const t = el('div', 'mem-entry-title', '');
  t.appendChild(document.createTextNode(e.title || '（未命名）'));
  if (e.time) t.appendChild(el('span', 'mem-entry-time', e.time));
  head.appendChild(t);

  // 编辑工具条（平时不占位，hover 显示）
  const acts = el('div', 'mem-entry-acts');
  const bEdit = el('button', 'mem-act-btn', '✏️ 编辑'); bEdit.type = 'button';
  const bDel = el('button', 'mem-act-btn danger', '🗑 删除'); bDel.type = 'button';
  acts.appendChild(bEdit); acts.appendChild(bDel);
  head.appendChild(acts);
  d.appendChild(head);

  const body = el('div', 'mem-entry-body', e.body || '（无内容）');
  d.appendChild(body);

  // 原地编辑区（默认隐藏）
  const editor = el('div', 'mem-entry-editor hidden');
  const inTitle = document.createElement('input');
  inTitle.type = 'text'; inTitle.className = 'mem-edit-title';
  inTitle.value = e.title || ''; inTitle.placeholder = '标题（留空则自动用时间戳）';
  const inBody = document.createElement('textarea');
  inBody.className = 'mem-edit-body'; inBody.rows = 6;
  inBody.value = e.body || ''; inBody.placeholder = '内容（支持 Markdown）';
  const btns = el('div', 'mem-edit-actions');
  const bSave = el('button', 'btn primary small', '保存'); bSave.type = 'button';
  const bCancel = el('button', 'btn ghost small', '取消'); bCancel.type = 'button';
  btns.appendChild(bSave); btns.appendChild(bCancel);
  editor.appendChild(inTitle); editor.appendChild(inBody); editor.appendChild(btns);
  d.appendChild(editor);

  bEdit.onclick = () => {
    editor.classList.remove('hidden');
    body.classList.add('hidden');
    try { inTitle.focus(); } catch (_) {}
  };
  bCancel.onclick = () => {
    editor.classList.add('hidden');
    body.classList.remove('hidden');
    inTitle.value = e.title || '';
    inBody.value = e.body || '';
  };
  bSave.onclick = () => saveMemoryEntry({ scope, date, idx: e.idx, title: inTitle.value, body: inBody.value }, bSave);
  bDel.onclick = () => deleteMemoryEntry({ scope, date, idx: e.idx, title: e.title });
  return d;
}

/* 保存单条记忆（idx 为数字 = 改；新增时不传 idx） */
async function saveMemoryEntry(payload, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const r = await fetchJSON('/api/memory/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(r.error || '保存失败');
    toast(r.mode === 'create' ? '已新增记忆' : '已保存修改');
    await openMemory();
  } catch (e) {
    toast('保存失败：' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

async function deleteMemoryEntry({ scope, date, idx, title }) {
  const label = String(title || '').slice(0, 24) || '这条记忆';
  if (!confirm('确定删除「' + label + '」？此操作不可恢复。')) return;
  try {
    const r = await fetchJSON('/api/memory/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, date, idx }),
    });
    if (!r.ok) throw new Error(r.error || '删除失败');
    toast('已删除');
    await openMemory();
  } catch (e) { toast('删除失败：' + e.message); }
}

/* 新增记忆（长期 / 当天流水） */
function openMemoryNew(scope) {
  const host = scope === 'daily' ? $('#memoryDailyPanel') : $('#memoryLongPanel');
  if (!host) return;
  if ($('#memNewBox')) { $('#memNewBox').remove(); return; }
  const box = el('div', 'mem-new-box');
  box.id = 'memNewBox';
  const inTitle = document.createElement('input');
  inTitle.type = 'text'; inTitle.className = 'mem-edit-title';
  inTitle.placeholder = '标题（留空则自动用时间戳）';
  const inBody = document.createElement('textarea');
  inBody.className = 'mem-edit-body'; inBody.rows = 5;
  inBody.placeholder = scope === 'daily' ? '今天想记点什么？（支持 Markdown）' : '要长期记住的内容，如判准、偏好、基准…';
  const btns = el('div', 'mem-edit-actions');
  const bSave = el('button', 'btn primary small', '添加'); bSave.type = 'button';
  const bCancel = el('button', 'btn ghost small', '取消'); bCancel.type = 'button';
  btns.appendChild(bSave); btns.appendChild(bCancel);
  box.appendChild(inTitle); box.appendChild(inBody); box.appendChild(btns);
  host.insertBefore(box, host.firstChild);
  try { inTitle.focus(); } catch (_) {}
  bCancel.onclick = () => box.remove();
  bSave.onclick = () => {
    if (!inTitle.value.trim() && !inBody.value.trim()) { toast('标题和内容不能都为空'); return; }
    saveMemoryEntry({ scope, title: inTitle.value, body: inBody.value }, bSave);
  };
}

function renderMemoryViews(j) {
  const stats = j.stats || { longCount: 0, dailyCount: 0, dailyFiles: 0, totalBytes: 0 };
  $('#memoryMeta').textContent = [
    '🗂 长期 ' + stats.longCount + ' 条',
    '· 🗓 流水 ' + stats.dailyCount + ' 条 / ' + stats.dailyFiles + ' 天',
    '· 📦 共 ' + (stats.totalBytes || 0).toLocaleString() + ' B',
  ].join(' ');

  // 长期面板
  const longPanel = $('#memoryLongPanel');
  longPanel.innerHTML = '';
  longPanel.appendChild(memPanelBar('long', '＋ 新增长期记忆'));
  const longEntries = (j.long && j.long.entries) || [];
  if (!longEntries.length) {
    longPanel.appendChild(el('div', 'mem-empty', '暂无长期记忆。Agent 在对话中发现值得长期记住的内容（判准、偏好、基准等）时，会自动以「长期记忆」归档到这里。也可以直接告诉它「记住…」，或点上方「＋ 新增长期记忆」手动添加。'));
  } else {
    for (const e of longEntries.slice().reverse()) longPanel.appendChild(memEntryCard(e, 'long', ''));
  }

  // 流水面板
  const dailyPanel = $('#memoryDailyPanel');
  dailyPanel.innerHTML = '';
  dailyPanel.appendChild(memPanelBar('daily', '＋ 新增今日流水'));
  const daily = j.daily || [];
  if (!daily.length) {
    dailyPanel.appendChild(el('div', 'mem-empty', '暂无每日流水。Agent 的短期观察会归档到「当日流水」，几天后其中值得保留的会自动晋升为长期记忆；也可以点上方「＋ 新增今日流水」手动记一笔。'));
  } else {
    for (const d of daily) {
      const grp = el('div', 'mem-day-group');
      const head = el('div', 'mem-day-head', '');
      head.appendChild(el('span', null, '📅 ' + d.date));
      head.appendChild(el('span', 'count', (d.entries || []).length + ' 条'));
      grp.appendChild(head);
      for (const e of (d.entries || []).slice().reverse()) grp.appendChild(memEntryCard(e, 'daily', d.date));
      dailyPanel.appendChild(grp);
    }
  }

  // 统计面板
  const statsPanel = $('#memoryStatsPanel');
  statsPanel.innerHTML = '';
  const grid = el('div', 'mem-stats-grid');
  const cards = [
    ['长期记忆', stats.longCount, '条'],
    ['每日流水', stats.dailyCount, '条'],
    ['流水天数', stats.dailyFiles, '天'],
    ['总体积', (stats.totalBytes || 0).toLocaleString(), 'B'],
    ['长期占比', stats.totalBytes ? Math.round((((j.long && j.long.size) || 0) / stats.totalBytes) * 100) : 0, '%'],
    ['蒸馏机制', '启用', '2天前自动晋升'],
  ];
  for (const [label, val, unit] of cards) {
    const c = el('div', 'mem-stat-card');
    c.appendChild(el('b', null, String(val)));
    const s = el('span', null, label + (unit ? ' · ' + unit : ''));
    c.appendChild(s);
    grid.appendChild(c);
  }
  statsPanel.appendChild(grid);
  statsPanel.appendChild(el('div', 'mem-empty', '分层说明：Agent 回复时用 <!-- MEMORY: ... --> 归档长期记忆，用 <!-- NOTE: ... --> 记当日流水；2 天前的流水中含「判准/偏好/基准」等关键词的段落会自动晋升到长期记忆并清理旧文件。', ''));
}

async function clearMemory() {
  if (!confirm('确定清空全部记忆（长期 + 流水）？此操作不可恢复。')) return;
  try {
    const res = await fetch('/api/memory/clear', { method: 'POST' });
    const j = await res.json();
    if (!res.ok || !j.ok) throw new Error(j.error || '清空失败');
    if (openMemory) { setTimeout(openMemory, 50); }
    renderStatus();
    toast('全部记忆已清空');
  } catch (e) {
    toast('清空失败：' + e.message);
  }
}

/* ================= 个人资料库 ================= */
const libState = { items: [], enabled: true, busy: false };

async function libApi(pathname, body) {
  // 统一兜底：HTTP 错误（含 4xx）也转成 { ok:false, error }，调用处直接判 ok
  try {
    return await fetchJSON(pathname, Object.assign({
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
    }, body ? { body: JSON.stringify(body) } : {}));
  } catch (e) {
    return { ok: false, error: e.message || '请求失败' };
  }
}

async function openLibrary() {
  $('#libraryModal').classList.remove('hidden');
  await refreshLibrary();
}

async function refreshLibrary() {
  try {
    const j = await libApi('/api/library');
    if (!j || !j.ok) throw new Error((j && j.error) || '读取失败');
    libState.items = j.items || [];
    libState.enabled = j.enabled !== false;
    const t = $('#libEnabledToggle');
    if (t) t.checked = libState.enabled;
    const meta = '共 ' + (j.count || 0) + ' 份 · ' + Number(j.totalChars || 0).toLocaleString() + ' 字';
    $('#libMeta').textContent = meta;
    $('#libCount').textContent = '共 ' + (j.count || 0) + ' 份';
    renderLibraryList();
    refreshLibOcrInfo();
  } catch (e) {
    $('#libMeta').textContent = '读取失败：' + e.message;
  }
}

function libItemCard(it) {
  const d = el('div', 'lib-item' + (it.enabled === false ? ' is-off' : ''));
  const head = el('div', 'lib-item-head');
  head.appendChild(el('span', 'lib-item-icon', fileIcon(it.name)));
  const nm = el('span', 'lib-item-name', it.name);
  nm.title = it.name;
  head.appendChild(nm);
  head.appendChild(el('span', 'lib-item-size', Number(it.charCount || 0).toLocaleString() + ' 字'));
  d.appendChild(head);
  if (it.preview) d.appendChild(el('div', 'lib-item-preview', it.preview));
  const meta = el('div', 'lib-item-meta');
  meta.appendChild(el('span', null, '🕘 ' + fmtTime(it.addedAt)));
  if (it.hasFile) meta.appendChild(el('span', null, '· ' + fmtFileSize(it.size || 0)));
  for (const tg of (it.tags || [])) meta.appendChild(el('span', 'lib-tag', tg));
  if (it.note) meta.appendChild(el('span', 'lib-tag', it.note));
  if (it.enabled === false) meta.appendChild(el('span', 'lib-tag warn', '已暂停召回'));
  d.appendChild(meta);
  const acts = el('div', 'lib-item-actions');
  const bPrev = el('button', 'btn ghost small', '预览');
  bPrev.type = 'button';
  bPrev.onclick = () => libPreview(it);
  const bUse = el('button', 'btn ghost small', it.enabled === false ? '恢复召回' : '暂停召回');
  bUse.type = 'button';
  bUse.onclick = async () => {
    const r = await libApi('/api/library/update', { id: it.id, enabled: it.enabled === false });
    if (r && r.ok) { toast(it.enabled === false ? '已恢复召回' : '已暂停召回'); await refreshLibrary(); }
    else toast('操作失败：' + ((r && r.error) || '未知错误'));
  };
  const bDel = el('button', 'btn ghost small danger', '删除');
  bDel.type = 'button';
  bDel.onclick = async () => {
    if (!window.confirm('确定从资料库删除《' + it.name + '》？此操作不可撤销。')) return;
    const r = await libApi('/api/library/delete', { id: it.id });
    if (r && r.ok) { toast('已删除'); await refreshLibrary(); }
    else toast('删除失败：' + ((r && r.error) || '未知错误'));
  };
  acts.appendChild(bPrev);
  acts.appendChild(bUse);
  acts.appendChild(bDel);
  d.appendChild(acts);
  return d;
}

function renderLibraryList() {
  const box = $('#libList');
  if (!box) return;
  box.innerHTML = '';
  const items = libState.items || [];
  if (!items.length) {
    box.appendChild(el('div', 'lib-empty', '资料库还是空的。上传一份备赛包或模辩文字稿，之后备赛 / 复盘时，Agent 会自动检索并优先引用你自己的口径和数据。'));
    return;
  }
  for (const it of items) box.appendChild(libItemCard(it));
}

async function libPreview(it) {
  try {
    const r = await fetchJSON('/api/library/doc?id=' + encodeURIComponent(it.id));
    if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
    mdReaderState = { path: '资料库 · 《' + it.name + '》', name: it.name, text: r.text || '' };
    $('#mdReaderTitle').textContent = '📚 ' + it.name;
    $('#mdReaderPath').textContent = '资料库 · ' + Number(r.charCount || 0).toLocaleString() + ' 字';
    $('#libraryModal').classList.add('hidden');
    $('#mdModal').classList.remove('hidden');
    renderMdReader();
  } catch (e) { toast('预览失败：' + e.message); }
}

async function libUploadFiles(files) {
  const list = Array.from(files || []).slice(0, 10);
  if (!list.length) return;
  if (libState.busy) { toast('还有文件在入库，请稍候'); return; }
  libState.busy = true;
  const box = $('#libUploadState');
  box.classList.remove('hidden');
  let ok = 0, fail = 0, failMsg = '';
  for (const file of list) {
    box.textContent = '正在入库：' + file.name + ' …';
    try {
      const b64 = await fileToBase64(file);
      const r = await libApi('/api/library/upload', { name: file.name, data: b64 });
      if (r && r.ok) ok++;
      else { fail++; failMsg = (r && r.error) || '未知错误'; }
    } catch (e) { fail++; failMsg = e.message; }
  }
  libState.busy = false;
  box.textContent = '入库完成：成功 ' + ok + ' 份' + (fail ? '，失败 ' + fail + ' 份（' + failMsg + '）' : '');
  toast('入库完成：成功 ' + ok + ' 份' + (fail ? '，失败 ' + fail + ' 份' : ''));
  await refreshLibrary();
}

async function libSavePaste() {
  const nameEl = $('#libPasteName');
  const textEl = $('#libPasteText');
  const name = (nameEl.value || '').trim();
  const text = textEl.value || '';
  if (!name) { toast('先给这份资料起个名字'); return; }
  if (!text.trim()) { toast('正文是空的'); return; }
  const r = await libApi('/api/library/upload', { name, text });
  if (r && r.ok) {
    toast('已存入资料库');
    nameEl.value = '';
    textEl.value = '';
    $('#libPasteForm').classList.add('hidden');
    await refreshLibrary();
  } else {
    toast('入库失败：' + ((r && r.error) || '未知错误'));
  }
}

async function libDoSearch() {
  const q = ($('#libSearchInput').value || '').trim();
  const box = $('#libSearchResults');
  if (!q) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.textContent = '检索中…';
  const r = await libApi('/api/library/search', { query: q });
  box.innerHTML = '';
  if (!r || !r.ok) { box.textContent = '检索失败：' + ((r && r.error) || '未知错误'); return; }
  if (!r.count) { box.textContent = '没有命中。换个说法试试，或检查该资料是否处于「暂停召回」状态。'; return; }
  const head = el('div', 'lib-hit-head', '命中 ' + r.count + ' 份（这就是 Agent 会看到的片段）');
  box.appendChild(head);
  for (const h of r.hits) {
    const c = el('div', 'lib-hit');
    const t = el('div', 'lib-hit-title', '');
    t.appendChild(el('b', null, '《' + h.name + '》'));
    t.appendChild(el('span', 'lib-hit-score', '相关度 ' + h.score));
    c.appendChild(t);
    c.appendChild(el('div', 'lib-hit-snippet', h.snippet || ''));
    box.appendChild(c);
  }
}

async function refreshLibOcrInfo() {
  const box = $('#libOcrInfo');
  if (!box) return;
  try {
    const r = await libApi('/api/library/ocr');
    if (r && r.available) {
      box.textContent = '🖼 图片 OCR：可用（' + (r.lang || '系统默认语言') + '）· 拖入截图会自动识别文字，全程在本机完成';
      box.className = 'lib-ocr-info ok';
    } else {
      box.textContent = '🖼 图片 OCR：不可用' + (r && r.reason ? '（' + r.reason + '）' : '') + '。图片资料请先 OCR 后粘贴文本。';
      box.className = 'lib-ocr-info warn';
    }
  } catch (_) { /* 静默 */ }
}

async function loadLibSynonyms() {
  const ta = $('#libSynonymsText');
  if (!ta || ta.value.trim()) return;
  const r = await libApi('/api/library/synonyms');
  const groups = (r && r.groups) || [];
  ta.value = groups.map((g) => (Array.isArray(g) ? g.join(',') : String(g))).join('\n');
}

async function saveLibSynonyms() {
  const ta = $('#libSynonymsText');
  if (!ta) return;
  const r = await libApi('/api/library/synonyms', { text: ta.value });
  if (r && r.ok) toast('同义词已保存：' + (r.count || 0) + ' 组');
  else toast('保存失败：' + ((r && r.error) || '未知错误'));
}

async function resetLibSynonyms() {
  const ta = $('#libSynonymsText');
  if (!ta) return;
  if (!window.confirm('恢复为内置默认同义词表？你的自定义分组会被覆盖。')) return;
  ta.value = '';
  await loadLibSynonyms();
  toast('已恢复默认（点「保存同义词」生效）');
}

function bindLibrary() {
  const btn = $('#btnLibrary');
  if (btn) btn.onclick = openLibrary;
  const pick = $('#btnLibPick');
  const input = $('#libFileInput');
  if (pick && input) pick.onclick = () => input.click();
  if (input) {
    input.onchange = () => {
      if (input.files && input.files.length) libUploadFiles(input.files);
      input.value = '';
    };
  }
  const drop = $('#libDrop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('dragover');
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
      if (files.length) libUploadFiles(files);
    });
  }
  const btnSynSave = $('#btnLibSynSave');
  if (btnSynSave) btnSynSave.onclick = saveLibSynonyms;
  const btnSynReset = $('#btnLibSynReset');
  if (btnSynReset) btnSynReset.onclick = resetLibSynonyms;
  const synPanel = document.querySelector('.lib-synonyms');
  if (synPanel) synPanel.addEventListener('toggle', () => { if (synPanel.open) loadLibSynonyms(); });
  const btnPaste = $('#btnLibPaste');
  if (btnPaste) btnPaste.onclick = () => {
    const form = $('#libPasteForm');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) $('#libPasteName').focus();
  };
  const btnPasteCancel = $('#btnLibPasteCancel');
  if (btnPasteCancel) btnPasteCancel.onclick = () => $('#libPasteForm').classList.add('hidden');
  const btnPasteSave = $('#btnLibPasteSave');
  if (btnPasteSave) btnPasteSave.onclick = libSavePaste;
  const btnSearch = $('#btnLibSearch');
  if (btnSearch) btnSearch.onclick = libDoSearch;
  const searchInput = $('#libSearchInput');
  if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); libDoSearch(); } });
  const toggle = $('#libEnabledToggle');
  if (toggle) {
    toggle.onchange = async () => {
      const r = await libApi('/api/library/config', { enabled: toggle.checked });
      if (r && r.ok) { libState.enabled = r.enabled; toast(r.enabled ? '已开启：备赛 / 复盘会自动检索资料库' : '已关闭：本次起不再自动检索资料库'); }
      else { toggle.checked = !toggle.checked; toast('设置失败：' + ((r && r.error) || '未知错误')); }
    };
  }
}

/* ================= 使用统计 ================= */
function collectStats() {
  const chats = state.chats || [];
  let totalMsgs = 0, input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  const dayCount = {}; // 'YYYY-MM-DD' -> 消息数
  for (const c of chats) {
    const msgs = c.messages || [];
    for (const m of msgs) {
      totalMsgs++;
      const u = m.usageTotal || {};
      input += Number(u.input) || 0;
      output += Number(u.output) || 0;
      cacheRead += Number(u.cacheRead) || 0;
      cacheWrite += Number(u.cacheWrite) || 0;
      if (m.time) {
        const d = new Date(m.time);
        if (!isNaN(d)) {
          const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
          dayCount[key] = (dayCount[key] || 0) + 1;
        }
      }
    }
  }
  const saved = cacheRead; // 缓存读取 = 节省的 token
  return { chats: chats.length, msgs: totalMsgs, input, output, cacheRead, cacheWrite, saved, dayCount };
}

function fmtToken(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
  return String(n);
}

function renderStatsHeatmap(dayCount) {
  const box = $('#statsHeatmap');
  box.innerHTML = '';
  const today = new Date();
  // 从 12 周前（对齐周一）到今天
  const start = new Date(today);
  start.setDate(today.getDate() - (12 * 7 - 1));
  const dow = start.getDay() === 0 ? 7 : start.getDay();
  start.setDate(start.getDate() - (dow - 1));
  let max = 1;
  for (const k in dayCount) if (dayCount[k] > max) max = dayCount[k];
  const cols = [];
  const cur = new Date(start);
  while (cur <= today) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cur);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      week.push({ key, n: dayCount[key] || 0, future: d > today });
      cur.setDate(cur.getDate() + 1);
    }
    cols.push(week);
  }
  // 月标签行 + 7 行星期
  const headRow = el('div', 'stats-headrow', '');
  headRow.appendChild(el('span', 'stats-day', ''));
  for (let ci = 0; ci < cols.length; ci++) {
    const m0 = Number(cols[ci][0].key.slice(5, 7));
    let label = '';
    if (ci > 0 && m0 !== Number(cols[ci - 1][0].key.slice(5, 7))) label = String(m0) + '月';
    else if (ci === 0) label = String(m0) + '月';
    headRow.appendChild(el('span', 'stats-month', label));
  }
  box.appendChild(headRow);
  // 行 = 星期（一~日），每行循环所有列
  const dayLbl = ['一', '', '', '四', '', '六', ''];
  for (let r = 0; r < 7; r++) {
    const row = el('div', 'stats-row', '');
    row.appendChild(el('span', 'stats-day', dayLbl[r]));
    for (let ci = 0; ci < cols.length; ci++) {
      const cell = cols[ci][r];
      if (!cell) { row.appendChild(el('span', 'stats-cell')); continue; }
      const c = el('span', 'stats-cell');
      if (cell.n > 0) {
        const lvl = cell.n >= max ? 4 : cell.n >= max * 0.66 ? 3 : cell.n >= max * 0.33 ? 2 : 1;
        c.classList.add('l' + lvl);
      }
      if (cell.future) c.classList.add('future');
      c.title = cell.key + '：' + cell.n + ' 条消息';
      row.appendChild(c);
    }
    box.appendChild(row);
  }
}
function renderStatsCards(s) {
  const grid = $('#statsGrid');
  grid.innerHTML = '';
  const cards = [
    ['💬', fmtToken(s.msgs), '总消息数'],
    ['🗂', String(s.chats), '总对话数'],
    ['🔢', fmtToken(s.input), '输入 Token'],
    ['📤', fmtToken(s.output), '输出 Token'],
    ['⚡', fmtToken(s.saved), '缓存节省 Token'],
    ['🧩', fmtToken(s.cacheWrite), '缓存写入'],
  ];
  for (const [ic, val, label] of cards) {
    const c = el('div', 'stats-card');
    c.appendChild(el('div', 'sc-icon', ic));
    c.appendChild(el('div', 'sc-val', val));
    c.appendChild(el('div', 'sc-label', label));
    grid.appendChild(c);
  }
}

function renderStatsPane() {
  const s = collectStats();
  renderStatsHeatmap(s.dayCount);
  renderStatsCards(s);
  renderStatsLegend();
}

/* ================= 个人数据备份（导出 / 导入） ================= */
async function exportBackup() {
  const out = $('#backupResult');
  const btn = $('#btnExportBackup');
  try {
    if (btn) btn.disabled = true;
    if (out) { out.textContent = '正在打包数据…'; out.className = 'settings-result'; }
    const r = await fetchJSON('/api/backup/export');
    if (!r || !r.ok || !r.backup) throw new Error((r && r.error) || '导出失败');
    const st = r.stats || {};
    const summary = '包含 ' + (st.chats || 0) + ' 个对话、' + (st.memoryDaily || 0) + ' 天记忆流水、' + (st.profiles || 0) + ' 套模型配置';
    // 含 API Key，明确提示
    const warn = '⚠️ 备份文件包含你的 API Key，请妥善保管，不要发给别人。\n\n' + summary + '\n\n继续导出？';
    if (!confirm(warn)) { if (out) out.textContent = ''; return; }
    const json = JSON.stringify(r.backup, null, 2);
    const ae = window.academyElectron;
    if (ae && ae.saveBackupFile) {
      const res = await ae.saveBackupFile(json, 'academy-backup-' + new Date().toISOString().slice(0, 10) + '.json');
      if (res && res.canceled) { if (out) out.textContent = ''; return; }
      if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');
      if (out) {
        out.innerHTML = '✅ 已导出到：<br><code>' + esc(res.path) + '</code><br>' + esc(summary) +
          ' <button type="button" class="link-btn" id="btnShowBackupFolder">打开所在文件夹</button>';
        out.className = 'settings-result ok';
        const sb = $('#btnShowBackupFolder');
        if (sb && ae.showInFolder) sb.onclick = () => ae.showInFolder(res.path);
      }
    } else {
      // 非 Electron 环境：浏览器下载
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'academy-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      if (out) { out.textContent = '✅ 已下载备份文件\n' + summary; out.className = 'settings-result ok'; }
    }
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'settings-result err'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function importBackup() {
  const out = $('#backupResult');
  const btn = $('#btnImportBackup');
  try {
    const ae = window.academyElectron;
    if (!ae || !ae.openBackupFile) { if (out) { out.textContent = '当前环境不支持文件选择，请使用桌面版。'; out.className = 'settings-result err'; } return; }
    if (btn) btn.disabled = true;
    const picked = await ae.openBackupFile();
    if (!picked || picked.canceled) return;
    if (!picked.ok) throw new Error(picked.error || '读取文件失败');
    let parsed;
    try { parsed = JSON.parse(picked.text); } catch (_) { throw new Error('不是合法的备份文件（JSON 解析失败）'); }
    const b = parsed && parsed.backup ? parsed.backup : parsed;
    const st = {
      chats: Array.isArray(b.chats) ? b.chats.length : 0,
      daily: (b.memory && b.memory.daily) ? Object.keys(b.memory.daily).length : 0,
      profiles: (b.profiles && Array.isArray(b.profiles.profiles)) ? b.profiles.profiles.length : 0,
    };
    const ok = confirm('将导入：' + st.chats + ' 个对话、' + st.daily + ' 天记忆、' + st.profiles + ' 套模型配置。\n\n当前数据会先自动备份到 data/_backup_* 文件夹，然后被导入内容替换。\n\n继续？');
    if (!ok) return;
    if (out) { out.textContent = '正在导入…'; out.className = 'settings-result'; }
    const r = await fetchJSON('/api/backup/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: picked.text,
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '导入失败');
    const rr = r.result || {};
    if (out) {
      out.textContent = '✅ 导入完成：' + (rr.chats || 0) + ' 个对话、' + (rr.memoryDaily || 0) + ' 天记忆、' + (rr.profiles || 0) + ' 套配置\n旧数据已备份到 data/' + (r.backupDir || '_backup_*');
      out.className = 'settings-result ok';
    }
    toast('导入完成，正在重新加载…');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'settings-result err'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* 热力图图例：少 → 多 五级色阶 */
function renderStatsLegend() {
  const box = document.querySelector('.stats-legend-cells');
  if (!box) return;
  box.innerHTML = '';
  const lv = ['', 'l1', 'l2', 'l3', 'l4'];
  for (const l of lv) {
    const c = el('span', 'stats-cell' + (l ? ' ' + l : ''));
    box.appendChild(c);
  }
}

/* 压缩上下文：把当前对话交给模型生成摘要，然后替换为一条摘要消息 */
async function compactContext() {
  if (state.running) { toast('有任务正在运行，请稍后再压缩'); return; }
  const msgs = state.messages || [];
  if (msgs.length < 2) { toast('当前对话太短，不需要压缩'); return; }
  if (!state.status || !state.status.hasKey) { openSettings(); return; }
  if (!confirm('将把当前 ' + msgs.length + ' 条消息压缩成一份摘要并替换当前对话（不可直接恢复），确定继续？')) return;

  const transcript = msgs.map((m) => (m.role === 'user' ? '用户：' : '教练：') + (m.text || '')).join('\n\n');
  const prompt = '【上下文管理任务，不是辩论任务】请把下面这段对话压缩成一份结构化的上下文摘要，要求：\n' +
    '1. 保留：辩题/任务、持方、已讨论的核心观点、关键论据与来源链接、未完成事项；\n' +
    '2. 用中文，不超过 800 字；\n' +
    '3. 只输出摘要正文，不要额外解释。\n\n' + transcript;

  state.running = true;
  state.status = { ...(state.status || {}), busy: true };
  renderStatus();
  $('#btnSend').disabled = true;
  toast('正在压缩上下文…');

  let sum = '';
  try {
    await streamChat('free', prompt, [], (event, data) => {
      if (event === 'delta') { sum += (data.text || ''); }
      else if (event === 'error') { throw new Error(data.message || '压缩失败'); }
    });
    sum = sum.trim();
    if (!sum) throw new Error('压缩结果为空');
    state.messages = [{ role: 'user', text: '【上下文摘要】' + sum, time: Date.now() }];
    persistChat();
    renderMessages();
    renderHistory();
    toast('✅ 上下文已压缩为摘要');
  } catch (e) {
    toast('压缩失败：' + e.message + '（原对话未改动）');
  } finally {
    state.running = false;
    state.status = { ...(state.status || {}), busy: false };
    renderStatus();
    $('#btnSend').disabled = false;
    $('#btnSend').classList.remove('hidden');
    $('#btnStop').classList.add('hidden');
  }
}

/* ================= 事件绑定 ================= */
function bindEvents() {
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.onclick = () => {
      if (state.running) { toast('Agent 正在工作中，请先停止或等待完成再切换模式'); return; }
      if (state.messages.length && state.messages.some((m) => m.running)) { toast('当前会话仍在生成，无法切换模式'); return; }
      switchMode(b.dataset.mode);
    };
  });
  $('#btnNew').onclick = () => newChat(state.mode);
  $('#btnSettings').onclick = openSettings;
  $('#btnTools').onclick = () => $('#toolsModal').classList.remove('hidden');
  $('#btnMemory').onclick = openMemory;
  bindLibrary();
  $('#btnMemoryClear').onclick = clearMemory;
  bindSkillsUI();
  bindDeliverables();
  bindExtTools();
  // 重新查看新手引导
  const btnWiz = $('#btnShowWizard');
  if (btnWiz) btnWiz.onclick = () => { $('#settingsModal').classList.add('hidden'); openWelcome(1); };
  // 数据备份：导出 / 导入
  const btnExp = $('#btnExportBackup');
  if (btnExp) btnExp.onclick = exportBackup;
  const btnImp = $('#btnImportBackup');
  if (btnImp) btnImp.onclick = importBackup;
  // 记忆中心 Tab 切换
  document.querySelectorAll('.memory-tab').forEach((b) => {
    b.onclick = () => {
      memoryTab = b.dataset.mtab;
      document.querySelectorAll('.memory-tab').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.memory-panel').forEach((p) => p.classList.toggle('active', p.id === ('memory' + (b.dataset.mtab === 'daily' ? 'Daily' : b.dataset.mtab === 'stats' ? 'Stats' : 'Long') + 'Panel')));
    };
  });
  $('#btnCompact').onclick = compactContext;
  // Ctrl/Cmd+A：焦点在输入框/设置输入项时交给浏览器默认（只全选该框内容）；
  // 否则把全选收窄到对话内容，避免把整页 UI 的字都框进去。
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'a') return;
    const ae = document.activeElement;
    const inField = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable);
    if (inField) return;
    e.preventDefault();
    const box = $('#messages');
    if (!box || !box.children.length) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(box);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  bindExportMenu();
  $('#btnClearHistory').onclick = () => {
    const modeName = (MODES[state.mode] || {}).title || state.mode;
    if (!confirm('清空「' + modeName + '」模式下的全部对话历史？其他模式不受影响。')) return;
    // 只删当前模式的对话，其他模式不受影响
    state.chats = state.chats.filter((c) => c.mode !== state.mode);
    state.chatId = null;
    state.messages = [];
    state.chatIdByMode[state.mode] = null;
    saveChats();
    renderHistory();
    renderMessages();
  };
  // 叉号关闭：先逐按钮绑定，再用 document 级事件委托兜底，
  // 即使个别按钮绑定失败/后续动态添加的弹窗，点击也一定生效
  document.querySelectorAll('.modal-close').forEach((b) => {
    b.onclick = () => { const m = document.getElementById(b.dataset.close); if (m) m.classList.add('hidden'); };
  });
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest ? e.target.closest('.modal-close') : null;
    if (closeBtn) {
      const targetId = closeBtn.dataset && closeBtn.dataset.close;
      if (targetId) {
        const m = document.getElementById(targetId);
        if (m) m.classList.add('hidden');
        return;
      }
    }
    // 点击弹窗背景关闭
    if (e.target && e.target.classList && e.target.classList.contains('modal')) {
      e.target.classList.add('hidden');
    }
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });

  // 通用设置：外观（浅色/深色/跟随系统）
  document.querySelectorAll('#themeChoices .gen-choice').forEach((b) => {
    b.onclick = () => setTheme(b.dataset.themeVal);
  });
  // 通用设置：界面语言（简体/繁体）
  document.querySelectorAll('#localeChoices .gen-choice').forEach((b) => {
    b.onclick = () => {
      setLocale(b.dataset.localeVal === 'zh-TW' ? 'zh-TW' : 'zh-CN');
      toast(b.dataset.localeVal === 'zh-TW' ? '已切換為繁體中文' : '已切换为简体中文');
    };
  });
  // 通用设置：对话字体大小（滑块，实时预览）
  const fsRange = document.getElementById('chatFontRange');
  const fsReset = document.getElementById('btnResetFont');
  if (fsRange) fsRange.addEventListener('input', () => setChatFs(fsRange.value));
  if (fsReset) fsReset.onclick = () => { setChatFs(CHAT_FS_DEFAULT); toast('已恢复默认字号 15px'); };
  applyChatFs();
  // 设置二级导航：切换分组标签 → 切换右侧面板
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.onclick = () => switchSettingsPane(btn.dataset.settingsPane);
  });

  // 侧边栏收起 / 展开
  const sidebarToggle = $('#sidebarToggle');
  if (sidebarToggle) {
    const SIDEBAR_LS = 'academy.sidebar.collapsed';
    const applyCollapsed = (collapsed) => {
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      sidebarToggle.textContent = collapsed ? '▶' : '◀';
      sidebarToggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
    };
    try { applyCollapsed(localStorage.getItem(SIDEBAR_LS) === '1'); } catch (_) {}
    sidebarToggle.onclick = () => {
      const collapsed = !document.body.classList.contains('sidebar-collapsed');
      applyCollapsed(collapsed);
      try { localStorage.setItem(SIDEBAR_LS, collapsed ? '1' : '0'); } catch (_) {}
    };
  }
  $('#btnAttach').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    if (files.length > 10) { toast('一次最多上传 10 个文件'); return; }
    files.forEach((file, i) => setTimeout(() => attachFile(file), i * 60));
  };

  const input = $('#input');
  input.addEventListener('input', () => { updateCharCount(); autoGrow(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  });

  const btnSendEl = $('#btnSend');
  if (btnSendEl) btnSendEl.onclick = () => { if (!state.running) sendMessage(); };
  const btnStopEl = $('#btnStop');
  if (btnStopEl) btnStopEl.onclick = stopRun;

  $('#btnToggleKey').onclick = () => {
    const k = $('#apiKeyInput');
    k.type = k.type === 'password' ? 'text' : 'password';
  };
  // 搜索方式：服务侧 / 端侧
  document.querySelectorAll('#searchModeChoices .gen-choice').forEach((b) => {
    b.onclick = () => setSearchMode(b.dataset.searchMode);
  });
  bindProviderCards();
  try { bindAboutPane(); } catch (_) {}
  bindComposerModelSelect();
  // 多配置档案：保存 / 新建
  const btnSaveProf = $('#btnSaveProfile');
  if (btnSaveProf) btnSaveProf.onclick = saveCurrentProfile;
  const btnNewProf = $('#btnNewProfile');
  if (btnNewProf) btnNewProf.onclick = () => { clearProfileEditor(); renderProfilesList(); };
  $('#btnClearKey').onclick = async () => {
    if (!confirm('清除当前配置保存的 API Key？（留空保存也可让 Key 不被覆盖）')) return;
    try {
      if (state.editingProfileId) {
        // 更新为无 Key（不能真删字段，置空则服务端保留旧 key；这里改为提示用留空方式）
        await fetchJSON('/api/profiles/' + encodeURIComponent(state.editingProfileId), {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: null }),
        });
      }
      $('#apiKeyInput').value = '';
      $('#apiKeyInput').placeholder = 'sk-...';
      const out = $('#settingsResult');
      if (out) { out.textContent = 'Key 已清除（保存时留空即保持无 Key）。'; out.className = 'settings-result ok'; }
      await loadProfilesUI();
      await refreshStatus();
    } catch (e) {
      const out = $('#settingsResult');
      if (out) { out.textContent = '❌ ' + e.message; out.className = 'settings-result err'; }
    }
  };
  const btnLoad = $('#btnLoadModels');
  if (btnLoad) btnLoad.onclick = loadModels;
  const modelSel = $('#modelSelect');
  if (modelSel) modelSel.onchange = () => { if (modelSel.value) $('#modelInput').value = modelSel.value; };
  $('#btnTestKey').onclick = async () => {
    const apiKey = $('#apiKeyInput').value.trim();
    const model = currentModelValue();
    const baseUrl = currentBaseUrlValue();
    const out = $('#settingsResult');
    out.textContent = '正在连接 ' + baseUrl + ' …';
    out.className = 'settings-result';
    try {
      const r = await fetchJSON('/api/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model, baseUrl }),
      });
      out.textContent = r.ok ? '✅ ' + r.message : '❌ ' + r.message;
      out.className = 'settings-result ' + (r.ok ? 'ok' : 'err');
    } catch (e) {
      out.textContent = '❌ ' + e.message;
      out.className = 'settings-result err';
    }
  };
  $('#bannerToSettings').onclick = openSettings;
}

/* ================= 欢迎引导 ================= */
/* ================= 首次使用向导 ================= */
let _wizardStep = 1;

function showWizardStep(n) {
  _wizardStep = Math.max(1, Math.min(4, Number(n) || 1));
  document.querySelectorAll('#welcomeModal .wizard-pane').forEach((p) => {
    p.classList.toggle('active', Number(p.dataset.wstep) === _wizardStep);
  });
  document.querySelectorAll('#welcomeModal .wp-dot').forEach((d, i) => {
    d.classList.toggle('active', i < _wizardStep);
  });
  if (_wizardStep === 3) {
    setTimeout(() => { const i = $('#wizardKeyInput'); if (i) i.focus(); }, 80);
  }
}

function openWelcome(startStep) {
  const m = $('#welcomeModal');
  if (!m) return;
  m.classList.remove('hidden');
  showWizardStep(startStep || 1);
  const res = $('#wizardKeyResult');
  if (res) { res.textContent = ''; res.className = 'settings-result'; }

  // 步骤切换按钮
  m.querySelectorAll('[data-wnext]').forEach((b) => {
    b.onclick = () => showWizardStep(Number(b.dataset.wnext));
  });
  // 打开申请页面
  const site = $('#wizardOpenSite');
  if (site) site.onclick = () => {
    try { window.open('https://platform.deepseek.com/api_keys', '_blank'); }
    catch (_) { toast('请手动访问 platform.deepseek.com'); }
  };
  // 显示/隐藏 Key
  const toggle = $('#wizardToggleKey');
  if (toggle) toggle.onclick = () => {
    const k = $('#wizardKeyInput');
    if (k) k.type = k.type === 'password' ? 'text' : 'password';
  };
  // 回车提交
  const keyInput = $('#wizardKeyInput');
  if (keyInput) keyInput.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); wizardTestAndSave(); }
  };
  // 高级选项
  bindWizardAdvanced();
  // 测试并保存
  const testBtn = $('#wizardTestBtn');
  if (testBtn) testBtn.onclick = () => wizardTestAndSave();
  // 完成
  const done = $('#wizardDoneBtn');
  if (done) done.onclick = () => {
    localStorage.setItem('academy_welcomed', '1');
    m.classList.add('hidden');
    focusInput();
  };
  // 点右上角 × 关闭也算"看过了"，避免每次都弹
  const closeBtn = m.querySelector('.modal-close');
  if (closeBtn) {
    const prev = closeBtn.onclick;
    closeBtn.onclick = (e) => {
      localStorage.setItem('academy_welcomed', '1');
      if (typeof prev === 'function') prev.call(closeBtn, e);
    };
  }
}

/* 向导高级选项：服务商 → 自动填地址/模型 */
const WIZARD_PROVIDERS = {
  deepseek:    { baseUrl: 'https://api.deepseek.com',            models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat'], name: 'DeepSeek 官方' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1',       models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'], name: '硅基流动' },
  moonshot:    { baseUrl: 'https://api.moonshot.cn/v1',          models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], name: 'Moonshot Kimi' },
  zhipu:       { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'], name: '智谱 GLM' },
  openai:      { baseUrl: 'https://api.openai.com/v1',           models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'], name: 'OpenAI' },
  custom:      { baseUrl: '',                                     models: [], name: '自定义配置' },
};

function bindWizardAdvanced() {
  const sel = $('#wizardProvider');
  const urlInput = $('#wizardBaseUrl');
  const modelInput = $('#wizardModel');
  const preset = $('#wizardModelPresets');
  if (!sel || !urlInput || !modelInput) return;
  const applyProvider = (id) => {
    const p = WIZARD_PROVIDERS[id];
    if (!p) return;
    if (id === 'custom') {
      // 自定义：清空让用户自己填，并聚焦地址框
      urlInput.value = '';
      modelInput.value = '';
      if (preset) preset.innerHTML = '';
      setTimeout(() => urlInput.focus(), 50);
      return;
    }
    urlInput.value = p.baseUrl;
    if (preset) preset.innerHTML = p.models.map((m) => '<option value="' + m + '"></option>').join('');
    if (p.models.length) modelInput.value = p.models[0];
  };
  sel.onchange = () => applyProvider(sel.value);
  applyProvider(sel.value);
}

/* 向导内：验证 Key 并保存为配置 */
async function wizardTestAndSave() {
  const out = $('#wizardKeyResult');
  const btn = $('#wizardTestBtn');
  const key = ($('#wizardKeyInput') && $('#wizardKeyInput').value || '').trim();
  if (!key) {
    if (out) { out.textContent = '请先粘贴你的 API Key（sk- 开头）。'; out.className = 'settings-result err'; }
    return;
  }
  if (!/^sk-/i.test(key)) {
    if (out) { out.textContent = '看起来不像 API Key（应以 sk- 开头），请检查是否复制完整。'; out.className = 'settings-result err'; }
    return;
  }
  // 高级选项展开时，用里面的地址/模型/名称
  const adv = $('#wizardAdvanced');
  const advOpen = !!(adv && adv.open);
  const providerId = ($('#wizardProvider') && $('#wizardProvider').value) || 'deepseek';
  const providerMeta = WIZARD_PROVIDERS[providerId] || WIZARD_PROVIDERS.deepseek;
  let baseUrl = advOpen ? (($('#wizardBaseUrl') && $('#wizardBaseUrl').value || '').trim()) : 'https://api.deepseek.com';
  let model = advOpen ? (($('#wizardModel') && $('#wizardModel').value || '').trim()) : 'deepseek-flash';
  const profileName = (advOpen && $('#wizardProfileName') && $('#wizardProfileName').value.trim()) || providerMeta.name || '我的配置';
  if (!baseUrl) baseUrl = 'https://api.deepseek.com';
  if (!model) model = 'deepseek-flash';
  if (advOpen && !/^https?:\/\//i.test(baseUrl)) {
    if (out) { out.textContent = 'API 地址要以 http:// 或 https:// 开头。'; out.className = 'settings-result err'; }
    return;
  }
  try {
    if (btn) { btn.disabled = true; btn.textContent = '正在验证…'; }
    if (out) { out.textContent = '正在连接 DeepSeek 验证 Key…'; out.className = 'settings-result'; }
    // 1) 验证
    const r = await fetchJSON('/api/test-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key, model, baseUrl }),
    });
    if (!r.ok) throw new Error(r.message || 'Key 验证失败');
    // 2) 保存为配置档案并激活
    const save = await fetchJSON('/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: profileName, baseUrl, model, apiKey: key }),
    });
    if (!save.ok) throw new Error(save.error || '保存失败');
    if (out) { out.textContent = '✅ 验证通过，已保存！'; out.className = 'settings-result ok'; }
    await refreshStatus();
    await loadProfilesUI();
    setTimeout(() => showWizardStep(4), 500);
  } catch (e) {
    if (out) { out.textContent = '❌ ' + e.message; out.className = 'settings-result err'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔌 测试并保存'; }
  }
}

/* ================= 初始化 ================= *//* ================= 初始化 ================= */
function init() {
  try {
    bindEvents();
  } catch (e) {
    // 旧缓存页面缺少新控件时，也保证状态检测继续执行
    console.error('[Academy] 绑定控件失败（请刷新页面或 Ctrl+F5 强制刷新）:', e);
  }
  // 应用外观 + 界面语言
  try { applyTheme(); } catch (_) {}
  try { applyChatFs(); } catch (_) {}
  try { syncLocaleChoices(); } catch (_) {}
  try { applyLocaleToStatic(); } catch (_) {}
  updateModeUI();
  renderTools();
  renderHistory();
  renderMessages();
  // 异步加载对话历史（文件存储；首次运行会自动迁移旧 localStorage 数据）
  loadChatsAsync().then((chats) => {
    const existing = state.chats || [];
    if (existing.length) {
      // 加载期间用户已新建/操作对话 → 合并而非覆盖（内存优先）
      const byId = new Map();
      for (const c of chats) if (c && c.id) byId.set(c.id, c);
      for (const c of existing) if (c && c.id) byId.set(c.id, c);
      state.chats = Array.from(byId.values());
      saveChats();
    } else {
      state.chats = chats;
    }
    renderHistory();
  }).catch(() => {});
  // 附件区初始渲染
  try { renderAttachments(); } catch (_) {}
  // 拖拽 / 粘贴文件上传
  try { bindDragDrop(); } catch (_) {}
  try { bindMdReader(); } catch (_) {}
  try { bindHistorySearch(); } catch (_) {}
  // 工具页（辩案工作台/简易流水单）「发到主窗口」：storage 事件只在同源的其他窗口触发，
  // 主窗口收到后把内容填进输入框，用户选好模式自己发
  try {
    window.addEventListener('storage', (e) => {
      if (e.key !== 'academy.handoff.v1' || !e.newValue) return;
      try {
        const d = JSON.parse(e.newValue);
        if (!d || !d.text) return;
        const ta = $('#input');
        ta.value = d.text;
        try { updateCharCount(); } catch (_) {}
        ta.focus();
        toast('收到来自「' + (d.from || '工具页') + '」的内容，已填入输入框，选好模式后发送即可');
      } catch (_) {}
    });
  } catch (_) {}
  // 载入多配置档案（填充对话区模型切换下拉等）
  try { loadProfilesUI(); } catch (_) {}
  refreshStatus().then(() => {
    // 首次使用：没有 Key 时弹出引导
    if (state.status && !state.status.hasKey) {
      if (!localStorage.getItem('academy_welcomed')) {
        setTimeout(openWelcome, 350);
      } else {
        setTimeout(openSettings, 350);
      }
    }
  });
  setInterval(() => { if (!state.running) refreshStatus(); }, 15000);
}

init();