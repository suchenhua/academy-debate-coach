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
  judge: { title: '评判', desc: '三票制评分 + 九段式述票。需提供带明确发言人的完整文字转写——腾讯会议转写几乎无可替代。',
    placeholder: '评判 · 粘贴带明确发言人的完整文字转写——腾讯会议转写自带逐句发言人标注，几乎无可替代（Ctrl+Enter 发送）', prompts: [
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
}
/* ———— 界面语言（简体 / 繁体 / English） ———— */
const LOCALE_LS = 'academy.locale.v1';
function restoreLocale() {
  try {
    const v = localStorage.getItem(LOCALE_LS);
    return v === 'zh-TW' ? 'zh-TW' : v === 'en' ? 'en' : 'zh-CN';
  } catch (_) { return 'zh-CN'; }
}
function setLocale(val) {
  const norm = val === 'zh-TW' ? 'zh-TW' : val === 'en' ? 'en' : 'zh-CN';
  const prev = restoreLocale();
  try { localStorage.setItem(LOCALE_LS, norm); } catch (_) {}
  syncLocaleToConfig(norm);
  // 中英互切走整页重载：英文是词条覆盖替换，页内反向还原不可靠；重载后由 init + 观察器重新铺英文
  if ((prev === 'en') !== (norm === 'en')) {
    try { document.documentElement.lang = norm; } catch (_) {}
    location.reload();
  }
  document.documentElement.lang = norm;
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
/* 语言上下文同步进 data/config.json：阅读器/工具窗没有 localStorage，
   从 config 取语言（文件关联启动的 MD 阅读器英文模式就靠这条链路） */
function syncLocaleToConfig(norm) {
  const body = JSON.stringify({ locale: norm });
  try {
    // sendBeacon：请求由浏览器保证送达，紧跟着整页重载也不丢（中英互切路径）
    if (navigator.sendBeacon) { navigator.sendBeacon('/api/config', new Blob([body], { type: 'application/json' })); return; }
  } catch (_) {}
  try { fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {}); } catch (_) {}
}
/* 启动对账（只一次）：老版本语言只存 localStorage，config 里的 locale 可能还是默认值；
   不一致时以 localStorage 为准写回 config */
async function reconcileLocaleOnce() {
  try {
    const r = await fetchJSON('/api/config');
    const c = (r && r.config) || null;
    if (c && c.locale !== restoreLocale()) syncLocaleToConfig(restoreLocale());
  } catch (_) {}
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
  closeBehavior: 'ask', // 点关闭按钮做什么：ask 每次询问 / quit 退出 / tray 收进托盘（真正执行的是 Electron 主进程）
};

/* ================= 工具函数 ================= */
function $(sel) { return document.querySelector(sel); }
/* 图标通道的唯一判据（2026-10-14 前端体检 F5）：整段字符串必须以 icons.js 生成的
   那种「死形状」开头——属性顺序、stroke-width、#i- 引用全部写死在正则里。
   旧判据只看前四个字符是不是 <svg，于是正文、文件名、对话标题只要恰好以 <svg 开头
   就会被交给 HTML 解析器。改成白名单形状后，外部字符串怎么拼都进不了标记通道。 */
const ICON_SHAPE_RE = /^<svg class="ic(?: [A-Za-z0-9_-]+)*" width="\d+" height="\d+" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.75" stroke-linecap="round" stroke-linejoin="round" (?:role="img" aria-label="[^"]*"|aria-hidden="true")><use href="#i-[A-Za-z0-9]+"><\/use><\/svg>/;

/* esc() 的逆运算。调用方习惯把「图标 + 已转义文字」拼在一起交给 el()，
   现在文字走 textContent，必须先把实体还原回去，否则 &amp; 会显示成字面量。
   &amp; 放到最后解，与 esc() 先替 & 的顺序严格对应。 */
function unesc(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) richText(n, text);
  return n;
}

/* 只有「icons.js 图标 + 纯文字」这一种组合允许出现标记，其余一律 textContent。
   从此没有任何路径把外部字符串交给 HTML 解析器。 */
function richText(node, value) {
  if (typeof value !== 'string') { node.textContent = value == null ? '' : String(value); return; }
  const m = ICON_SHAPE_RE.exec(value);
  if (!m) { node.textContent = value; return; }
  node.insertAdjacentHTML('beforeend', m[0]);
  const rest = value.slice(m[0].length);
  if (rest) node.appendChild(document.createTextNode(unesc(rest)));
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
  announce(msg);
}

/* 读屏播报口（2026-10-14 体检 F6）。
   逐 token 追加的流式正文不能直接挂 live region —— 那会把读屏刷屏，
   所以正文区在流式期间静音，只在关键状态切换时从这里播一句话。
   先清空再赋值：同一条文案连续播报时，不清空就不会被重新宣读。 */
function announce(msg) {
  const a = $('#srAnnounce');
  if (!a || !msg) return;
  a.textContent = '';
  setTimeout(() => { try { a.textContent = msg; } catch (_) {} }, 60);
}

/* ---------- 应用内输入弹窗 ----------
   为什么不能直接用 window.prompt（原生对话框）：
   **Electron 不再支持它** —— 调用直接抛「prompt() is and will not be supported.」，
   依赖 prompt 的入口（如辩题归档改名）点了没反应，而且不报错、不提示，
   从界面上完全看不出哪里坏了。所以做一个应用内的替代品：同样的调用手感，但真的能用。

   askInput({ title, hint, fields, okText }) -> Promise<{values}|null>
     fields: [{ key, label, value, placeholder, multiline, optional }]
     返回 null 表示用户取消。 */
function askInput(opts) {
  return new Promise((resolve) => {
    const modal = $('#inputModal');
    const titleEl = $('#inputModalTitle');
    const hintEl = $('#inputModalHint');
    const box = $('#inputModalFields');
    const okBtn = $('#inputModalOk');
    const cancelBtn = $('#inputModalCancel');
    if (!modal || !box) { resolve(null); return; }

    const fields = (opts && opts.fields) || [];
    if (titleEl) titleEl.textContent = (opts && opts.title) || '请输入';
    if (hintEl) {
      const h = (opts && opts.hint) || '';
      hintEl.innerHTML = h ? esc(h) : '';
      hintEl.classList.toggle('hidden', !h);
    }
    if (okBtn) okBtn.textContent = (opts && opts.okText) || '确定';

    /* 渲染字段。label 用 <label> 包住，点文字也能聚焦到输入框 */
    box.innerHTML = '';
    const inputs = [];
    for (const f of fields) {
      const lab = document.createElement('label');
      lab.className = 'input-modal-field';
      if (f.label) {
        const span = document.createElement('span');
        span.textContent = f.label + (f.optional ? '（可留空）' : '');
        lab.appendChild(span);
      }
      let ctl;
      if (f.multiline) {
        ctl = document.createElement('textarea');
        ctl.rows = f.rows || 3;
      } else {
        ctl = document.createElement('input');
        ctl.type = 'text';
        ctl.autocomplete = 'off';
      }
      if (f.placeholder) ctl.placeholder = f.placeholder;
      ctl.value = f.value == null ? '' : String(f.value);
      lab.appendChild(ctl);
      box.appendChild(lab);
      inputs.push({ key: f.key, ctl, optional: !!f.optional });
    }

    let settled = false;
    const cleanup = () => {
      modal.classList.add('hidden');
      okBtn && (okBtn.onclick = null);
      cancelBtn && (cancelBtn.onclick = null);
      if (modal._closeBtn) modal._closeBtn.onclick = null;
      document.removeEventListener('keydown', onKey, true);
    };
    const finish = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };

    const submit = () => {
      const values = {};
      for (const it of inputs) {
        const v = String(it.ctl.value || '').trim();
        /* 必填校验：留空就提示并聚焦，而不是静默存个空值 */
        if (!v && !it.optional) {
          toast('这一项不能为空');
          it.ctl.focus();
          return;
        }
        values[it.key] = v;
      }
      finish(values);
    };

    /* Esc 取消、Ctrl/Cmd+Enter 提交；用捕获阶段，避免被页面的其他快捷键抢走 */
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
      else if (e.key === 'Enter' && inputs.length === 1 && !inputs[0].ctl.tagName.match(/TEXTAREA/)) {
        e.preventDefault(); submit();
      }
    };
    document.addEventListener('keydown', onKey, true);

    if (okBtn) okBtn.onclick = submit;
    if (cancelBtn) cancelBtn.onclick = () => finish(null);
    const closeBtn = modal.querySelector('.modal-close');
    modal._closeBtn = closeBtn;
    if (closeBtn) closeBtn.onclick = () => finish(null);

    modal.classList.remove('hidden');
    /* 聚焦第一个字段并全选，方便直接覆盖 */
    setTimeout(() => {
      const first = inputs[0] && inputs[0].ctl;
      if (first) { try { first.focus(); first.select(); } catch (_) {} }
    }, 30);
  });
}
/* ---------- 对话框可达性（2026-10-14 体检 F4）----------
   全站弹层共用 .modal / .modal.hidden 这一套显隐约定。缺两件事：
   1. 没有对话框语义 —— 读屏器不知道「进了对话框」，会继续在背景页面上游走；
   2. Tab 不封顶 —— 遮罩盖着还能把焦点 Tab 到背后的「设置 / 新对话」按钮，
      屏幕上看不见焦点落点，只能盲操作。
   这里按显隐约定统一接管，静态弹窗与 askInput 共用一套，省得每个入口各写一遍。 */
const DIALOG_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),'
  + 'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function visibleModals() {
  return Array.prototype.filter.call(
    document.querySelectorAll('.modal'), (m) => !m.classList.contains('hidden'));
}

/* ---------- 弹层退场动画（2026-10-15）----------
   弹层原来只有进场动画：进场淡入放大，退场是 display:none 硬消失。
   这里给个统一的关闭入口：先挂 .is-closing 播退场，动画期间**不动焦点、不锁交互**
   （Apple：「让用户可取消动态效果。尽量不要让用户等待动画完成才能执行操作」），
   到点再真正加 .hidden。

   三条硬约束：
   1. 动画时长必须从 CSS 变量读 —— 在 tokens.css 一处改，这里跟着走，不会对不上。
   2. prefers-reduced-motion 下时长会被令牌压到 ~80ms，自动跟着变快，不用另写分支。
   3. 被「立刻又打开」打断时（比如连点），必须取消上一次的收尾定时器，
      否则定时器到点会把刚打开的弹层又藏起来 —— 那会变成"点了没反应"。 */
function motionMs(varName, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (!v) return fallback;
    if (v.endsWith('ms')) return parseFloat(v) || fallback;
    if (v.endsWith('s')) return (parseFloat(v) || 0) * 1000 || fallback;
  } catch (_) {}
  return fallback;
}

function closeModalAnimated(modal) {
  if (!modal || modal.classList.contains('hidden')) return;
  if (modal._closeTimer) { clearTimeout(modal._closeTimer); modal._closeTimer = null; }
  modal.classList.remove('is-closing');
  // 强制重排：连续开关时保证动画能重新开始（否则第二次不播）
  void modal.offsetWidth;
  modal.classList.add('is-closing');
  const ms = motionMs('--dur-slow', 240);
  modal._closeTimer = setTimeout(() => {
    modal._closeTimer = null;
    modal.classList.remove('is-closing');
    modal.classList.add('hidden');
  }, ms);
}

/* 打开弹层：清掉可能还在跑的退场态，否则会带着 .is-closing 显示成半透明 */
function openModalAnimated(modal) {
  if (!modal) return;
  if (modal._closeTimer) { clearTimeout(modal._closeTimer); modal._closeTimer = null; }
  modal.classList.remove('is-closing');
  modal.classList.add('hidden');
  void modal.offsetWidth;
  modal.classList.remove('hidden');
}

function focusablesIn(root) {
  return Array.prototype.filter.call(root.querySelectorAll(DIALOG_FOCUSABLE), (n) => {
    if (n.closest('.hidden') && !n.classList.contains('hidden')) return false;
    return n.offsetWidth || n.offsetHeight || n.getClientRects().length;
  });
}

function trapDialogTab(e) {
  if (e.key !== 'Tab') return;
  const mods = visibleModals();
  if (!mods.length) return;                 // 没有弹层开着：完全不管，页面快捷键照旧
  /* 多个叠放时只管最上面那个。判「最上面」用 z-index（关窗确认 1100，普通弹层 50、设置 1000），
     同值再按 DOM 先后 —— 只按 DOM 顺序会让「后插入但被压在下面」的弹窗抢走 Tab：
     实测欢迎页向导开着时点关闭，Tab 会跑到向导的按钮上，屏幕上看不见焦点。 */
  const zOf = (m) => Number(getComputedStyle(m).zIndex) || 0;
  const modal = mods.reduce((top, m) => (zOf(m) >= zOf(top) ? m : top), mods[0]);
  const items = focusablesIn(modal);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const cur = document.activeElement;
  if (!modal.contains(cur)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
}

function initDialogA11y() {
  document.addEventListener('keydown', trapDialogTab, true);
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      const modal = r.target;
      const hidden = modal.classList.contains('hidden');
      if (modal._dlgHidden === hidden) continue;
      if (hidden) {
        // 关闭：把焦点还给打开它的那个按钮，而不是掉回文档开头
        modal._dlgHidden = true;
        const prev = modal._dlgReturn;
        modal._dlgReturn = null;
        if (prev && document.contains(prev)) { try { prev.focus(); } catch (_) {} }
      } else {
        modal._dlgHidden = false;
        modal._dlgReturn = document.activeElement;
        // 显式声明优先（如关闭确认把焦点放在「最小化到托盘」这个安全默认上），
        // 其次才是第一个输入控件：askInput 自己会聚焦并全选字段，顺序上互不干扰
        const marked = modal.querySelector('[data-autofocus]');
        const field = modal.querySelector('input:not([type=hidden]),textarea,select');
        const target = marked || field || focusablesIn(modal)[0];
        if (target) setTimeout(() => { try { target.focus(); } catch (_) {} }, 60);
      }
    }
  });
  Array.prototype.forEach.call(document.querySelectorAll('.modal'), (m) => {
    m._dlgHidden = m.classList.contains('hidden');
    mo.observe(m, { attributes: true, attributeFilter: ['class'] });
  });
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

/* 「多久前活跃」（2026-10-10，子涵：参考图里右侧那个"3 小时前"挺好）。
   分档：刚刚 / N 分钟前 / N 小时前 / N 天前，超过一周就退回日期（当年不写年份）。
   用**相对时间**是因为它回答的是"这个对话还热不热"，绝对时间戳做不到。 */
function fmtAgo(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day < 7) return day + ' 天前';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? (d.getMonth() + 1) + '月' + d.getDate() + '日'
                  : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/* 列表副标题：优先服务端索引给的最后一条消息摘要；没有（老索引 / 懒加载未载入）
   就退回消息条数 —— 与参考图里"2 条消息"的降级一致，绝不留空白。 */
function historySubtitle(c) {
  const snip = typeof c.lastText === 'string' ? c.lastText.trim() : '';
  if (snip) return (c.lastRole === 'user' ? '我：' : '') + snip;
  const n = Number(c.msgCount);
  if (Number.isFinite(n) && n > 0) return n + ' 条消息';
  return '还没有消息';
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

/* 异步加载：优先服务端文件存储；服务端为空时自动迁移旧 localStorage 数据。
   列表只取元数据（走服务端 SQLite 索引），正文在打开对话时按需拉取（懒加载），
   对话多了之后启动不再解析全部 JSON。 */
async function loadChatsAsync() {
  try {
    const r = await fetchJSON('/api/chats/list');
    if (r && r.ok && Array.isArray(r.chats)) {
      if (r.chats.length) {
        const chats = normalizeChats(r.chats);
        for (const c of chats) { c._loaded = false; savedStamps.set(c.id, c.updated); }
        return chats;
      }
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
        for (const c of legacy) savedStamps.set(c.id, c.updated);
        return legacy;
      }
      return [];
    }
  } catch (_) {}
  // 兜底：服务端不可用时继续读 localStorage，保证对话不丢
  const legacy = readLegacyChats();
  for (const c of legacy) savedStamps.set(c.id, c.updated);
  return legacy;
}

/* 按需加载单个对话正文（_loaded=false 的只含元数据） */
async function ensureChatLoaded(id) {
  const c = (state.chats || []).find((x) => x.id === id);
  if (!c || c._loaded !== false) return c;
  try {
    const r = await fetchJSON(CHATS_API + '/' + encodeURIComponent(id));
    if (r && r.ok && r.chat) {
      const full = normalizeChats([r.chat])[0];
      if (full) { full._loaded = true; Object.assign(c, full); }
      else c._loaded = true;
    } else {
      c._loaded = true; // 拿不到正文也标记已载，避免反复请求
    }
  } catch (_) { c._loaded = true; }
  return c;
}

/* 搜索需要全部正文：把只含元数据的对话一次性补齐（仅在用户搜索时触发一次） */
async function hydrateAllChats() {
  const pending = (state.chats || []).filter((c) => c._loaded === false);
  if (!pending.length) return;
  try {
    const r = await fetchJSON(CHATS_API);
    if (r && r.ok && Array.isArray(r.chats)) {
      const byId = new Map(r.chats.map((c) => [c.id, c]));
      for (const c of pending) {
        const full = byId.get(c.id);
        if (full) { const nf = normalizeChats([full])[0]; if (nf) { nf._loaded = true; Object.assign(c, nf); savedStamps.set(c.id, c.updated); } }
        else c._loaded = true;
      }
    }
  } catch (_) {
    for (const c of pending) c._loaded = true;
  }
}

/* 已落盘的对话时间戳：与 c.updated 比对判断哪些对话「脏」了需要增量保存 */
const savedStamps = new Map();

/* 保存：只上行有改动的对话（PUT /api/chats/upsert，串行防乱序），
   服务端失败时降级写 localStorage，关窗前还有同步兜底。 */
function saveChats() {
  flushChats();
}
let flushChain = Promise.resolve();
function flushChats() {
  const dirty = (state.chats || []).filter((c) => c && c._loaded !== false && savedStamps.get(c.id) !== c.updated);
  for (const c of dirty) {
    flushChain = flushChain.then(() => {
      const cur = (state.chats || []).find((x) => x.id === c.id);
      if (!cur || cur._loaded === false) return undefined;
      return fetchJSON('/api/chats/upsert', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: cur }),
      }).then(() => { savedStamps.set(cur.id, cur.updated); });
    }).catch(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify((state.chats || []).slice(0, 50))); } catch (_) {}
    });
  }
}
/* 关闭窗口/刷新前同步落盘，避免最后 300ms 的改动丢失（同样只上行脏对话） */
function flushChatsSync() {
  const dirty = (state.chats || []).filter((c) => c && c._loaded !== false && savedStamps.get(c.id) !== c.updated);
  for (const c of dirty) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', '/api/chats/upsert', false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ chat: c }));
      savedStamps.set(c.id, c.updated);
    } catch (_) {}
  }
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
async function switchChat(id) {
  const c = state.chats.find((x) => x.id === id);
  if (!c || c.mode !== state.mode) return; // 只允许打开当前模式的对话
  await ensureChatLoaded(id); // 懒加载：首次打开才拉正文
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
/* ================= 欢迎界面（空对话时） =================
    原来只是一条「你好我是逻敏」的气泡，打开就是个对话框，缺个像样的门面。
    这里做成标准 AI 应用的欢迎页：品牌 + 能力介绍 + 可点的示例提示 + 常用入口。
    模式不同，介绍与示例随之切换（复用 MODES 里的 prompts）。 */
const WELCOME_ICONS = { free: 'free', prep: 'target', review: 'review', judge: 'judge' };

/* 图标助手：统一走 icons.js 的 sprite（线性 SVG，继承 currentColor）。
   老代码里用 emoji 当图标的地方一律改走这里，界面才不会花花绿绿。 */
function ic(name, size) {
  return (window.AcademyIcons && window.AcademyIcons.icon(name, { size: size || 18 })) || '';
}
/* 往元素里塞图标（清空后放入） */
function setIcon(node, name, size) {
  if (!node) return;
  node.innerHTML = ic(name, size);
  return node;
}

/* 顶部大问候语：按时段问候 + 一句引导，简短、字号大、居中 */
function welcomeGreeting() {
  const h = new Date().getHours();
  const when = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  return when + '，今天想辩点什么？';
}

function renderWelcome() {
  /* 2026-09-27 子涵：欢迎页只留一句居中问候——模式说明卡（图标+模式名+描述）也去掉了，
     模式信息看聊天区顶栏（modeTitle/modeDesc）；原示例卡片与底部提示行此前已移除。 */
  const wrap = el('div', 'welcome');
  const head = el('div', 'welcome-head', '');
  head.appendChild(el('h1', 'welcome-greet', welcomeGreeting()));
  wrap.appendChild(head);
  return wrap;
}

function renderMessages() {
  resetSmoothStream();
  const box = $('#messages');
  const wasStick = stickBottom;
  const prevTop = box.scrollTop;
  box.innerHTML = '';
  box.classList.toggle('empty', !state.messages.length);
  if (!state.messages.length) {
    box.appendChild(renderWelcome());
    stickBottom = true;
    syncToBottomBtn();
    renderUsageSummary();
    return;
  }
  for (const [idx, m] of state.messages.entries()) {
    box.appendChild(renderMessage(idx, m));
  }
  // 用户在底部 → 跟随新内容；用户正在往上读 → 保留原阅读位置，别把人拽走
  if (wasStick) scrollBottom();
  else box.scrollTop = prevTop;
  syncToBottomBtn();
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
/* Token 栏右侧的压缩上下文入口（与顶部压缩按钮同一处理函数） */
function appendCompactBtn(bar) {
  const b = el('button', 'sum-compact', ic('broom',12) + '压缩上下文');
  b.type = 'button';
  b.title = '把当前对话压缩成摘要，释放上下文空间';
  b.onclick = () => compactContext();
  bar.appendChild(b);
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
    t.innerHTML = ic('chart', 13) + '<b>本对话 Token</b> 暂无用量（发消息后显示）';
    bar.innerHTML = '';
    bar.appendChild(t);
    appendCompactBtn(bar);
    return;
  }
  const p = (label, val, cls) => {
    const s = el('span', 'usage-summary-item' + (cls ? ' ' + cls : ''));
    s.innerHTML = '<b>' + label + '</b> ' + Number(val).toLocaleString();
    return s;
  };
  bar.innerHTML = '';
  const t = el('span', 'usage-summary-item');
  t.innerHTML = ic('chart', 13) + '<b>本对话 Token</b>';
  bar.appendChild(t);
  const cu = latestContextUsed();
  if (cu) {
    // 模型未上报窗口时按 1M（与每条回复 usage-box 的默认口径一致）估算
    const win = cu.window > 0 ? cu.window : 1048576;
    const ctxPct = Math.min(99.99, cu.used / win * 100);
    const c = el('span', 'usage-summary-item sum-ctx');
    c.innerHTML = ic('compass',12) + '<b>上下文已使用占比</b> ' + ctxPct.toFixed(2) + '%';
    c.title = '最近一轮输入 ' + cu.used.toLocaleString() + ' tokens ÷ 上下文窗口 ' + (win / 1024).toFixed(0) + 'K tokens' + (cu.window > 0 ? '' : '（模型未上报窗口，按默认估算）');
    bar.appendChild(c);
  }
  bar.appendChild(p('输入', u.input));
  const hit = el('span', 'usage-summary-item sum-hit');
  hit.innerHTML = ic('target',12) + '<b>缓存命中</b> ' + hitRate.toFixed(1) + '%';
  bar.appendChild(hit);
  bar.appendChild(p('输出', u.output));
  if (u.cacheWrite) bar.appendChild(p('缓存写', u.cacheWrite));
  if (u.reasoning) bar.appendChild(p('推理', u.reasoning));
  appendCompactBtn(bar);
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
  hit.innerHTML = ic('target',12) + '<b>缓存命中</b> ' + hitRate.toFixed(1) + '%';
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
  avatar.innerHTML = ic(m.role === 'user' ? 'user' : 'sparkle', 15);
  const bubble = el('div', 'bubble' + (m.error ? ' error' : ''));
  const meta = el('div', 'msg-meta');
  const who = el('span', null, m.role === 'user' ? '你 · ' + fmtTime(m.time) : '逻敏 · ' + fmtTime(m.time));
  meta.appendChild(who);

  if (m.role === 'assistant') {
    const actions = el('div', 'msg-actions');
    const copy = el('button', null, '复制');
    copy.onclick = () => copyText(m.text || m.error || '');
    // 一键存产物：不用再让 Agent「写一份存到产物空间」，点一下就行
    const toDeliver = el('button', null, ic('save',13) + '存产物');
    toDeliver.title = '把这条回复存为产物空间的 Markdown 文件';
    toDeliver.onclick = () => saveMsgToDeliver(m);
    const star = el('button', m.starred ? 'starred' : null, ic('star',13) + (m.starred ? '已收藏' : '收藏'));
    star.title = '收藏后可在「产物 → 收藏」跨对话查看';
    star.onclick = () => {
      m.starred = !m.starred;
      persistChat();
      renderMessages();
    };
    // 重答：只给最后一条回复且不在生成中时出现
    const isLastAssistant = (() => {
      const ms = state.messages || [];
      for (let i = ms.length - 1; i >= 0; i--) {
        if (ms[i].role === 'assistant') return ms[i] === m;
        if (ms[i] === m) return false;
      }
      return false;
    })();
    let reroll = null;
    if (isLastAssistant && !m.running && !m.error) {
      reroll = el('button', null, ic('refresh',13) + '重答');
      reroll.title = '按同一句提问重新生成这条回复';
      reroll.onclick = () => regenerateLast();
    }
    const exportOne = el('button', null, 'Word');
    exportOne.onclick = () => exportWord(m);
    const exportPdfBtn = el('button', null, 'PDF');
    exportPdfBtn.onclick = () => exportPdf(m);
    if (!(window.academyElectron && window.academyElectron.exportPdf)) exportPdfBtn.classList.add('hidden');
    const exportMd = el('button', null, '导出');
    exportMd.onclick = () => exportMarkdown(m);
    actions.appendChild(copy);
    actions.appendChild(toDeliver);
    actions.appendChild(star);
    if (reroll) actions.appendChild(reroll);
    actions.appendChild(exportOne);
    actions.appendChild(exportPdfBtn);
    actions.appendChild(exportMd);
    meta.appendChild(actions);
    if (m.starred) who.appendChild(el('span', 'msg-star-badge', ic('star',12)));
  }
  bubble.appendChild(meta);

  /* 用户消息里附带的文件。
     ★ 用 innerHTML 组装：fileIcon() 返回的是图标 SVG，拼在字符串里交给 el()
     会被当文本转义（el 只认整串以 <svg 开头的情况），附件标记就会显示成
     一段源码。这里显式分组，图标节点与名字节点分开。 */
  if (m.role === 'user' && Array.isArray(m.attachments) && m.attachments.length) {
    const attBox = el('div', 'msg-attachments', '');
    for (const a of m.attachments) {
      const chip = el('span', 'msg-attach');
      chip.innerHTML = fileIcon(a.name) + '<span>' + esc(a.name) + '</span>';
      if (a.size) chip.title = a.name + ' · ' + Math.max(1, Math.round(a.size / 1024)) + ' KB';
      attBox.appendChild(chip);
    }
    bubble.appendChild(attBox);
  }

  // 本次召回的个人资料（用户自己的备赛资料）
  if (Array.isArray(m.library) && m.library.length) {
    const lb = el('div', 'lib-chips');
    lb.appendChild(el('span', 'lib-chips-label', ic('library',13) + '本次召回你的资料'));
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
    toolsBox.innerHTML = toolsBoxHtml(m.tools);
    bubble.appendChild(toolsBox);
  }

  // 思考过程：运行中 + 完成后都保留（运行中默认展开，完成后默认收起）
  if (m.reasoning) {
    const details = document.createElement('details');
    details.className = 'think-box';
    details.id = 'thinkBox' + idx;
    details.open = !!m.running;
    const summary = document.createElement('summary');
    summary.innerHTML = ic('sparkle',13) + '思考过程' + (m.running ? '' : '（已完成）');
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
    p.innerHTML = '<p>' + ic('warn',14) + ' ' + esc(m.error) + '</p>';
    bubble.appendChild(p);
  } else if (m.role === 'assistant') {
    const md = el('div', 'md');
    md.innerHTML = mdToHtml(m.text || '');
    bubble.appendChild(md);
  } else {
    /* 用户消息：正文单独包一层，不能用 bubble.textContent 直接赋值 ——
       那会**清空整个气泡**，把前面 appendChild 进去的附件标记一起抹掉
       （2026-09-23 的「附件发出去就看不见了」就是这个原因）。
       文字放进子节点，附件的 DOM 才能留住。 */
    bubble.appendChild(el('div', 'msg-text', m.text));
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

/* ── 滚动跟随（生成过程中不再强制下拉） ──
   只有「用户本来就在底部」时才跟着新内容走；用户往上翻阅读后停下，
   输入框上方浮出「回到底部」，点一下回到最新并恢复跟随。 */
const STICK_THRESHOLD = 48;   // 距底部多少 px 以内算「在底部」
let stickBottom = true;

function atBottom() {
  const box = $('#messages');
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_THRESHOLD;
}

function syncToBottomBtn() {
  const btn = $('#btnToBottom');
  if (btn) btn.classList.toggle('hidden', stickBottom);
}

/* 跟随式滚动：仅在用户仍在底部时滚（生成过程用这个）。
   注意 rAF 里要重新读一次几何位置：scroll 事件是异步派发的，
   用户刚翻上去时 stickBottom 还没更新，只看标志位会把人拽回底部。 */
function autoScroll() {
  if (!stickBottom) return;
  const box = $('#messages');
  if (!box) return;
  requestAnimationFrame(() => {
    if (!stickBottom || !atBottom()) return;
    box.scrollTop = box.scrollHeight;
  });
}

/* 主动回到底部并恢复跟随：发送 / 切换对话 / 点「回到底部」。
   用同步落底（读 scrollHeight 会强制排版），不走 rAF —— 少一帧竞态，也不闪。 */
function scrollBottom() {
  stickBottom = true;
  syncToBottomBtn();
  const box = $('#messages');
  if (box) box.scrollTop = box.scrollHeight;
}

function initScrollFollow() {
  const box = $('#messages');
  if (!box) return;
  box.addEventListener('scroll', () => {
    const next = atBottom();
    if (next === stickBottom) return;
    stickBottom = next;
    syncToBottomBtn();
  }, { passive: true });
  const btn = $('#btnToBottom');
  if (btn) btn.addEventListener('click', () => scrollBottom());
}

/* ── 流式平滑显示（打字机）：DSH 是批量写入的，一次到一大块，
   这里把文本按帧匀速吐出，视觉上连续；缓冲区大时自动加速追赶。 ── */
let _smBuf = '';          // 待显示文本
let _smShown = '';        // 已显示文本
let _smIdx = -1;
let _smTicking = false;
let _smLastCost = 0;      // 上次 mdToHtml 耗时，用于自适应降频
let _smSkipUntil = 0;

/* ---- 按真实时序回放 ----
   内核 0.1.5 不再逐字写增量：整段文本在 step 结束时才落盘，但会附带
   dt[]（每个字块的真实生成间隔，毫秒）。把它换算成「每个字块应在何时出现」，
   再按绝对时间轴播放，观感就等同真实流式（而不是固定速度的假打字机）。
   没有 dt（旧内核/普通流式）时自动退回原来的追赶式平滑。 */
let _smTimeline = null;   // { chars: [...], at: [...], startedAt, cursor }
function buildReplayTimeline(text, dt, time0, texts) {
  const t = String(text || '');
  if (!t) return null;
  if (!Array.isArray(dt) || !dt.length) return null;
  const chars = Array.from(t);
  const n = chars.length;
  const at = new Array(n);
  let acc = 0;
  /* 优先按内核给的 texts[] 逐块摊（每块的真实间隔是 dt[i]），这样
     「打钉子」这类多字块会在同一时刻整体出现，节奏与真实生成一致；
     拿不到 texts 时才退回按字符数均分。 */
  if (Array.isArray(texts) && texts.length && texts.join('') === t) {
    let ci = 0;
    for (let i = 0; i < texts.length && ci < n; i++) {
      acc += Number(dt[i]) || 0;
      const blockLen = Array.from(String(texts[i])).length;
      for (let k = 0; k < blockLen && ci < n; k++) at[ci++] = acc;
    }
    // 余下字符（dt 比 texts 短时）沿用最后时刻
    while (ci < n) at[ci++] = acc;
  } else {
    const step = Math.max(1, Math.ceil(n / dt.length));
    for (let i = 0; i < n; i++) {
      const di = Math.min(dt.length - 1, Math.floor(i / step));
      acc += Number(dt[di]) || 0;
      at[i] = acc;
    }
  }
  return { chars, at, total: acc || 0, startedAt: performance.now(), cursor: 0 };
}

function pushStreamText(idx, fullText, dt, time0, texts) {
  _smIdx = idx;
  const t = String(fullText || '');
  // 新一段到达：若带真实时序，则以它为准重建时间轴（每段独立播放）
  if (Array.isArray(dt) && dt.length) {
    const tl = buildReplayTimeline(t, dt, time0, texts);
    if (tl) { _smTimeline = tl; _smShown = ''; _smBuf = ''; if (!_smTicking) { _smTicking = true; requestAnimationFrame(replayTick); } return; }
  }
  _smTimeline = null;
  // 增量入缓冲（处理回退/重置场景）
  if (!t.startsWith(_smShown)) { _smShown = ''; _smBuf = t; }
  else { _smBuf = t.slice(_smShown.length); }
  if (!_smTicking) { _smTicking = true; requestAnimationFrame(smoothTick); }
}

/* 按真实时间轴推进：每次把「此刻应已出现」的字符补上 */
function replayTick() {
  const tl = _smTimeline;
  if (!tl) { _smTicking = false; return; }
  const elapsed = performance.now() - tl.startedAt;
  while (tl.cursor < tl.chars.length && tl.at[tl.cursor] <= elapsed) tl.cursor++;
  if (tl.cursor > _smShown.length) {
    _smShown = tl.chars.slice(0, tl.cursor).join('');
    renderStreamNow();
  }
  if (tl.cursor < tl.chars.length) {
    requestAnimationFrame(replayTick);
  } else {
    _smShown = tl.chars.join('');
    _smBuf = '';
    _smTimeline = null;
    _smTicking = false;
    renderStreamNow();
  }
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
  _smTimeline = null;
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
      if (md) pushStreamText(idx, state.messages[idx].streamText || '', patch.dt, patch.time0, patch.texts);
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
      if (box) box.innerHTML = toolsBoxHtml(patch.tools || []);
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
        summary.innerHTML = ic('sparkle',13) + '思考过程';
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
  autoScroll();
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
  /* 占位提示（2026-09-27 子涵）：各模式的示例句统一换成一句。
     原实现=该模式第一句示例+快捷键提示；示例词仍保留在各 MODES 定义里备用。 */
  $('#input').placeholder = '言语，是强大的主宰';
  const hs = document.querySelector('.side-head h3');
  if (hs) hs.innerHTML = ic('history',13) + '对话历史 · ' + esc(modeMeta[state.mode].title);
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
    box.appendChild(el('div', 'history-empty', '当前模式暂无历史'));
    return;
  }
  const shown = mine.slice(0, historyLimit);
  for (const c of shown) {
    const item = el('button', 'history-item' + (c.id === state.chatId ? ' active' : ''), '');
    /* 两行结构（2026-10-10，子涵：给参考图那种"最后一条消息 + 多久前"）：
       上行=标题（左）+ 活跃时间（右）；下行=最后一条消息摘要。
       标题/摘要是文本节点，直接挂在 button 里会把 ops 挤到下面，
       所以各自包一层，由 CSS 控制省略号。 */
    const top = el('span', 'h-top', '');
    const t = el('span', 'h-title', c.title || '未命名');
    top.appendChild(t);
    const when = fmtAgo(c.updated);
    if (when) top.appendChild(el('span', 'h-when', when));
    item.appendChild(top);
    item.appendChild(el('span', 'h-sub', historySubtitle(c)));
    // 操作按钮整组包进 .history-ops：平时隐藏，hover 到该条才出现（见 style.css）
    const ops = el('span', 'history-ops', '');
    // 重命名按钮（单击标题会切换对话，双击不可靠，改用显式按钮）
    const edit = el('span', 'history-edit', ic('edit',12));
    edit.title = '重命名';
    edit.onclick = (e) => { e.stopPropagation(); e.preventDefault(); startRenameChat(c.id, t); };
    ops.appendChild(edit);
    const del = el('span', 'history-del', ic('trash',12));
    del.title = '删除';
    del.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      // 正文可能是懒加载的（_loaded=false），此时 messages 为空数组，数出来的 0 会误导用户
      const msgCount = Array.isArray(c.messages) ? c.messages.length : 0;
      const countKnown = c._loaded !== false;
      const tip = '删除对话「' + (c.title || '未命名') + '」？' +
        (countKnown && msgCount ? ('\n\n共 ' + msgCount + ' 条消息，删除后不可恢复。') : '\n\n删除后不可恢复。');
      if (!window.confirm(tip)) return;
      state.chats = state.chats.filter((x) => x.id !== c.id);
      savedStamps.delete(c.id);
      try { fetchJSON('/api/chats/' + encodeURIComponent(c.id), { method: 'DELETE' }).catch(() => {}); } catch (_) {}
      if (state.chatId === c.id) newChat(state.mode);
      if (state.chatIdByMode[state.mode] === c.id) state.chatIdByMode[state.mode] = null;
      saveChats();
      renderHistory();
      toast('已删除对话「' + (c.title || '未命名') + '」');
    };
    ops.appendChild(del);
    item.appendChild(ops);
    item.onclick = () => switchChat(c.id);
    box.appendChild(item);
  }
  /* 参考图底部那行「显示更多（还有 N 条）」：默认只看最近 20 条，
     免得几十个对话把侧栏撑成一条长龙。点一次多放 20 条。 */
  if (mine.length > shown.length) {
    const more = el('button', 'history-more', '显示更多（还有 ' + (mine.length - shown.length) + ' 条）');
    more.onclick = () => { historyLimit += 20; renderHistory(); };
    box.appendChild(more);
  } else if (historyLimit > HISTORY_PAGE) {
    const less = el('button', 'history-more', '收起');
    less.onclick = () => { historyLimit = HISTORY_PAGE; renderHistory(); };
    box.appendChild(less);
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

/* 侧栏历史一次显示多少条（「显示更多」每次 +20）。 */
const HISTORY_PAGE = 20;
let historyLimit = HISTORY_PAGE;

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
  // 搜索要扫全部正文：懒加载未取回的对话先补齐一次，再重新渲染结果
  if ((state.chats || []).some((c) => c._loaded === false)) {
    box.appendChild(el('div', 'search-hits-head', '正在载入全部对话…'));
    hydrateAllChats().then(() => { if (historyQuery.trim() === kw) renderHistorySearch(); }).catch(() => {});
    return;
  }
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
  /* 模式切换给主区一个淡入：让用户看得见"内容换了"，而不是瞬间静默替换。
     Apple：「有目的地添加动态效果」—— 这条动效的"目的"就是告诉用户上下文变了。 */
  const main = document.querySelector('.main');
  if (main) {
    main.classList.remove('mode-enter');
    void main.offsetWidth;   // 强制重排：连续切换时动画能重播，而不是偶尔静默
    main.classList.add('mode-enter');
  }
  renderMessages();
  renderHistory();
  focusInput();
}

function focusInput() { $('#input').focus(); }

/* ================= 状态 / 配置 ================= */
let apikeyHelpAutoOpened = false; // 「获取 API Key」教程只在首次没配 Key 时自动展开一次

async function refreshStatus() {
  try {
    const s = await fetchJSON('/api/status');
    state.status = s;
    if (STEPS_MODES.includes(s.stepsDisplay)) state.stepsDisplay = s.stepsDisplay;
    if (s.busyBehavior === 'interrupt' || s.busyBehavior === 'queue') state.busyBehavior = s.busyBehavior;
    if (s.sendHotkey === 'enter' || s.sendHotkey === 'ctrlEnter') state.sendHotkey = s.sendHotkey;
    try { syncAgentChoices(); } catch (_) {}
    renderStatus();
    if (!s.hasKey) {
      $('#keyBanner').classList.remove('hidden');
      $('#welcomeNote').classList.remove('hidden');
      const ak = $('#apikeyHelp');
      if (ak && !apikeyHelpAutoOpened) { ak.open = true; apikeyHelpAutoOpened = true; }
    } else {
      $('#keyBanner').classList.add('hidden');
      $('#welcomeNote').classList.add('hidden');
    }
  } catch (e) {
    $('#statusPill').className = 'status-pill err';
    $('#statusPill').textContent = '服务异常';
  }
}

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const pill = $('#statusPill');
  if (s.busy) {
    pill.className = 'status-pill busy';
    pill.innerHTML = ic('sparkle',12) + 'Agent 运行中' + (s.queueLen ? ' · 排队 ' + s.queueLen : '') + '…';
  } else if (!s.hasKey) {
    pill.className = 'status-pill err';
    pill.textContent = '未配置 API Key';
  } else if (s.dsh && s.node) {
    pill.className = 'status-pill ok';
    pill.innerHTML = '引擎就绪 · ' + esc(s.model || '');
  } else {
    pill.className = 'status-pill err';
    pill.innerHTML = ic('warn',12) + '引擎缺失';
  }
  /* 2026-09-27 子涵：左下角技术参数行（DSH 内核/Node/API/搜索/记忆）已移除——
     是否可用看右上角状态徽章（绿点引擎就绪 / 红「服务异常」）即可。 */
  /* 运行中时禁用「模型 + 推理等级」控件：正在跑的一轮用的是提交那一刻的档位，
     跑到一半改档位没有意义、还会让读数与实际不符。busy 的唯一真相是 state.status.busy，
     而 sendMessage / 压缩上下文 都在起止处改它并调到这里，所以搭这个钩子即可。 */
  syncComposerGear();
}

function openSettings() {
  const s = state.status;
  if (s) {
    syncSearchModeChoices(s);
    renderSettingsBadge(s);
    $('#settingsResult').textContent = '';
    $('#settingsResult').className = 'settings-result';
  }
  openModalAnimated($('#settingsModal'));
  closeModelPicker();
  // 打开设置默认落到「AI 模型」面板；若用户点了别的分组（如通用），保留其选择
  try {
    const activeNav = document.querySelector('.settings-nav-item.active');
    if (!activeNav) switchSettingsPane('model');
  } catch (_) {}
  // 载入/刷新多配置档案（编辑当前生效的配置）
  loadProfilesUI();
  try { loadExtToolsToggle(); } catch (_) {}
  try { loadModsearchUI(); } catch (_) {}
  try { loadMemToggles(); loadMemRejectList(); } catch (_) {}
    try { loadAgentChoices(); } catch (_) {}
  setTimeout(() => { const i = $('#apiKeyInput'); if (i) i.focus(); }, 50);
}

/* 二级导航：切换到指定分组面板（model/general/search/advanced） */
function switchSettingsPane(pane) {
  document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.settingsPane === pane));
  document.querySelectorAll('.settings-pane').forEach((p) => p.classList.toggle('active', p.dataset.settingsPane === pane));
  if (pane === 'stats') { try { renderStatsPane(); } catch (_) {} }
  if (pane === 'runs') { try { loadRunsPane(); } catch (_) {} }
  if (pane === 'skills') { try { loadSkillsUI(); } catch (_) {} }
  if (pane === 'about') { try { renderAboutPane(); } catch (_) {} }
}


/* ———— 关于应用 ———— */
const ABOUT_LICENSE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh';
function renderAboutPane() {
  const ver = (state.status && state.status.version) || '2.5.0';
  const edition = String((state.status && state.status.edition) || 'Flash').trim();
  const v = 'v' + String(ver).replace(/^v/i, '') + (edition ? ' ' + edition : '');
  const elVer = $('#aboutVersion');
  if (elVer) elVer.textContent = v;
  const elFoot = $('#aboutFootVer');
  if (elFoot) elFoot.textContent = 'Academy 辩论教练 ' + v;

  /* 引擎信息：让用户能自查运行环境是否完整。
     ★ 三态，不是两态 —— 之前拿不到 status 时报「缺失」，
     等于把「还没问到 / 连不上」误报成「运行环境坏了」，
     用户会以为要重装。没有数据时必须说「检测中」，不能替服务下结论。 */
  const elEng = $('#aboutEngine');
  if (!elEng) return;
  const s = state.status || null;
  if (!s) {
    elEng.textContent = '引擎检测中…';
    elEng.className = 'about-engine';
    return;
  }
  const parts = [];
  if (s.engine) parts.push('内核 ' + s.engine);
  parts.push('Node ' + (s.node ? '就绪' : '缺失'));
  parts.push('DSH ' + (s.dsh ? '就绪' : '缺失'));
  elEng.textContent = parts.join(' · ');
  // 真有缺失时标红，让它在「关于」页里能一眼被看到
  const bad = !s.node || !s.dsh;
  elEng.className = 'about-engine' + (bad ? ' bad' : '');
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
function copyAboutWeChat() {
  const wx = ($('#aboutWeChat') && $('#aboutWeChat').textContent || '').trim();
  if (!wx) return;
  const done = () => toast('微信公众号已复制：' + wx);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(wx).then(done).catch(() => fallbackCopyQQ(wx, done));
  } else {
    fallbackCopyQQ(wx, done);
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
  } catch (_) { toast('复制失败，请手动记录：' + text); }
}
function bindAboutPane() {
  const btnQQ = $('#aboutCopyQQ');
  if (btnQQ) btnQQ.onclick = copyAboutQQ;
  const btnWx = $('#aboutCopyWeChat');
  if (btnWx) btnWx.onclick = copyAboutWeChat;
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
  syncEndpointHint(val);
  return val;
}

/* 服务商地址 = 「你的 Key 和全部对话内容发往哪台主机」，敏感度与 Key 同级（体检报告 F3）。
   两道防线：地址框旁边常驻显示目标主机；主机不在已知名单里就必须先确认才允许写入。 */
function endpointHostOf(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).host.toLowerCase(); } catch (_) { return u; }
}

function knownEndpointHosts() {
  const set = new Set();
  const add = (u) => { const h = endpointHostOf(u); if (h) set.add(h); };
  Object.keys(WIZARD_PROVIDERS).forEach((k) => add(WIZARD_PROVIDERS[k] && WIZARD_PROVIDERS[k].baseUrl));
  providerCards().forEach((c) => add(c.dataset.baseurl || ''));
  (state.profiles || []).forEach((x) => add(x.baseUrl || ''));
  add(state.status && state.status.baseUrl);
  return set;
}

function syncEndpointHint(url) {
  const hint = $('#endpointHint');
  if (!hint) return;
  const host = endpointHostOf(url);
  if (!host) { hint.textContent = ''; hint.className = 'endpoint-hint'; return; }
  const known = knownEndpointHosts().has(host);
  hint.textContent = '🔒 Key 与对话内容将发往：' + host + (known ? '' : '（陌生主机）');
  hint.className = 'endpoint-hint' + (known ? '' : ' warn');
}

function confirmEndpointChange(url) {
  const host = endpointHostOf(url);
  syncEndpointHint(url);
  if (!host) return true;
  if (knownEndpointHosts().has(host)) return true;
  const cur = endpointHostOf((state.status && state.status.baseUrl) || '');
  const msg = '服务商地址指向陌生主机：' + host + '\n'
    + (cur ? '当前发往：' + cur + '\n' : '')
    + '\n保存后，你的 API Key 和全部对话内容都会发送到这台主机。\n确认继续吗？';
  return window.confirm(msg);
}
function bindProviderCards() {
  providerCards().forEach((card) => {
    card.onclick = () => {
      if (card.dataset.id === 'custom') {
        // 自定义：地址框就在「服务商」正下方，就地编辑即可（曾跳到「高级」面板去填，已改）
        const cur = ($('#baseUrlInput').value || '').trim() || 'https://api.deepseek.com';
        $('#baseUrlInput').value = cur;
        setActiveProviderCard(cur);
        syncEndpointHint(cur);
        setTimeout(() => { const i = $('#baseUrlInput'); if (i) { i.focus(); i.select(); } }, 50);
      } else {
        const bu = card.dataset.baseurl;
        $('#baseUrlInput').value = bu;
        setActiveProviderCard(bu);
        syncEndpointHint(bu);
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
      // 只提交搜索方式：地址/模型可能正在编辑中，带上会绕过 F3 的变更确认
      body: JSON.stringify({ searchProvider: mode }),
    });
    if (!r.ok) throw new Error(r.error || '保存失败');
    syncSearchModeChoices({ searchMode: r.searchMode });
    const outEl = $('#searchResultMsg');
    if (outEl) {
      outEl.textContent = mode === 'server' ? '已切换为服务侧搜索（用当前模型 Key）' : '已切换为端侧搜索（免费）';
      outEl.className = 'settings-result ok';
      setTimeout(() => { if (outEl) outEl.textContent = ''; }, 2600);
    }
    await refreshStatus();
  } catch (e) {
    const outEl = $('#searchResultMsg');
    if (outEl) { outEl.textContent = '' + e.message; outEl.className = 'settings-result err'; }
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
state.editingProfileId = null; // null=新增草稿；否则编辑该 id
state.editorOpen = false;      // 行内编辑卡是否展开（一次只开一张）

/* opts.keepEditor = 保留行内编辑卡里正在改的草稿（切换模型时不能把用户没保存的编辑冲掉）。 */
async function loadProfilesUI(opts) {
  const keepEditor = !!(opts && opts.keepEditor);
  try {
    const r = await fetchJSON('/api/profiles');
    if (!r.ok) throw new Error(r.error || '获取配置失败');
    state.profiles = r.profiles || [];
    state.activeProfileId = r.activeId || null;
    /* 首次运行姿态（对齐 DSH）：一台能用的服务商都没有时，直接把编辑卡摊开当「设置卡」，
       而不是让用户对着一个空列表找入口。已经有一家可用时，行默认收起，点「编辑」再展开。 */
    if (!keepEditor && !state.editorOpen) {
      const anyUsable = state.profiles.some((p) => p.hasKey);
      if (!anyUsable) { loadProfileIntoEditor(null); state.editorOpen = true; }
    }
    if (state.editingProfileId && !state.profiles.some((p) => p.id === state.editingProfileId)) {
      // 正在编辑的那家被删了：干净收起，别留着指向空气的编辑卡
      closeProfileEditor();
    }
    const box = $('#providerEditor');
    if (box) box.classList.toggle('hidden', !state.editorOpen);
    renderProviderRows();
    refreshComposerModelSelect();
    syncComposerGear();
  } catch (e) {
    toast('加载配置失败：' + e.message);
  }
}

/* 编辑器里正在编辑的模型列表（草稿）。保存前只活在前端 ——
   「获取可用模型」勾选一堆、再删掉几个，最后点保存才整张写回服务端。 */
state.editorModels = [];
state.editorModelId = '';

/** 取某家服务商的模型清单（公开视图已保证至少有一个）。 */
function modelsOf(p) {
  if (!p) return [];
  const list = Array.isArray(p.models) ? p.models : [];
  if (list.length) return list;
  return p.model ? [{ id: p.model }] : [];
}

/** 把一家服务商载入行内编辑卡。p 为 null = 新增草稿。 */
function loadProfileIntoEditor(p) {
  state.editingProfileId = p ? p.id : null;
  state.editorModels = p ? modelsOf(p).map((m) => Object.assign({}, m)) : [];
  state.editorModelId = p ? (p.model || (state.editorModels[0] && state.editorModels[0].id) || '') : '';
  $('#profileNameInput').value = p ? (p.name || '') : '';
  $('#apiKeyInput').value = '';
  $('#apiKeyInput').placeholder = (p && p.hasKey) ? ('当前: ' + (p.keyMasked || '已配置') + '，留空保持不变') : 'sk-...';
  const base = (p && p.baseUrl) || 'https://api.deepseek.com';
  $('#baseUrlInput').value = base;
  setActiveProviderCard(base);
  syncEndpointHint(base);
  const title = $('#editorTitle');
  if (title) title.textContent = p ? ('编辑：' + (p.name || p.baseUrl)) : '添加服务商';
  closeModelPicker();
  renderModelRows();
  const out = $('#settingsResult');
  if (out) { out.textContent = ''; out.className = 'settings-result'; }
}

/** 收起编辑卡（clearEditor=true 时同时清空草稿）。 */
function closeProfileEditor() {
  state.editingProfileId = null;
  state.editorModels = [];
  state.editorModelId = '';
  closeModelPicker();
  const box = $('#providerEditor');
  if (box) box.classList.add('hidden');
  renderProviderRows();
}

function clearProfileEditor() {
  state.editorModels = [];
  state.editorModelId = '';
  closeModelPicker();
  if ($('#providerEditor')) $('#providerEditor').classList.add('hidden');
  state.editingProfileId = null;
  renderProviderRows();
}

/** 打开编辑卡做「新增」。 */
function openProfileEditorForNew() {
  loadProfileIntoEditor(null);
  const box = $('#providerEditor');
  if (box) { box.classList.remove('hidden'); box.scrollIntoView({ block: 'nearest' }); }
  renderProviderRows();
}

/** 打开编辑卡编辑某一家服务商。 */
function openProfileEditorFor(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  loadProfileIntoEditor(p);
  const box = $('#providerEditor');
  if (box) { box.classList.remove('hidden'); box.scrollIntoView({ block: 'nearest' }); }
  renderProviderRows();
}

/* ———— 模型列表：草稿的增删改 + 选哪个用来对话 ———— */
function renderModelRows() {
  const box = $('#modelRows');
  const countEl = $('#modelListCount');
  if (countEl) countEl.textContent = state.editorModels.length ? ('共 ' + state.editorModels.length + ' 个') : '';
  if (!box) return;
  box.innerHTML = '';
  if (!state.editorModels.length) {
    box.appendChild(el('div', 'model-empty', '还没有模型。点「获取可用模型」自动拉取，或在下面手动添加。'));
    return;
  }
  for (const m of state.editorModels) {
    const row = el('div', 'model-row-item' + (m.id === state.editorModelId ? ' active' : ''), '');
    /* 圆点 = 「对话时用哪个」。点它即选中（与 DSH 的单选语义一致）。 */
    const pick = el('button', 'model-pick', '');
    pick.type = 'button';
    pick.title = m.id === state.editorModelId ? '当前用于对话' : '设为对话时使用';
    pick.setAttribute('aria-pressed', m.id === state.editorModelId ? 'true' : 'false');
    pick.onclick = () => { state.editorModelId = m.id; renderModelRows(); };
    row.appendChild(pick);
    const name = el('span', 'model-name', m.id);
    row.appendChild(name);
    const meta = [];
    if (m.name && m.name !== m.id) meta.push(m.name);
    if (m.contextWindow) meta.push('上下文 ' + Math.round(m.contextWindow / 1024) + 'K');
    if (meta.length) row.appendChild(el('span', 'model-meta', meta.join(' · ')));
    const ops = el('span', 'model-ops', '');
    const del = el('button', 'profile-op danger', ic('trash', 13));
    del.type = 'button';
    del.title = '从列表移除';
    del.onclick = (e) => {
      e.stopPropagation();
      state.editorModels = state.editorModels.filter((x) => x.id !== m.id);
      if (state.editorModelId === m.id) state.editorModelId = state.editorModels[0] ? state.editorModels[0].id : '';
      renderModelRows();
    };
    ops.appendChild(del);
    row.appendChild(ops);
    box.appendChild(row);
  }
}

/** 手动添加一个模型名（只认非空、去重）。 */
function addModelFromInput() {
  const inp = $('#modelInput');
  const id = (inp && inp.value || '').trim();
  if (!id) return;
  if (state.editorModels.some((m) => m.id === id)) {
    state.editorModelId = id;
    renderModelRows();
    if (inp) inp.value = '';
    return;
  }
  state.editorModels.push({ id });
  if (!state.editorModelId) state.editorModelId = id;
  if (inp) inp.value = '';
  renderModelRows();
}

/* ———— 「获取可用模型」：可搜索、可多选，点「添加所选」才写进列表 ———— */
state.pickerModels = [];

function closeModelPicker() {
  const box = $('#modelPicker');
  if (box) box.classList.add('hidden');
  state.pickerModels = [];
  const list = $('#modelPickList');
  if (list) list.innerHTML = '';
}

/** 打开选择器，展示候选模型（默认全不勾；服务商没返回就如实说）。 */
function openModelPicker(candidates) {
  state.pickerModels = candidates.map((m) => ({ id: m.id, name: m.name || '', ownedBy: m.ownedBy || '', checked: false }));
  const box = $('#modelPicker');
  if (!box) return;
  box.classList.remove('hidden');
  const search = $('#modelPickSearch');
  if (search) search.value = '';
  renderModelPicker('');
  const st = $('#modelPickStatus');
  if (st) st.textContent = '获取到 ' + candidates.length + ' 个模型，勾选后点「添加所选」。';
}

/** 渲染候选清单；query 过滤时**不清除**隐藏项的勾选（与 DSH 一致）。 */
function renderModelPicker(query) {
  const list = $('#modelPickList');
  if (!list) return;
  const q = String(query || '').trim().toLowerCase();
  list.innerHTML = '';
  let visible = 0;
  for (let i = 0; i < state.pickerModels.length; i += 1) {
    const m = state.pickerModels[i];
    /* 搜索同时匹配 id 与显示名（与 DSH 的选择器一致） */
    const hay = (m.id + ' ' + (m.name || '') + ' ' + (m.ownedBy || '')).toLowerCase();
    if (q && hay.indexOf(q) === -1) continue;
    visible += 1;
    const row = el('label', 'mp-item' + (m.checked ? ' checked' : ''), '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!m.checked;
    cb.onchange = () => { m.checked = cb.checked; row.classList.toggle('checked', cb.checked); };
    row.appendChild(cb);
    row.appendChild(el('span', 'mp-name', m.id));
    if (m.ownedBy) row.appendChild(el('span', 'mp-owned', m.ownedBy));
    list.appendChild(row);
  }
  if (!visible) list.appendChild(el('div', 'mp-empty', q ? '没有匹配的模型。' : '服务商没有返回任何模型。'));
}

/** 全选/取消全选：只作用于**当前可见**的结果，避免误勾隐藏项。 */
function setVisibleChecks(checked) {
  const list = $('#modelPickList');
  if (!list) return;
  const boxes = list.querySelectorAll('.mp-item input[type="checkbox"]');
  const q = ($('#modelPickSearch') && $('#modelPickSearch').value) || '';
  const ql = q.trim().toLowerCase();
  let vi = 0;
  for (const m of state.pickerModels) {
    const hay = (m.id + ' ' + (m.name || '') + ' ' + (m.ownedBy || '')).toLowerCase();
    if (ql && hay.indexOf(ql) === -1) continue;
    const node = boxes[vi];
    vi += 1;
    if (!node) continue;
    m.checked = checked;
    node.checked = checked;
    node.closest('.mp-item').classList.toggle('checked', checked);
  }
}

/** 把勾选的候选并进草稿模型列表（已存在的保留用户改过的字段）。 */
function addPickedModels() {
  const picked = state.pickerModels.filter((m) => m.checked);
  if (!picked.length) {
    const st = $('#modelPickStatus');
    if (st) st.textContent = '还没有勾选任何模型。';
    return;
  }
  let added = 0;
  for (const m of picked) {
    if (state.editorModels.some((x) => x.id === m.id)) continue;
    const entry = { id: m.id };
    /* 服务商公布了显示名就带上（有的家 id 很长、name 才是人读的） */
    if (m.name && m.name !== m.id) entry.name = m.name;
    state.editorModels.push(entry);
    added += 1;
  }
  if (!state.editorModelId && state.editorModels.length) state.editorModelId = state.editorModels[0].id;
  closeModelPicker();
  renderModelRows();
  const st = $('#settingsResult');
  if (st) { st.textContent = '已添加 ' + added + ' 个模型' + (added < picked.length ? '（其余已存在）' : ''); st.className = 'settings-result ok'; }
}

/* ———— 服务商行（对齐 DSH：已配置的在上，未配置的在下） ———— */
function renderProviderRows() {
  const box = $('#providerRows');
  if (!box) return;
  box.innerHTML = '';
  const configured = state.profiles.filter((p) => p.hasKey);
  const unconfigured = state.profiles.filter((p) => !p.hasKey);
  if (!state.profiles.length) {
    box.appendChild(el('li', 'provider-empty', '还没有服务商。点下面的「添加服务商」选一家、填好 Key。'));
    return;
  }
  for (const p of [...configured, ...unconfigured]) {
    const li = el('li', 'provider-row' + (p.id === state.activeProfileId ? ' active' : '') + (p.id === state.editingProfileId ? ' editing' : ''), '');
    const head = el('div', 'pr-head', '');
    const idBox = el('span', 'pr-identity', '');
    idBox.appendChild(el('span', 'pr-name', p.name || p.baseUrl));
    /* 密钥状态点：只有「确认配了 Key」才亮绿点；没配就红点（与 DSH 的实心点语义一致）。 */
    const dot = el('span', 'pr-dot' + (p.hasKey ? ' ok' : ' missing'), '');
    dot.title = p.hasKey ? ('API Key 已配置 · ' + (p.keyMasked || '')) : '还没填 API Key';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', dot.title);
    idBox.appendChild(dot);
    if (p.id === state.activeProfileId) idBox.appendChild(el('span', 'pr-tag', '对话中'));
    head.appendChild(idBox);
    const actions = el('span', 'pr-actions', '');
    const edit = el('button', 'btn ghost small', '编辑');
    edit.type = 'button';
    edit.onclick = () => openProfileEditorFor(p.id);
    actions.appendChild(edit);
    const del = el('button', 'btn ghost small danger-inline', '删除');
    del.type = 'button';
    del.onclick = () => deleteProfileClient(p.id);
    actions.appendChild(del);
    head.appendChild(actions);
    li.appendChild(head);
    /* 副行：地址 + 这家有几个模型 + 当前选中的那个 */
    const meta = el('div', 'pr-meta', '');
    meta.appendChild(el('span', 'pr-host', endpointHostOf(p.baseUrl)));
    const ms = modelsOf(p);
    meta.appendChild(el('span', 'pr-models', ms.length + ' 个模型'));
    meta.appendChild(el('span', 'pr-current', '当前：' + (p.model || '未选')));
    li.appendChild(meta);
    box.appendChild(li);
  }
}

/* 激活一家服务商；带 modelId 时同时把它设为该家当前使用的模型。
   这就是「一家服务商一次请求 = 一个模型」的落点：写 config.json 的 model 字段。 */
async function activateProfileClient(id, modelId) {
  const p0 = state.profiles.find((x) => x.id === id);
  try {
    let r = await fetchJSON('/api/profiles/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (!r.ok) throw new Error(r.error || '切换失败');
    state.activeProfileId = r.activeId;
    /* 切模型：先改档案里的「当前模型」，再让它生效 —— 顺序反了会先按旧模型发一次请求。 */
    if (modelId && p0 && modelId !== p0.model) {
      const pr = await fetchJSON('/api/profiles/' + encodeURIComponent(id), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelId }),
      });
      if (!pr.ok) throw new Error(pr.error || '切换模型失败');
    }
    /* 从服务端重新拉一次，保证列表里的「当前：x」是服务端归一化后的真实值。 */
    await loadProfilesUI({ keepEditor: true });
    await refreshStatus();
    syncComposerGear();
    const p = state.profiles.find((x) => x.id === id) || p0;
    toast(modelId ? ('已切换：' + (p ? p.name : '') + ' · ' + modelId) : ('已切换到：' + (p ? p.name : '')));
  } catch (e) {
    toast('切换失败：' + e.message);
  }
}

async function deleteProfileClient(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!confirm('删除这家服务商配置？\n\n' + ((p && p.name) || '') + '\n（Key 会一并从本机删除）')) return;
  try {
    const r = await fetchJSON('/api/profiles/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) throw new Error(r.error || '删除失败');
    if (state.editingProfileId === id) closeProfileEditor();
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
  const baseUrl = currentProviderBaseUrl();
  const out = $('#settingsResult');
  if (!confirmEndpointChange(baseUrl)) {
    if (out) { out.textContent = '已取消：未确认服务商地址。'; out.className = 'settings-result err'; }
    return;
  }
  if (!apiKey && !state.editingProfileId) {
    if (out) { out.textContent = '请填写 API Key。'; out.className = 'settings-result err'; }
    return;
  }
  if (!state.editorModels.length) {
    if (out) { out.textContent = '至少要有 1 个模型：点「获取可用模型」或在下面手动添加。'; out.className = 'settings-result err'; }
    return;
  }
  /* 整张草稿原样写回（只挑服务端认识的白名单字段）。
     不能只发 {id}：服务端模型条目还认 name / contextWindow / maxTokens，
     丢了的话「获取可用模型」带回来的显示名与容量会在保存时被静默抹掉。 */
  const models = state.editorModels.map((m) => {
    const out2 = { id: m.id };
    if (m.name && m.name !== m.id) out2.name = m.name;
    if (m.contextWindow) out2.contextWindow = m.contextWindow;
    if (m.maxTokens) out2.maxTokens = m.maxTokens;
    return out2;
  });
  const model = state.editorModelId || models[0].id;
  try {
    let r;
    if (state.editingProfileId) {
      r = await fetchJSON('/api/profiles/' + encodeURIComponent(state.editingProfileId), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, models, model, baseUrl, apiKey: apiKey || undefined }),
      });
    } else {
      r = await fetchJSON('/api/profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, baseUrl, models, model, apiKey }),
      });
    }
    if (!r.ok) throw new Error(r.error || '保存失败');
    /* 改的就是「当前生效的这家」时，服务端 PUT 已经把它重新写进 config.json + settings.yaml，
       这里不用再发一次 activate（多发一次只会多一次往返和一个多余的 toast）。 */
    await loadProfilesUI();
    await refreshStatus();
    if (out) {
      out.textContent = '已保存' + (r.activated ? '并已启用' : '') + ' · ' + models.length + ' 个模型 · 发往 ' + endpointHostOf(baseUrl);
      out.className = 'settings-result ok';
    }
  } catch (e) {
    if (out) { out.textContent = '' + e.message; out.className = 'settings-result err'; }
  }
}

/* ———— 对话框模型席：按服务商分组的模型列表（对齐 DSH 的 model 面板） ———— */
/* 触发按钮上显示的是**当前实际生效**的模型名；点开后按服务商分组列出全部可选模型。
   选中的写回 dossier（一家服务商一次只能用一个模型），并立刻生效。 */

/** 当前生效的「服务商 + 模型」（state.status 是服务端归一化后的权威值）。 */
function currentSelection() {
  const p = (state.profiles || []).find((x) => x.id === state.activeProfileId) || null;
  return { profile: p, model: (p && p.model) || (state.status && state.status.model) || '' };
}

/** 分组：每一家服务商 = 一组，组内是它名下可选的模型。 */
function modelGroups() {
  return (state.profiles || []).map((p) => ({ id: p.id, name: p.name || p.baseUrl, models: modelsOf(p) }))
    .filter((g) => g.models.length);
}

async function refreshComposerModelSelect() {
  renderComposerGearMenu();
}

/** 渲染对话框上的模型席（收起态文字 + 展开后的分组列表）。 */
function renderComposerGearMenu() {
  const seat = $('#gearModel');
  if (seat) {
    const cur = currentSelection();
    seat.textContent = cur.model || '未配置';
  }
  const list = $('#gearModelList');
  if (!list) return;
  list.innerHTML = '';
  const groups = modelGroups();
  if (!groups.length) {
    list.appendChild(el('div', 'gear-model-empty', '还没有可用的模型，去设置里添加服务商。'));
    return;
  }
  const cur = currentSelection();
  let selectedBtn = null;
  for (const g of groups) {
    const sec = el('div', 'gear-model-group', '');
    const head = el('div', 'gear-model-group-title', g.name);
    head.title = g.name;
    sec.appendChild(head);
    for (const m of g.models) {
      const on = !!cur.profile && cur.profile.id === g.id && m.id === cur.model;
      const btn = el('button', 'gear-model-option' + (on ? ' selected' : ''), '');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.appendChild(el('span', 'gmo-name', m.id));
      const check = el('span', 'gmo-check', '');
      /* ic() 返回的是 SVG 字符串，必须经 setIcon 解析成节点 —— appendChild 只收 Node。 */
      if (on) setIcon(check, 'check', 14);
      btn.appendChild(check);
      btn.onclick = () => { activateProfileClient(g.id, m.id); };
      sec.appendChild(btn);
      if (on) selectedBtn = btn;
    }
    list.appendChild(sec);
  }
  /* 当前选中的那个滚进可视区：模型多了以后，分组列表会超出 max-height，
     不滚的话打开菜单看到的是一堆没选中的模型，得自己往下找。 */
  if (selectedBtn && selectedBtn.scrollIntoView) {
    try { selectedBtn.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  }
}

/* 兼容旧调用点：控件菜单原先是个 <select>，现在改成分组列表，不需要额外绑定。 */
async function bindComposerModelSelect() {
  renderComposerGearMenu();
}
/* 模型 + 推理等级：一个控件（Codex 风格滑条，见 effort-slider.js 与本文件 initComposerGear）
   旧的两个并排下拉（composerModelSelect / composerEffortSelect）已并入这里；
   思考强度的存取契约不变（config.reasoningEffort），只是入口换成了滑条。 */

/** 席按钮上显示的模型名：当前服务商选中的那个模型（DSH 的触发按钮只显示模型名）。 */
function composerGearModelName() {
  const cur = currentSelection();
  return cur.model || '未配置';
}
/** 把权威状态推进控件：档位只认 state.status（服务端归一化过的值）。 */
function syncComposerGear() {
  const valueEl = $('#gearModelValue');
  if (valueEl) valueEl.textContent = composerGearModelName();
  renderComposerGearMenu();
  if (!window.AcademyEffort) return;
  window.AcademyEffort.sync({
    effort: (state.status && state.status.reasoningEffort) || 'high',
    modelName: composerGearModelName(),
    busy: !!state.busy,
  });
}
/** 思考强度写入：失败时抛错，好让滑条回滚到真实档位（不谎报成功）。 */
async function onComposerEffortChange(val) {
  const eff = ['off', 'low', 'high', 'max'].includes(val) ? val : 'high';
  const r = await fetchJSON('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reasoningEffort: eff }) });
  if (!r.ok) throw new Error(r.error || '保存失败');
  if (state.status) state.status.reasoningEffort = r.reasoningEffort || eff;
  toast('推理等级：' + ({ off: '关闭', low: '轻量', high: '标准', max: '最强' }[eff] || eff));
}
function initComposerGear() {
  if (!window.AcademyEffort) return;
  window.AcademyEffort.init({
    getModelName: composerGearModelName,
    onModelChange: (id) => { if (id) activateProfileClient(id); },
    onEffortChange: onComposerEffortChange,
  });
  syncComposerGear();
}

/* 「获取可用模型」：拉服务商的 /models，落进可搜索多选的选择器。
   不直接写进列表 —— 点「添加所选」才写（与 DSH 的「获取可用模型 → 添加所选」一致）。 */
async function loadModels() {
  const out = $('#settingsResult');
  const apiKey = ($('#apiKeyInput').value || '').trim();
  const baseUrl = currentProviderBaseUrl();
  const hasSaved = !!(state.status && state.status.hasKey);
  if (!apiKey && !hasSaved) {
    if (out) { out.textContent = '请先填写 API Key，再获取模型列表。'; out.className = 'settings-result err'; }
    return;
  }
  closeModelPicker();
  if (out) { out.textContent = '正在获取模型列表…'; out.className = 'settings-result'; }
  try {
    const body = { baseUrl };
    if (apiKey) body.apiKey = apiKey;
    const r = await fetchJSON('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (out) { out.textContent = '' + (r.error || '获取失败'); out.className = 'settings-result err'; }
      return;
    }
    if (!r.models || !r.models.length) {
      if (out) { out.textContent = '服务商没有返回模型，请在下面手动添加模型名。'; out.className = 'settings-result'; }
      return;
    }
    if (out) { out.textContent = ''; out.className = 'settings-result'; }
    openModelPicker(r.models);
  } catch (e) {
    if (out) { out.textContent = '' + e.message; out.className = 'settings-result err'; }
  }
}

/* 兼容旧调用点：以前这里读的是「模型输入框」的值，现在是编辑卡里选中的那个模型。 */
function currentModelValue() {
  return state.editorModelId || (state.editorModels[0] && state.editorModels[0].id) || 'deepseek-flash';
}

function currentBaseUrlValue() {
  return $('#baseUrlInput').value.trim() || 'https://api.deepseek.com';
}

/* ================= 聊天请求（SSE） ================= */
const STREAM_CONNECT_MS = 120000;
const STREAM_QUEUE_MS = 1800000;
const STREAM_IDLE_MS = 90000;
let activeStreamAbort = null;

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label + '超时')), ms); }),
  ]);
}

function stopReasonMsg(reason) {
  if (reason === 'connect') return '无法建立连接，服务端可能未响应';
  if (reason === 'queued') return '排队超时：前面有任务未完成';
  if (reason === 'running') return (typeof I18N !== 'undefined' && I18N.t) ? I18N.t('ai.timeout') : '本次请求超时，请重试';
  return '已停止';
}

async function streamChat(mode, text, history, onEvent, opts) {
  opts = opts || {};
  let phase = 'connect';
  let timer = null;
  let stopReason = null;
  const ac = new AbortController();
  function arm() {
    clearTimeout(timer);
    const ms = phase === 'connect' ? STREAM_CONNECT_MS : phase === 'queued' ? STREAM_QUEUE_MS : STREAM_IDLE_MS;
    timer = setTimeout(() => { stopReason = phase; try { ac.abort(); } catch (_) {} }, ms);
  }
  function release() { clearTimeout(timer); if (activeStreamAbort && activeStreamAbort.ctrl === ac) activeStreamAbort = null; }
  activeStreamAbort = { ctrl: ac, stop: (reason) => { stopReason = reason || 'manual'; try { ac.abort(); } catch (_) {} } };
  arm();
  let res;
  try {
    res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, text, history }),
      signal: ac.signal,
    });
  } catch (e) {
    release();
    if (stopReason) throw new Error(stopReasonMsg(stopReason));
    throw new Error((e && e.message) || '无法建立连接');
  }
  if (!res.ok || !res.body) {
    release();
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.message || j.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  phase = 'queued';
  arm();
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
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
        if (event === 'start') phase = 'running';
        else if (event === 'queued') phase = 'queued';
        arm();
        if (onEvent) onEvent(event, data);
      }
    }
  } catch (e) {
    release();
    if (stopReason) throw new Error(stopReasonMsg(stopReason));
    throw e;
  }
  release();
  if (stopReason) throw new Error(stopReasonMsg(stopReason));
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
  input.value = '';
  updateCharCount();
  input.style.height = 'auto';
  startTurn(text);
}

/* startTurn：推入 assistant 占位并跑一轮流式生成。
   调用约定：state.messages 的最后一条是本轮的 user 消息（sendMessage 与重答共用）。 */
function startTurn(text) {
  state.messages.push({ role: 'assistant', text: '', running: true, time: Date.now(), streamText: '', reasoning: '', tools: [] });
  persistChat();
  renderMessages();
  renderHistory();
  scrollBottom();   // 自己发起的对话总是跟到底（即使刚才在往上翻）

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
    if (event === 'queued') {
      lastStatus = data.interrupt ? '已插话：正在暂停当前任务，你的消息马上开始…' : ('已排队第 ' + data.pos + ' 位，等待前面的任务完成…');
      updateRunningMessage({ statusText: lastStatus });
    } else if (event === 'start') {
      lastStatus = '引擎已启动，正在加载知识库…';
    } else if (event === 'status') {
      if (data.stage === 'launching') lastStatus = data.message || lastStatus;
      else if (data.stage === 'running') lastStatus = 'Agent 工作中… 已运行 ' + fmtElapsed(data.elapsedMs || 0);
    } else if (event === 'delta') {
      streamed += (data.text || '');
      // 带 dt 时按真实时序回放（内核整段落盘，dt 是事后补记的真实间隔）
      updateRunningMessage({ streamText: streamed, statusText: lastStatus, dt: data.dt, texts: data.texts, time0: data.time0 });
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
          m.tools.push({ callId: data.callId, name: data.name || '工具', detail: data.detail || '', detailStart: data.detail || '', done: false });
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
      // 备赛/复盘/评判：一轮跑完就把这场对话归档到识别出的辩题下
      try { if (state.mode === 'prep' || state.mode === 'review' || state.mode === 'judge') caseAutoArchive(currentChat()); } catch (_) {}
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
    if (m) {
      m.streamText = undefined;
      resetSmoothStream();
      const partial = cleanMemoryText((streamed || '').trim());
      if (m.cancelled) {
        m.text = partial || '（已停止）';
      } else {
        m.text = partial || m.text || undefined;
        m.error = err.message || '请求失败';
      }
      m.running = false;
      m.time = Date.now();
    }
    persistChat();
    finishRun();
    if (m && m.cancelled && !m.error) toast('已停止');
    renderMessages();
  });
}

/* 重答：移除最后一条回复，按前一条提问重新生成（只允许对末条回复操作） */
function regenerateLast() {
  if (state.running) { toast('当前有任务在跑，等它结束再重答'); return; }
  const ms = state.messages;
  if (!ms.length || ms[ms.length - 1].role !== 'assistant') return;
  if (ms.length < 2 || ms[ms.length - 2].role !== 'user') return;
  if (!state.status || !state.status.hasKey) { openSettings(); return; }
  const prev = ms[ms.length - 2];
  ms.splice(ms.length - 1);
  if (Array.isArray(prev.attachments) && prev.attachments.length) toast('原提问带附件，重答只基于文字部分');
  renderMessages();
  startTurn(prev.text === '（见附件）' ? '' : prev.text);
}

/* 一键存产物：把这条回复存成产物空间的 Markdown 文件 */
async function saveMsgToDeliver(m, titleOverride) {
  try {
    const text = (m.text || '').trim();
    if (!text) { toast('这条回复没有内容可存'); return; }
    const chat = currentChat();
    const rawTitle = titleOverride || (chat && chat.title) || '对话';
    const safe = rawTitle.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
    const name = new Date().toISOString().slice(0, 10) + '_' + safe + '_回复.md';
    const r = await fetchJSON('/api/deliverables/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content: text }),
    });
    toast('已存为产物：' + r.name + '（📦 产物里可转 Word/PDF）');
    try { loadDeliverables(); } catch (_) {} // 产物面板开着时立即看到新文件
  } catch (e) { toast('存产物失败：' + e.message); }
}

/* ===== 产物面板 · 收藏 tab（跨对话汇总 ⭐ 的回复） ===== */
function renderDeliverStars() {
  const box = $('#deliverStarsList'); if (!box) return;
  box.innerHTML = '';
  const stars = [];
  for (const c of (state.chats || [])) {
    for (const m of (c.messages || [])) {
      if (m.role === 'assistant' && m.starred && (m.text || '').trim()) stars.push({ chat: c, msg: m });
    }
  }
  stars.sort((a, b) => (b.msg.time || 0) - (a.msg.time || 0));
  if (!stars.length) {
    box.appendChild(el('div', 'skill-empty', '还没有收藏。对话里点回复下方的「⭐ 收藏」，它们会跨对话汇总到这里。'));
    return;
  }
  for (const s of stars) {
    const card = el('div', 'star-item');
    const head = el('div', 'star-item-head');
    head.appendChild(el('span', null, ic('free',12) + ' ' + esc(s.chat.title || '未命名对话')));
    head.appendChild(el('span', null, ic('clock',12) + ' ' + fmtTime(s.msg.time || s.chat.updated)));
    card.appendChild(head);
    const tx = el('div', 'star-item-text', (s.msg.text || '').replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) + '…');
    tx.title = (s.msg.text || '').slice(0, 300);
    card.appendChild(tx);
    const acts = el('div', 'star-item-actions');
    const bGo = el('button', 'btn ghost small', '查看原文'); bGo.type = 'button'; bGo.onclick = () => jumpToStarred(s.chat.id);
    const bCopy = el('button', 'btn ghost small', '复制'); bCopy.type = 'button'; bCopy.onclick = () => copyText(s.msg.text || '');
    const bSave = el('button', 'btn ghost small', ic('save',13) + '存产物'); bSave.type = 'button'; bSave.onclick = () => saveMsgToDeliver(s.msg, s.chat.title);
    const bDel = el('button', 'btn ghost small danger', '取消收藏'); bDel.type = 'button';
    bDel.onclick = () => {
      s.msg.starred = false;
      saveChats();
      if (s.chat.id === state.chatId) renderMessages();
      renderDeliverStars();
    };
    acts.appendChild(bGo); acts.appendChild(bCopy); acts.appendChild(bSave); acts.appendChild(bDel);
    card.appendChild(acts);
    box.appendChild(card);
  }
}

function jumpToStarred(chatId) {
  const c = state.chats.find((x) => x.id === chatId);
  if (!c) return;
  if (c.mode !== state.mode) { state.mode = c.mode; updateModeUI(); }
  switchChat(chatId);
  $('#deliverModal').classList.add('hidden');
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
  const m = state.messages.find((x) => x.running);
  if (m) {
    m.cancelled = true;
    updateRunningMessage({ statusText: '正在停止…' });
  }
  // 先本地断开 SSE，再通知服务端：服务端不可达时界面也不会卡在"运行中"
  if (activeStreamAbort) { try { activeStreamAbort.stop('manual'); } catch (_) {} }
  withTimeout(fetchJSON('/api/cancel', { method: 'POST' }), 5000, '停止请求').catch((e) => toast(e.message));
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
  if (/\.pdf$/i.test(name)) return ic('file', 14);
  if (/\.docx?$/i.test(name)) return ic('file', 14);
  if (/\.(md|markdown)$/i.test(name)) return ic('edit', 14);
  if (/\.srt$/i.test(name)) return ic('free', 14);
  return ic('file', 14);
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
  ['__research__', '研究台', '边查资料边和教练聊：搜索 + 7 触发条件建议 + 独立研究对话（独立小窗）'],
  ['__verify__', '证据检证', '核查论据是否被编造 / 曲解 / 断章取义，真联网查原始出处（独立小窗）'],
  ['__trace__', '资料溯源', '追一段资料的最早出处与原文，梳理流传链、查讹传（独立小窗）'],
  ['__mdReader__', 'MD 阅读器', '打开本地 Markdown / 文本文件阅读'],
  ['辩案工作台-Case-Workbench.html', '辩案工作台', '九步法构建完整辩案'],
  ['简易流水单-Flowing-Tool.html', '简易流水单', '比赛攻防流水记录'],
];

/* 独立工具窗（Electron 单独进程）的统一入口：
   三个窗都走 tool-window.js 通用壳，name 与 app/tool-registry.js 的注册项对应。 */
const TOOL_WINDOWS = {
  '__research__': { icon: 'search', tool: 'research', fail: '研究台是独立小窗，需要桌面版（Electron）环境；浏览器模式下请用双击文件的方式打开' },
  '__verify__': { icon: 'shield', tool: 'verify', fail: '证据检证是独立小窗，需要桌面版（Electron）环境' },
  '__trace__': { icon: 'library', tool: 'trace', fail: '资料溯源是独立小窗，需要桌面版（Electron）环境' },
};

function renderTools() {
  const box = $('#toolsList');
  box.innerHTML = '';
  for (const [file, name, desc] of TOOL_INFO) {
    if (TOOL_WINDOWS[file]) {
      // 独立轻量窗：研究台 / 证据检证 / 资料溯源（各自独立 Electron 进程）
      const tw = TOOL_WINDOWS[file];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool-link';
      /* data-tool 是给 UI 巡检认的 stable 标识：这些按钮一点就 spawn 真实窗口，
         巡检必须跳过；界面文案会随简繁切换变字，不能拿文案当判据。 */
      b.dataset.tool = tw.tool;
      b.innerHTML = '<span class="tool-link-text"><b>' + esc(name) + '</b><small>' + esc(desc) + '</small></span>' +
        '<span class="tool-link-go">' + ic('chevronRight', 16) + '</span>';
      b.onclick = async () => {
        try {
          const ae = window.academyElectron;
          if (ae && ae.openToolWindow) {
            const r = await ae.openToolWindow(tw.tool, academyLocale() === 'en' ? 'en' : '');
            if (r && r.ok) { $('#toolsModal').classList.add('hidden'); return; }
            toast('打开失败：' + ((r && r.error) || ''));
          } else {
            toast(tw.fail);
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
      b.innerHTML = '<span class="tool-link-text"><b>' + esc(name) + '</b><small>' + esc(desc) + '</small></span>' +
        '<span class="tool-link-go">' + ic('book', 16) + '</span>';
      b.onclick = () => { $('#toolsModal').classList.add('hidden'); openMdReader(); };
      box.appendChild(b);
      continue;
    }
    const a = document.createElement('a');
    a.className = 'tool-link';
    a.href = '/tools/' + encodeURIComponent(file);
    a.target = '_blank';
    a.rel = 'noopener';
    a.innerHTML = '<span class="tool-link-text"><b>' + esc(name) + '</b><small>' + esc(desc) + '</small></span>' +
      '<span class="tool-link-go">' + ic('link', 16) + '</span>';
    box.appendChild(a);
  }
}

/* ================= 产物空间 ================= */
const deliverState = { items: [], search: '', filter: 'all', tab: 'files' };
function deliverFileIcon(name) {
  const e = String(name||'').split('.').pop().toLowerCase();
  if (e==='md'||e==='markdown') return ic('edit', 14);
  if (e==='csv') return ic('chart', 14);
  if (e==='xlsx') return ic('chart', 14);
  if (e==='docx') return ic('file', 14);
  if (e==='pdf') return ic('file', 14);
  if (e==='txt') return ic('file', 14);
  return ic('package', 14);
}
async function loadDeliverables() {
  try {
    const r = await fetchJSON('/api/deliverables');
    deliverState.items = (r.items || []);
    $('#deliverMeta').textContent = '共 ' + r.count + ' 个文件 · 位置 data/deliverables/';
    renderDeliverList();
  } catch (e) { $('#deliverMeta').textContent = '读取失败：' + e.message; }
}
function deliverFileCategory(name) {
  const e = String(name || '').split('.').pop().toLowerCase();
  if (['md', 'markdown', 'txt', 'json', 'html', 'srt', 'log'].includes(e)) return 'doc';
  if (e === 'pdf') return 'pdf';
  if (e === 'docx') return 'word';
  if (e === 'csv' || e === 'xlsx') return 'table';
  return 'other';
}
function renderDeliverList() {
  const box = $('#deliverList'); if (!box) return;
  box.innerHTML = '';
  const q = deliverState.search.toLowerCase().trim();
  const items = deliverState.items.filter((i) =>
    (deliverState.filter === 'all' || deliverFileCategory(i.name) === deliverState.filter) &&
    (!q || i.name.toLowerCase().includes(q)));
  if (!items.length) { box.appendChild(el('div','skill-empty', (q || deliverState.filter !== 'all') ? '这个分类下没有匹配的文件。' : '产物空间还空着——让教练写一份备赛包/复盘报告，或点回复下方的「💾 存产物」。')); return; }
  for (const it of items) {
    const card = el('div','deliver-item');
    const head = el('div','deliver-item-head');
    head.appendChild(el('span','deliver-item-icon', deliverFileIcon(it.name)));
    const nm = el('span','deliver-item-name', it.name); nm.title = it.name; head.appendChild(nm);
    head.appendChild(el('span','deliver-item-size', (it.size>=1048576 ? (it.size/1048576).toFixed(1)+'MB' : Math.max(1,Math.round(it.size/1024))+'KB')));
    card.appendChild(head);
    const meta = el('div','deliver-item-meta');
    meta.appendChild(el('span',null, ic('clock',12) + ' ' + fmtTime(it.mtime) + (it.textType ? ' · 文本' : ' · 文件')));
    card.appendChild(meta);
    const acts = el('div','deliver-item-actions');
    const bPrev = el('button','btn ghost small','预览'); bPrev.type='button'; bPrev.onclick = () => deliverPreview(it);
    const bSave = el('button','btn ghost small','导出到文件夹'); bSave.type='button'; bSave.onclick = () => deliverSaveAs(it);
    acts.appendChild(bPrev); acts.appendChild(bSave);
    if (it.textType && /md|markdown|txt/.test(it.ext)) { const bW=el('button','btn ghost small','转 Word'); bW.type='button'; bW.onclick=()=>deliverConvert(it,'docx'); acts.appendChild(bW); }
    if (it.ext==='csv') { const bX=el('button','btn ghost small','转 Excel'); bX.type='button'; bX.onclick=()=>deliverConvert(it,'xlsx'); acts.appendChild(bX); }
    if (it.textType) { const bP=el('button','btn ghost small','存 PDF'); bP.type='button'; bP.onclick=()=>deliverPdf(it); acts.appendChild(bP); }
    // 文本类产物可一键送进资料库（引用式：不复制内容，永远读最新版）
    if (it.textType && ['md','markdown','txt','csv','srt','log','json','html'].includes(String(it.ext).toLowerCase())) {
      const bLib = el('button','btn ghost small', ic('library',13) + '存入资料库');
      bLib.type='button';
      bLib.title = '存为资料库条目（引用式，跟随这份产物更新）；之后备赛/复盘会自动召回';
      bLib.onclick=()=>deliverToLibrary(it);
      acts.appendChild(bLib);
    }
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
    else box.innerHTML = mdToHtml(r.file.text.slice(0,60000)); // window.MDView 在主窗口不存在，旧写法一直掉 <pre> 纯文本兜底
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
  'h1{font-size:1.6em;color:#120A8F}' +
  'h2{font-size:1.35em;color:#120A8F}' +
  'h3{font-size:1.15em;color:#333}' +
  'h1,h2,h3{border-bottom:1px solid #e5e7ee;padding-bottom:.3em;margin-top:1.4em;page-break-after:avoid}' +
  'p{margin:.6em 0;orphans:2;widows:2}' +
  'pre{background:#f5f7fb;padding:12px;border-radius:6px;overflow:hidden;font-size:12px;white-space:pre-wrap;word-break:break-all;page-break-inside:avoid}' +
  'code{background:#f0f2f7;padding:1px 5px;border-radius:4px;font-size:.92em}' +
  'blockquote{border-left:3px solid #9A9AA0;margin:8px 0;padding:2px 14px;color:#4A4A50}' +
  'table{border-collapse:collapse;margin:10px 0;width:100%}' +
  'tr{page-break-inside:avoid}' +
  'th,td{border:1px solid #D8D8DE;padding:5px 10px}' +
  'th{background:#F2F2F5}' +
  'ul,ol{margin:.5em 0;padding-left:1.6em}li{margin:.25em 0}' +
  'a{color:#120A8F}';

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
/* 产物 → 资料库：引用式。存的是「指向这份产物的指针」，
   所以产物后续修改会自动反映到召回里，不会出现两份不同步的副本。 */
async function deliverToLibrary(it) {
  if (!it || !it.name) return;
  try {
    const r = await libApi('/api/library/from-deliverable', { name: it.name });
    if (r && r.ok) {
      if (r.duplicated) toast('这份产物已经在资料库里了');
      else toast('已存入资料库：' + r.item.name + '（引用式，跟随原件更新）');
    } else {
      toast('入库失败：' + ((r && r.error) || '未知错误'));
    }
  } catch (e) { toast('入库失败：' + e.message); }
}
async function deliverDelete(name) {
  if (!window.confirm('删除产物「' + name + '」？')) return;
  const r = await libApi('/api/deliverables/delete', { name });
  if (r && r.ok) { toast('已删除'); loadDeliverables(); } else toast('删除失败：' + ((r&&r.error)||''));
}
/* ===== C 档：产物空间影子快照（还原中心） ===== */
async function loadDeliverSnapshots() {
  const box = document.getElementById('deliverSnapList'); if (!box) return;
  box.innerHTML = '<span class="hint">加载中…</span>';
  try {
    const r = await fetchJSON('/api/deliverables/snapshots');
    const items = r.items || [];
    box.innerHTML = '';
    if (!items.length) { box.innerHTML = '<span class="hint">还没有快照——开始一次对话后自动生成。</span>'; return; }
    for (const it of items) {
      const row = document.createElement('div'); row.className = 'deliver-item';
      const label = document.createElement('span');
      label.textContent = fmtTime(it.time) + ' · ' + (it.files === null ? '?' : it.files) + ' 个文件 · ' + it.id;
      label.style.flex = '1';
      row.appendChild(label);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = '还原到这里';
      b.onclick = async () => {
        if (!window.confirm('把产物空间整体还原到「' + fmtTime(it.time) + '」之前？\n当前产物会先自动存档，可再还原回来。')) return;
        const rr = await libApi('/api/deliverables/restore', { id: it.id });
        if (rr && rr.ok) { toast('已还原：' + rr.files + ' 个文件'); loadDeliverables(); loadDeliverSnapshots(); }
        else toast('还原失败：' + ((rr && rr.error) || ''));
      };
      row.appendChild(b);
      box.appendChild(row);
    }
  } catch (e) { box.innerHTML = '<span class="hint">读取失败：' + e.message + '</span>'; }
}
function bindDeliverables() {
  const btn = $('#btnDeliver'); if (btn) btn.onclick = () => { $('#deliverModal').classList.remove('hidden'); loadDeliverables(); renderDeliverStars(); };
  const rf = $('#btnDeliverRefresh'); if (rf) rf.onclick = loadDeliverables;
  const snap = $('#btnDeliverSnap');
  if (snap) snap.onclick = () => {
    const pane = $('#deliverSnapPane'); if (!pane) return;
    const show = pane.classList.contains('hidden');
    pane.classList.toggle('hidden', !show);
    if (show) loadDeliverSnapshots();
  };
  const srch = $('#deliverSearch');
  if (srch) srch.oninput = () => { deliverState.search = srch.value; renderDeliverList(); };
  // 文件类型分类片
  document.querySelectorAll('#deliverChips .chip').forEach((c) => {
    c.onclick = () => {
      deliverState.filter = c.dataset.dfilter || 'all';
      document.querySelectorAll('#deliverChips .chip').forEach((x) => x.classList.toggle('active', x === c));
      renderDeliverList();
    };
  });
  // 文件 / 辩题 / 收藏 三 tab
  document.querySelectorAll('.deliver-tab').forEach((t) => {
    t.onclick = () => switchDeliverTab(t.dataset.dtab || 'files');
  });
  bindCases();
  const folder = $('#btnDeliverFolder');
  if (folder) folder.onclick = () => { const ae=window.academyElectron; if (ae && ae.showDeliverFolder) ae.showDeliverFolder(); else toast('浏览器模式不可用'); };
  const close = $('#btnDeliverPreviewClose'); if (close) close.onclick = () => $('#deliverPreview').classList.add('hidden');


/* ================= 辩题档案夹（产物空间 → 🗂 辩题） =================
   索引在服务端（data/cases.json），这里只负责渲染与操作。 */
const caseState = { items: [], search: '', loading: false };

async function loadCases() {
  if (caseState.loading) return;
  caseState.loading = true;
  try {
    const r = await fetchJSON('/api/cases');
    caseState.items = (r && r.cases) || [];
  } catch (_) { caseState.items = []; }
  caseState.loading = false;
  renderCases();
}

function renderCases() {
  const box = $('#caseList');
  if (!box) return;
  box.innerHTML = '';
  const q = caseState.search.trim().toLowerCase();
  const items = caseState.items.filter((c) => !q || String(c.motion || '').toLowerCase().includes(q));
  const meta = $('#caseMeta');
  if (meta) meta.textContent = items.length ? ('共 ' + items.length + ' 个辩题') : '';
  if (!items.length) {
    box.appendChild(el('div', 'skill-empty', q ? '没有匹配的辩题。' : '还没有辩题档案。备赛时写明辩题，Agent 会自动归档；也可以点「＋ 新建辩题」手动建。'));
    return;
  }
  for (const c of items) {
    const card = el('div', 'case-card', '');
    const head = el('div', 'case-card-head', '');
    const titleBox = el('div', 'case-card-title', '');
    titleBox.appendChild(el('span', 'case-motion', c.motion || '（未命名辩题）'));
    if (c.side) titleBox.appendChild(el('span', 'case-side', c.side));
    head.appendChild(titleBox);
    const ops = el('div', 'case-card-ops', '');
    const bOpen = el('button', 'btn ghost small', '打开对话');
    bOpen.title = '跳到这个辩题下最近的一次对话';
    bOpen.onclick = () => caseOpenChat(c);
    ops.appendChild(bOpen);
    const bEdit = el('button', 'btn ghost small', '改名');
    bEdit.onclick = () => caseRename(c);
    ops.appendChild(bEdit);
    const bDel = el('button', 'btn ghost small danger', '删除');
    bDel.title = '只删除这条辩题索引，对话和产物文件都会保留';
    bDel.onclick = () => caseRemove(c);
    ops.appendChild(bDel);
    head.appendChild(ops);
    card.appendChild(head);

    const sub = el('div', 'case-card-meta', '');
    sub.textContent = c.chats.length + ' 次对话 · ' + c.deliverables.length + ' 份产物 · 更新于 ' + caseFmtTime(c.updated);
    card.appendChild(sub);

    if (c.chats.length) {
      const ul = el('div', 'case-sub-list', '');
      for (const ch of c.chats.slice(0, 6)) {
        const row = el('button', 'case-sub-item', '');
        row.appendChild(el('span', 'case-sub-title', ch.title || '未命名'));
        if (ch.mode) row.appendChild(el('span', 'case-sub-mode', (MODES[ch.mode] || {}).title || ch.mode));
        if (String(ch.title).indexOf('（对话已删除）') === -1) row.onclick = () => caseOpenChatById(c, ch.id);
        else row.classList.add('disabled');
        ul.appendChild(row);
      }
      if (c.chats.length > 6) ul.appendChild(el('div', 'case-sub-more', '…还有 ' + (c.chats.length - 6) + ' 次对话'));
      card.appendChild(ul);
    }
    if (c.deliverables.length) {
      const dl = el('div', 'case-sub-list', '');
      for (const nm of c.deliverables.slice(0, 8)) {
        const row = el('button', 'case-sub-item', '');
        row.appendChild(el('span', 'case-sub-title', ic('file',13) + ' ' + nm));
        row.onclick = () => { deliverState.tab = 'files'; switchDeliverTab('files'); deliverPreview({ name: nm }); };
        dl.appendChild(row);
      }
      card.appendChild(dl);
    }
    box.appendChild(card);
  }
}

function caseFmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 跳到辩题下的对话：跨模式自动切（对话按模式隔离，必须先切模式） */
async function caseOpenChatById(c, chatId) {
  const target = c.chats.find((x) => x.id === chatId);
  if (!target) { toast('找不到这个对话'); return; }
  if (target.mode && target.mode !== state.mode) switchMode(target.mode);
  const exists = state.chats.some((x) => x.id === chatId);
  if (!exists) { toast('这个对话已不在本机'); return; }
  await switchChat(chatId);
  $('#deliverModal').classList.add('hidden');
}
async function caseOpenChat(c) {
  const alive = (c.chats || []).filter((x) => String(x.title).indexOf('（对话已删除）') === -1);
  if (!alive.length) { toast('这个辩题下没有可打开的对话'); return; }
  // 最近更新的排前面：索引里 chats 是按挂载顺序，这里用列表顺序兜底
  await caseOpenChatById(c, alive[0].id);
}

async function caseRename(c) {
  /* 不能用 window.prompt —— Electron 里直接抛错（点了没反应），见 askInput 注释 */
  const r = await askInput({
    title: '编辑辩题',
    fields: [
      { key: 'motion', label: '辩题名称', value: c.motion || '' },
      { key: 'side', label: '持方', value: c.side || '', optional: true }
    ]
  });
  if (!r) return;
  const motion = r.motion;
  const side = r.side; /* 可留空字段返回 '' —— 与原 prompt 语义一致，留空即清空 */
  if (!motion) { toast('辩题名称不能为空'); return; }
  try {
    const res = await libApi('/api/cases/update', { id: c.id, motion, side });
    if (res && res.ok) { toast('已更新'); loadCases(); }
    else toast('更新失败：' + ((res && res.error) || '未知错误'));
  } catch (e) { toast('更新失败：' + e.message); }
}

async function caseRemove(c) {
  if (!window.confirm('删除辩题「' + (c.motion || '未命名') + '」？\n\n只删除这条归档索引，你的对话记录和产物文件都会保留。')) return;
  try {
    const r = await libApi('/api/cases/delete', { id: c.id });
    if (r && r.ok) { toast('已删除辩题归档'); loadCases(); }
    else toast('删除失败：' + ((r && r.error) || '未知错误'));
  } catch (e) { toast('删除失败：' + e.message); }
}

async function caseCreate() {
  const motionEl = $('#caseNewMotion');
  const sideEl = $('#caseNewSide');
  const motion = (motionEl && motionEl.value || '').trim();
  if (!motion) { toast('先填上辩题'); return; }
  try {
    // 当前对话也一起挂上去：新建辩题通常就是为眼前这场备赛
    const r = await libApi('/api/cases/attach', { motion, side: (sideEl && sideEl.value || '').trim(), chatId: state.chatId || '' });
    if (r && r.ok) {
      toast('已创建辩题档案');
      if (motionEl) motionEl.value = '';
      if (sideEl) sideEl.value = '';
      $('#caseNewForm').classList.add('hidden');
      loadCases();
    } else toast('创建失败：' + ((r && r.error) || '未知错误'));
  } catch (e) { toast('创建失败：' + e.message); }
}

/* 备赛/复盘/评判对话跑完一轮后，自动把当前对话归档到识别出的辩题下 */
let _caseAutoDone = {};
async function caseAutoArchive(chat) {
  if (!chat || !chat.id || _caseAutoDone[chat.id]) return;
  const firstUser = (chat.messages || []).find((m) => m.role === 'user');
  if (!firstUser || !firstUser.text) return;
  try {
    const g = await libApi('/api/cases/guess', { text: firstUser.text });
    if (!g || !g.ok || !g.motion) return;
    _caseAutoDone[chat.id] = true;
    await libApi('/api/cases/attach', { motion: g.motion, chatId: chat.id });
  } catch (_) {}
}

function bindCases() {
  const srch = $('#caseSearch');
  if (srch) srch.oninput = () => { caseState.search = srch.value; renderCases(); };
  const bNew = $('#btnCaseNew');
  if (bNew) bNew.onclick = () => { const f = $('#caseNewForm'); f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) $('#caseNewMotion').focus(); };
  const bCancel = $('#btnCaseNewCancel');
  if (bCancel) bCancel.onclick = () => $('#caseNewForm').classList.add('hidden');
  const bSave = $('#btnCaseNewSave');
  if (bSave) bSave.onclick = caseCreate;
  const bRef = $('#btnCaseRefresh');
  if (bRef) bRef.onclick = loadCases;
}

/* 切 tab（供外部调用，如从辩题卡点产物名跳回文件页） */
function switchDeliverTab(tab) {
  deliverState.tab = tab || 'files';
  document.querySelectorAll('.deliver-tab').forEach((x) => x.classList.toggle('active', x.dataset.dtab === deliverState.tab));
  const f = $('#deliverFilesPane'); if (f) f.classList.toggle('hidden', deliverState.tab !== 'files');
  const c = $('#deliverCasesPane'); if (c) c.classList.toggle('hidden', deliverState.tab !== 'cases');
  const s = $('#deliverStarsPane'); if (s) s.classList.toggle('hidden', deliverState.tab !== 'stars');
  if (deliverState.tab === 'stars') renderDeliverStars();
  if (deliverState.tab === 'cases') loadCases();
}
}

/* ================= DSH 移植：工作步骤展示 × 繁忙时的发送行为 ================= */
const STEPS_MODES = ['simple', 'standard', 'detailed', 'full'];
const STEPS_LABELS = { simple: '简洁', standard: '标准', detailed: '详细', full: '完全展开' };

/* 发送热键档位（微信式）：ctrlEnter = Ctrl+Enter 发送；enter = Enter 直发、修饰键+Enter 换行 */
function sendHotkeyMode() { return state.sendHotkey === 'enter' ? 'enter' : 'ctrlEnter'; }
function sendHintShort() { return sendHotkeyMode() === 'enter' ? 'Enter 发送' : 'Ctrl+Enter 发送'; }

/* 工具步骤的唯一渲染口径：运行中气泡与重渲染共用，档位来自 设置 → 通用 → 工作步骤展示 */
function toolsBoxHtml(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const mode = STEPS_MODES.includes(state.stepsDisplay) ? state.stepsDisplay : 'standard';
  if (mode === 'simple') {
    const active = tools.filter((t) => !t.done);
    const cur = active.length ? active[active.length - 1] : tools[tools.length - 1];
    return '<div class="tool-item ' + (active.length ? 'active' : 'done') + '">' +
      ic(active.length ? 'plugin' : 'check', 13) + ' <b>' + esc(cur.name) + '</b>' +
      '<span class="tool-detail">' + (active.length ? '进行中' : '已完成') + ' · 共 ' + tools.length + ' 步</span></div>';
  }
  const showDetail = mode === 'detailed' || mode === 'full';
  return tools.map((t) => {
    const args = mode === 'full' && t.detailStart && t.detailStart !== t.detail
      ? '<span class="tool-detail tool-args">参数 ' + esc(t.detailStart) + '</span>' : '';
    const detail = showDetail && t.detail ? '<span class="tool-detail">' + esc(t.detail) + '</span>' : '';
    return '<div class="tool-item ' + (t.done ? 'done' : 'active') + '">' +
      ic(t.done ? 'check' : 'plugin', 13) + ' <b>' + esc(t.name) + '</b>' + args + detail + '</div>';
  }).join('');
}

function syncAgentChoices() {
  const stepsSel = document.getElementById('stepsDisplayChoices');
  const busySel = document.getElementById('busyBehaviorChoices');
  const sendSel = document.getElementById('sendHotkeyChoices');
  const closeSel = document.getElementById('closeBehaviorChoices');
  if (stepsSel) stepsSel.value = state.stepsDisplay;
  if (busySel) busySel.value = state.busyBehavior;
  if (sendSel) sendSel.value = sendHotkeyMode();
  if (closeSel) closeSel.value = state.closeBehavior;
  /* 浏览器模式（独立端口启动、安卓移植）没有桌面窗口可关，这一行只在 Electron 里出现。
     必须用 .hidden 类：.gen-row 自带 display:flex，会把 [hidden] 的 UA 样式顶掉 */
  const closeRow = document.getElementById('closeBehaviorRow');
  if (closeRow) closeRow.classList.toggle('hidden', !window.academyElectron);
}

async function loadAgentChoices() {
  try {
    const r = await fetchJSON('/api/config');
    const c = (r && r.config) || {};
    if (STEPS_MODES.includes(c.stepsDisplay)) state.stepsDisplay = c.stepsDisplay;
    if (c.busyBehavior === 'interrupt' || c.busyBehavior === 'queue') state.busyBehavior = c.busyBehavior;
    if (c.sendHotkey === 'enter' || c.sendHotkey === 'ctrlEnter') state.sendHotkey = c.sendHotkey;
    if (c.closeBehavior === 'ask' || c.closeBehavior === 'tray' || c.closeBehavior === 'quit') state.closeBehavior = c.closeBehavior;
    syncAgentChoices();
  } catch (_) {}
}

async function setStepsDisplay(mode) {
  if (!STEPS_MODES.includes(mode)) return;
  try {
    const r = await fetchJSON('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stepsDisplay: mode }) });
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    state.stepsDisplay = mode;
    syncAgentChoices();
    renderMessages();
    toast('工作步骤展示：' + STEPS_LABELS[mode]);
  } catch (e) { syncAgentChoices(); toast('设置失败：' + e.message); }
}

async function setBusyBehavior(behavior) {
  if (behavior !== 'queue' && behavior !== 'interrupt') return;
  try {
    const r = await fetchJSON('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ busyBehavior: behavior }) });
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    state.busyBehavior = behavior;
    syncAgentChoices();
    toast(behavior === 'interrupt' ? '繁忙时的发送行为：插话发送（新消息将暂停当前任务）' : '繁忙时的发送行为：排队发送（按先后等待）');
  } catch (e) { syncAgentChoices(); toast('设置失败：' + e.message); }
}

async function setSendHotkey(mode) {
  if (mode !== 'enter' && mode !== 'ctrlEnter') return;
  try {
    const r = await fetchJSON('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sendHotkey: mode }) });
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    state.sendHotkey = mode;
    syncAgentChoices();
    try { updateModeUI(); } catch (_) {}
    try { renderMessages(); } catch (_) {}
    toast(mode === 'enter' ? '发送热键：Enter 发送，Ctrl/Shift+Enter 换行' : '发送热键：Ctrl+Enter 发送，Enter 换行');
  } catch (e) { syncAgentChoices(); toast('设置失败：' + e.message); }
}

/* 关闭按钮的行为：写完 config 就交给主进程（它直接读 data/config.json），下一条关闭动作立即生效，不必重启 */
async function setCloseBehavior(mode) {
  if (mode !== 'ask' && mode !== 'quit' && mode !== 'tray') return;
  try {
    const r = await fetchJSON('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ closeBehavior: mode }) });
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    state.closeBehavior = mode;
    syncAgentChoices();
    toast(mode === 'tray' ? '关闭窗口时：最小化到系统托盘（右键托盘图标可退出）'
      : mode === 'quit' ? '关闭窗口时：直接退出程序'
      : '关闭窗口时：每次关闭都先问你（最小化到托盘 / 直接关闭）');
  } catch (e) { syncAgentChoices(); toast('设置失败：' + e.message); }
}

/* ================= 关闭窗口确认（应用内弹窗） =================
   主进程在「关闭窗口时 = 每次询问」时把问题发到渲染层，这里用应用自己的 .modal 问，
   再把答案经 IPC 发回去。为什么不用系统原生消息框：它跟 App 的视觉语言是两套，
   长文案换行、按钮顺序、勾选框都不可控，用户一眼就看出「这不是这个软件的东西」。 */
let closeConfirmToken = null;

function showCloseConfirm(token) {
  closeConfirmToken = token;
  const modal = document.getElementById('closeConfirmModal');
  const remember = document.getElementById('closeConfirmRemember');
  if (remember) remember.checked = false;
  if (!modal) { answerCloseConfirm('cancel'); return; }
  modal.classList.remove('hidden');
  /* 先回「已显示」：主进程等这句，2.5s 收不到才回退系统弹框 */
  try { window.academyElectron.answerCloseConfirm({ token, shown: true }); } catch (_) {}
  /* 默认焦点放「最小化到托盘」：回车＝安全选项。刚显示时浏览器可能把焦点丢给先出现的勾选框，
     所以立刻聚焦一次、60ms 再补一次（幂等）。 */
  const focusTray = () => {
    const b = document.getElementById('closeConfirmTray');
    if (!b) return;
    try { b.focus({ preventScroll: true }); } catch (_) { try { b.focus(); } catch (_) {} }
  };
  focusTray();
  setTimeout(focusTray, 60);
}

function hideCloseConfirm() {
  const modal = document.getElementById('closeConfirmModal');
  if (modal) modal.classList.add('hidden');
}

function answerCloseConfirm(choice) {
  const token = closeConfirmToken;
  if (!token) return;
  const remember = document.getElementById('closeConfirmRemember');
  const rememberChecked = !!(remember && remember.checked);
  closeConfirmToken = null;
  hideCloseConfirm();
  try { window.academyElectron.answerCloseConfirm({ token, choice, remember: rememberChecked }); } catch (_) {}
}

function bindCloseConfirm() {
  const trayBtn = document.getElementById('closeConfirmTray');
  const quitBtn = document.getElementById('closeConfirmQuit');
  const cancelBtn = document.getElementById('closeConfirmCancel');
  const xBtn = document.getElementById('closeConfirmX');
  if (trayBtn) trayBtn.onclick = () => answerCloseConfirm('tray');
  if (quitBtn) quitBtn.onclick = () => answerCloseConfirm('quit');
  if (cancelBtn) cancelBtn.onclick = () => answerCloseConfirm('cancel');
  if (xBtn) xBtn.onclick = () => answerCloseConfirm('cancel');
  /* Esc = 取消、Tab 只在弹窗内循环（只在弹窗开着时接管，别影响别的弹窗） */
  document.addEventListener('keydown', (e) => {
    if (!closeConfirmToken) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); answerCloseConfirm('cancel'); return; }
    if (e.key === 'Tab') {
      const modal = document.getElementById('closeConfirmModal');
      if (!modal) return;
      const items = Array.prototype.filter.call(
        modal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])'),
        (n) => n.offsetWidth || n.offsetHeight || n.getClientRects().length
      );
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1], cur = document.activeElement;
      if (!modal.contains(cur)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
    }
  }, true);
  if (window.academyElectron && typeof window.academyElectron.onCloseConfirm === 'function') {
    window.academyElectron.onCloseConfirm((token) => showCloseConfirm(token));
    window.academyElectron.onCloseConfirmCancel(() => { closeConfirmToken = null; hideCloseConfirm(); });
  }
}

function bindAgentChoices() {
  const stepsSel = document.getElementById('stepsDisplayChoices');
  if (stepsSel) stepsSel.onchange = () => setStepsDisplay(stepsSel.value);
  const busySel = document.getElementById('busyBehaviorChoices');
  if (busySel) busySel.onchange = () => setBusyBehavior(busySel.value);
  const sendSel = document.getElementById('sendHotkeyChoices');
  if (sendSel) sendSel.onchange = () => setSendHotkey(sendSel.value);
  const closeSel = document.getElementById('closeBehaviorChoices');
  if (closeSel) closeSel.onchange = () => setCloseBehavior(closeSel.value);
}

/* ================= 记忆治理：三个开关 + 否决清单 + 任务记录 ================= */
const MEM_TOGGLES = [
  { key: 'memoryAutoLearn', input: 'memAutoLearnToggle', label: 'memAutoLearnLabel' },
  { key: 'memoryAutoCite', input: 'memAutoCiteToggle', label: 'memAutoCiteLabel' },
  { key: 'memoryReview', input: 'memReviewToggle', label: 'memReviewLabel' },
];
async function loadMemToggles() {
  try {
    const r = await fetchJSON('/api/config');
    const c = (r && r.config) || {};
    for (const t of MEM_TOGGLES) {
      const inp = document.getElementById(t.input);
      const lab = document.getElementById(t.label);
      if (!inp || !lab) continue;
      const on = c[t.key] !== false;
      inp.checked = on;
      lab.textContent = on ? '开（默认）' : '关';
    }
  } catch (_) {}
}
async function saveMemToggle(t) {
  const inp = document.getElementById(t.input);
  const lab = document.getElementById(t.label);
  const want = !!(inp && inp.checked);
  try {
    const body = {}; body[t.key] = want;
    const r = await fetchJSON('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r && r.ok) { if (lab) lab.textContent = want ? '开（默认）' : '关'; toast(want ? '已开启（下一条消息起生效）' : '已关闭'); }
    else toast('设置失败：' + ((r && r.error) || ''));
  } catch (e) { toast('设置失败：' + e.message); }
}
function bindMemToggles() {
  for (const t of MEM_TOGGLES) {
    const inp = document.getElementById(t.input);
    if (inp) inp.onchange = () => saveMemToggle(t);
  }
}
async function loadMemRejectList() {
  const box = document.getElementById('memRejectList');
  if (!box) return;
  box.innerHTML = '';
  try {
    const r = await fetchJSON('/api/memory');
    const list = r.rejected || [];
    if (!list.length) return;
    box.appendChild(el('div', 'mem-reject-title', '否决清单（' + list.length + ' 条，同内容不再入库/注入）'));
    for (const x of list) {
      const row = el('div', 'mem-reject-row');
      row.appendChild(el('span', 'mem-reject-text', String(x.text || '').slice(0, 60) + ((x.text || '').length > 60 ? '…' : '')));
      const b = el('button', 'btn ghost small', '撤销否决'); b.type = 'button';
      b.onclick = async () => {
        const rr = await libApi('/api/memory/rejected/remove', { fp: x.fp });
        if (rr && rr.ok) { toast('已撤销'); loadMemRejectList(); } else toast('失败：' + ((rr && rr.error) || ''));
      };
      row.appendChild(b);
      box.appendChild(row);
    }
  } catch (_) {}
}

/* ---- 任务记录面板（设置 → 任务记录） ---- */
const RUN_SRC_LABEL = { chat: '对话', suggest: '搜索建议', verify: '证据检证', trace: '资料溯源' };
const RUN_ST_LABEL = { ok: '✅ 完成', error: '❌ 失败', cancelled: '⏹ 取消', timeout: '⏰ 超时', running: '▶ 运行中' };
async function loadRunsPane() {
  const now = document.getElementById('runsNowPane');
  const table = document.getElementById('runsTable');
  if (!table) return;
  try {
    const r = await fetchJSON('/api/runs/recent?limit=30');
    if (now) {
      now.innerHTML = '';
      const cur = r.current
        ? el('div', 'runs-now-item', '▶ 正在运行：' + (RUN_SRC_LABEL[(r.runs.find(x => x.runId === r.current.runId) || {}).source] || '任务') + ' · ' + fmtElapsed(Date.now() - r.current.startedAt))
        : el('div', 'runs-now-item dim', '当前空闲');
      now.appendChild(cur);
      for (const q of (r.queued || [])) {
        const row = el('div', 'runs-now-item');
        row.appendChild(document.createTextNode('⏳ 排队第 ' + q.pos + ' 位 · ' + (RUN_SRC_LABEL[q.source] || q.source)));
        const b = el('button', 'btn ghost small', '撤回'); b.type = 'button';
        b.onclick = async () => {
          const rr = await libApi('/api/queue/withdraw', { runId: q.runId });
          if (rr && rr.ok) { toast('已撤回'); loadRunsPane(); } else toast('撤回失败：' + ((rr && rr.error) || ''));
        };
        row.appendChild(b);
        now.appendChild(row);
      }
    }
    table.innerHTML = '';
    const runs = r.runs || [];
    if (!runs.length) { table.appendChild(el('div', 'mem-empty', '还没有运行记录。')); return; }
    for (const x of runs) {
      const row = el('div', 'runs-row');
      const dt = x.startedAt ? new Date(x.startedAt) : null;
      row.appendChild(el('span', 'runs-time', dt ? (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') : '—'));
      row.appendChild(el('span', 'runs-src', RUN_SRC_LABEL[x.source] || x.source || '—'));
      row.appendChild(el('span', 'runs-state', RUN_ST_LABEL[x.status] || x.status || '—'));
      row.appendChild(el('span', 'runs-meta', (x.elapsedMs ? fmtElapsed(x.elapsedMs) : '—') + (x.usage ? ' · in ' + (x.usage.input || 0) + ' / out ' + (x.usage.output || 0) : '')));
      const b = el('button', 'btn ghost small', '取消'); b.type = 'button';
      b.style.display = x.status === 'running' ? '' : 'none';
      b.onclick = async () => {
        const rr = await libApi('/api/queue/withdraw', { runId: x.runId });
        if (rr && rr.ok) { toast('已取消'); loadRunsPane(); } else toast('取消失败：' + ((rr && rr.error) || ''));
      };
      row.appendChild(b);
      table.appendChild(row);
    }
  } catch (e) {
    table.innerHTML = '';
    table.appendChild(el('div', 'mem-empty', '读取失败：' + e.message));
  }
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
/* ================= 自定义搜索服务（设置 → 高级） =================
   背景：内置「基础检索」是免费抓取网页，部分网络下会被反爬返回无关结果。
   这里让用户接入自己可用的搜索服务（Tavily / SearXNG / Brave / 自建），
   接入后「基础检索」优先走它。做成开放适配器：填地址模板 + 字段路径，
   任何返回 JSON 的服务都能接。 */
let csState = { enabled: false, method: 'GET', presets: [], hasKey: false };

function csField(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function csSet(id, v) { const el = document.getElementById(id); if (el) el.value = v == null ? '' : String(v); }

function renderCsEnabled() {
  const t = document.getElementById('customSearchToggle');
  const lab = document.getElementById('customSearchLabel');
  const form = document.getElementById('customSearchForm');
  const on = !!(t && t.checked);
  if (lab) lab.textContent = on ? '开' : '关（默认）';
  if (form) form.classList.toggle('hidden', !on);
  if (t) t.dataset.dirty = '1';
}

function csApplyMethod(m) {
  csState.method = m === 'POST' ? 'POST' : 'GET';
  document.querySelectorAll('#csMethodChoices .gen-choice').forEach(function (b) {
    b.classList.toggle('active', b.dataset.csMethod === csState.method);
  });
  const bodyField = document.getElementById('csBodyField');
  if (bodyField) bodyField.classList.toggle('hidden', csState.method !== 'POST');
}

function csApplyPreset(id) {
  const p = (csState.presets || []).find(function (x) { return x.id === id; });
  const note = document.getElementById('customSearchPresetNote');
  if (!p) { if (note) note.textContent = ''; return; }
  // 只填「格式」，Key 不动（用户可能已经填过）
  csSet('csUrl', p.urlTemplate);
  csSet('csHeaders', p.headers);
  csSet('csBody', p.bodyTemplate);
  csSet('csResultsPath', p.resultsPath);
  csSet('csTitlePath', p.titlePath);
  csSet('csUrlPath', p.urlPath);
  csSet('csSnippetPath', p.snippetPath);
  if (!csField('csName').trim()) csSet('csName', p.name);
  csApplyMethod(p.method);
  if (note) {
    note.innerHTML = (p.note ? esc(p.note) : '')
      + (p.signup ? '　<a href="' + esc(p.signup) + '" target="_blank" rel="noopener">去注册 / 查看文档 ↗</a>' : '');
  }
}

function csCollect() {
  return {
    enabled: !!(document.getElementById('customSearchToggle') || {}).checked,
    name: csField('csName'),
    urlTemplate: csField('csUrl'),
    method: csState.method,
    headers: csField('csHeaders'),
    bodyTemplate: csField('csBody'),
    apiKey: csField('csApiKey'),
    resultsPath: csField('csResultsPath'),
    titlePath: csField('csTitlePath'),
    urlPath: csField('csUrlPath'),
    snippetPath: csField('csSnippetPath'),
  };
}

async function loadCustomSearchUI() {
  try {
    const r = await fetchJSON('/api/search/custom');
    if (!r || !r.ok) return;
    csState.presets = r.presets || [];
    csState.hasKey = !!(r.config && r.config.hasKey);
    const c = r.config || {};
    const sel = document.getElementById('customSearchPreset');
    if (sel) {
      sel.innerHTML = '<option value="">— 请选择 —</option>'
        + csState.presets.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('');
    }
    const t = document.getElementById('customSearchToggle');
    if (t) t.checked = !!c.enabled;
    csSet('csName', c.name);
    csSet('csUrl', c.urlTemplate);
    csSet('csHeaders', c.headers);
    csSet('csBody', c.bodyTemplate);
    csSet('csResultsPath', c.resultsPath);
    csSet('csTitlePath', c.titlePath);
    csSet('csUrlPath', c.urlPath);
    csSet('csSnippetPath', c.snippetPath);
    const kh = document.getElementById('csKeyHint');
    if (kh) {
      kh.innerHTML = csState.hasKey
        ? '已保存 Key（留空表示不修改）。请求头里用 <code>{apiKey}</code> 引用。'
        : '保存在本机 <code>data/config.json</code>。请求头里用 <code>{apiKey}</code> 引用，没写的话会自动加 <code>Authorization: Bearer</code>。';
    }
    csApplyMethod(c.method || 'GET');
    renderCsEnabled();
  } catch (_) {}
}

async function saveCustomSearch() {
  const out = document.getElementById('customSearchResult');
  const c = csCollect();
  if (c.enabled && !String(c.urlTemplate || '').trim()) {
    if (out) { out.textContent = '启用时必须填「请求地址模板」'; out.className = 'settings-result err'; }
    return;
  }
  try {
    const r = await fetchJSON('/api/search/custom', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    csState.hasKey = !!(r.config && r.config.hasKey);
    csSet('csApiKey', '');
    if (out) {
      out.textContent = '已保存' + (c.enabled ? '（已启用，下次搜索生效）' : '（未启用）');
      out.className = 'settings-result ok';
    }
  } catch (e) {
    if (out) { out.textContent = '' + (e.message || '保存失败'); out.className = 'settings-result err'; }
  }
}

async function testCustomSearch() {
  const out = document.getElementById('customSearchResult');
  const btn = document.getElementById('btnCustomSearchTest');
  const c = csCollect();
  if (!String(c.urlTemplate || '').trim()) {
    if (out) { out.textContent = '先填「请求地址模板」再测试'; out.className = 'settings-result err'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  if (out) { out.textContent = '正在用「辩论」试搜一次…'; out.className = 'settings-result'; }
  try {
    const r = await fetchJSON('/api/search/custom/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '辩论', config: c }),
    });
    if (r && r.ok) {
      const s = (r.samples || [])[0];
      if (out) {
        out.innerHTML = '成功：' + r.count + ' 条结果，用时 ' + r.elapsedMs + 'ms'
          + (s ? '<br><span style="color:var(--muted)">样例：' + esc(String(s.title || s.url).slice(0, 60)) + '</span>' : '');
        out.className = 'settings-result ok';
      }
    } else {
      if (out) { out.textContent = '' + ((r && r.error) || '测试失败'); out.className = 'settings-result err'; }
    }
  } catch (e) {
    if (out) { out.textContent = '' + (e.message || '测试失败'); out.className = 'settings-result err'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔌 测试一下'; }
  }
}

function bindCustomSearch() {
  const t = document.getElementById('customSearchToggle');
  if (t) t.onchange = renderCsEnabled;
  document.querySelectorAll('#csMethodChoices .gen-choice').forEach(function (b) {
    b.onclick = function () { csApplyMethod(b.dataset.csMethod); };
  });
  const sel = document.getElementById('customSearchPreset');
  if (sel) sel.onchange = function () { csApplyPreset(sel.value); };
  const bs = document.getElementById('btnCustomSearchSave');
  if (bs) bs.onclick = saveCustomSearch;
  const bt = document.getElementById('btnCustomSearchTest');
  if (bt) bt.onclick = testCustomSearch;
  loadCustomSearchUI();
}

/* ================= 增强检索 ModSearch（设置 → 高级） =================
   默认那路「基础检索」是本地抓 Bing/DuckDuckGo，部分网络下被反爬返回无关结果。
   增强检索走随包内置的 ModSearch CLI（免注册、免 Key），召回质量高一档，
   但**上游免注册通道有月度限额** —— 所以这张卡除了开关，还要把本机用量摊开给用户看。
   关掉/额度用不完都不会让搜索失效：失败一律自动退回基础检索。 */
let msState = { enabled: true, available: true, quota: null, last: null };

function modsearchQuotaLine() {
  if (!msState.available) return '本月用量：增强检索未随包安装（请重新解压完整安装包）';
  const q = msState.quota || {};
  const cap = Number(q.monthlyCap) || 1000;
  let s = '本月用量：已用 ' + (Number(q.creditsUsed) || 0) + ' credits（' + (Number(q.searches) || 0)
    + ' 次搜索）· 剩余额度约 ' + (Number(q.remainingEst) || 0) + ' credits（本机估算，上限 ' + cap + '/月）';
  if (msState.last && msState.last.ok === false && msState.last.error) {
    s += '｜最近一次失败：' + String(msState.last.error).slice(0, 80);
  }
  return s;
}

function renderMsEnabled() {
  const t = document.getElementById('modsearchToggle');
  const lab = document.getElementById('modsearchLabel');
  if (lab) lab.textContent = (t && t.checked) ? '开' : '关（默认）';
}

function renderMsQuota() {
  const el = document.getElementById('modsearchQuota');
  if (el) el.textContent = modsearchQuotaLine();
}

async function loadModsearchUI() {
  try {
    const r = await fetchJSON('/api/search/modsearch');
    if (!r || !r.ok) { msState.available = false; renderMsQuota(); return; }
    msState.enabled = r.enabled === true;
    msState.available = r.available === true;
    msState.quota = r.quota || null;
    msState.last = r.last || null;
    const t = document.getElementById('modsearchToggle');
    if (t) t.checked = msState.enabled;
    renderMsEnabled();
    renderMsQuota();
  } catch (_) {
    const el = document.getElementById('modsearchQuota');
    if (el) el.textContent = '本月用量：读取失败';
  }
}

async function saveModsearch() {
  const out = document.getElementById('modsearchResult');
  const t = document.getElementById('modsearchToggle');
  const want = !!(t && t.checked);
  try {
    const r = await fetchJSON('/api/search/modsearch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: want }),
    });
    if (!r || !r.ok) throw new Error((r && r.error) || '保存失败');
    msState.enabled = want;
    msState.available = r.available !== false;
    if (out) {
      out.textContent = want ? '已保存：增强检索开启（下一条消息起生效）' : '已保存：已关闭，端侧检索退回基础检索';
      out.className = 'settings-result ok';
    }
    renderMsEnabled();
  } catch (e) {
    if (out) { out.textContent = '' + (e.message || '保存失败'); out.className = 'settings-result err'; }
  }
}

async function testModsearch() {
  const out = document.getElementById('modsearchResult');
  const btn = document.getElementById('btnModsearchTest');
  const lab = document.getElementById('modsearchTestLabel');
  if (btn) btn.disabled = true;
  if (lab) lab.textContent = '搜索中…';
  if (out) { out.textContent = '正在用「辩论」试搜一次（会消耗额度）…'; out.className = 'settings-result'; }
  try {
    const r = await fetchJSON('/api/search/modsearch/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '辩论' }),
    });
    if (r && r.ok) {
      const s = (r.samples || [])[0];
      msState.quota = r.quota || msState.quota;
      renderMsQuota();
      if (out) {
        out.innerHTML = '成功：' + r.count + ' 条结果，用时 ' + r.elapsedMs + 'ms，引擎 ' + esc(String(r.engine || ''))
          + '，本次消耗 ' + (Number(r.credits) || 0) + ' credits'
          + (s ? '<br><span style="color:var(--muted)">样例：' + esc(String(s.title || s.url).slice(0, 60)) + '</span>' : '');
        out.className = 'settings-result ok';
      }
    } else {
      if (r && r.quota) { msState.quota = r.quota; renderMsQuota(); }
      if (out) {
        out.textContent = '失败：' + ((r && r.error) || '未知错误') + '（不影响使用，端侧检索会自动退回基础检索）';
        out.className = 'settings-result err';
      }
    }
  } catch (e) {
    if (out) { out.textContent = '' + (e.message || '测试失败'); out.className = 'settings-result err'; }
  } finally {
    if (btn) btn.disabled = false;
    if (lab) lab.textContent = '试搜一次（消耗额度）';
  }
}

function bindModsearch() {
  const t = document.getElementById('modsearchToggle');
  if (t) t.onchange = renderMsEnabled;
  const bs = document.getElementById('btnModsearchSave');
  if (bs) bs.onclick = saveModsearch;
  const bt = document.getElementById('btnModsearchTest');
  if (bt) bt.onclick = testModsearch;
  loadModsearchUI();
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


/* 旧的「搜资料」弹窗已移除：搜索与独立研究对话整合进「研究台」独立工具窗（tool-window.js --tool=research）。 */

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
  $('#skillMsg').textContent = (ok ? '成功 ' + ok + ' 份。' : '') + (fail ? '失败 ' + fail + ' 份：同名冲突或缺少 frontmatter（name/description）。可改名或勾选覆盖后重试。' : '');
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
  openModalAnimated($('#memoryModal'));
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
  const bEdit = el('button', 'mem-act-btn', ic('edit',12) + '编辑'); bEdit.type = 'button';
  const bVeto = el('button', 'mem-act-btn', ic('shield',12) + '不再引用'); bVeto.type = 'button';
  bVeto.title = '加入否决清单：这条内容以后不再注入上下文（条目本身保留）';
  bVeto.onclick = async () => {
    if (!confirm('把这条记忆加入否决清单？\n条目本身保留在文件里，但以后不再注入到任务上下文；同内容也不会再被自动归档。')) return;
    const r = await libApi('/api/memory/reject', { text: e.body || e.title || '' });
    if (r && r.ok) { toast('已加入否决清单'); await openMemory(); try { loadMemRejectList(); } catch (_) {} }
    else toast('操作失败：' + ((r && r.error) || ''));
  };
  const bDel = el('button', 'mem-act-btn danger', ic('trash',12) + '删除'); bDel.type = 'button';
  acts.appendChild(bEdit); acts.appendChild(bVeto); acts.appendChild(bDel);
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

/* —— 记忆中心全文搜索（长期 + 流水一并通过服务端 FTS 索引检索） —— */
async function memorySearchRun() {
  const inp = $('#memorySearchInput');
  const panel = $('#memorySearchPanel');
  const q = (inp ? inp.value : '').trim();
  if (!panel) return;
  if (!q) { toast('先输入要搜索的关键词'); return; }
  // 显示搜索结果面板，取消 Tab 高亮；切回任意 Tab 即恢复原视图
  document.querySelectorAll('.memory-tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.memory-panel').forEach((p) => p.classList.toggle('active', p.id === 'memorySearchPanel'));
  panel.innerHTML = '<div class="mem-empty">搜索中…</div>';
  try {
    const r = await fetchJSON('/api/memory/search?q=' + encodeURIComponent(q));
    if (!r || !r.ok) throw new Error((r && r.error) || '搜索失败');
    const hits = r.results || [];
    panel.innerHTML = '';
    const tip = el('div', 'mem-day-head');
    tip.appendChild(el('span', null, '🔎 「' + q + '」命中 ' + hits.length + ' 条'));
    panel.appendChild(tip);
    if (!hits.length) {
      panel.appendChild(el('div', 'mem-empty', '没有找到相关记忆。试试换更短的关键词，比如「判准」「质询」。'));
      return;
    }
    for (const h of hits) {
      const card = el('div', 'mem-entry');
      const head = el('div', 'mem-entry-head');
      const t = el('div', 'mem-entry-title', String(h.title || '（未命名）').replace(/^#+\s*/, ''));
      const srcLabel = h.scope === 'long' ? '📚 长期'
        : h.scope === 'archive' ? '📦 归档 ' + (h.file || '')
          : '🗓 ' + (h.file || '');
      t.appendChild(el('span', 'mem-entry-time', srcLabel + (h.time ? ' · ' + String(h.time).slice(0, 16) : '')));
      head.appendChild(t);
      card.appendChild(head);
      card.appendChild(el('div', 'mem-entry-body', h.body || '（无内容）'));
      panel.appendChild(card);
    }
  } catch (e) {
    panel.innerHTML = '<div class="mem-empty">搜索失败：' + esc(e.message || '') + '</div>';
  }
}
function bindMemorySearchUI() {
  const b = $('#btnMemorySearch');
  if (b) b.onclick = memorySearchRun;
  const inp = $('#memorySearchInput');
  if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); memorySearchRun(); } };
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

  // 待审阅候选（候选审阅开启时 Agent 的记忆提案先进这里，由用户批准/否决）
  const pending = j.pending || [];
  if (pending.length) {
    const box = el('div', 'mem-pending-box');
    box.appendChild(el('div', 'mem-pending-head', (j.reviewOn ? '🔍 待审阅候选 · ' + pending.length + ' 条（审阅模式开启中）' : '🔍 待审阅候选 · ' + pending.length + ' 条')));
    for (const p of pending) {
      const card = el('div', 'mem-pending-card');
      card.appendChild(el('span', 'mem-pending-kind', p.kind === 'daily' ? '流水' : '长期'));
      card.appendChild(el('div', 'mem-pending-text', p.text || ''));
      const acts = el('div', 'mem-pending-acts');
      const bOk = el('button', 'btn primary small', '批准入库'); bOk.type = 'button';
      const bNo = el('button', 'btn ghost small danger', '否决'); bNo.type = 'button';
      bOk.onclick = async () => {
        const r = await libApi('/api/memory/pending/decide', { fp: p.fp, action: 'approve' });
        if (r && r.ok) { toast('已批准入库'); openMemory(); } else toast('失败：' + ((r && r.error) || ''));
      };
      bNo.onclick = async () => {
        const r = await libApi('/api/memory/pending/decide', { fp: p.fp, action: 'reject' });
        if (r && r.ok) { toast('已否决（进入否决清单，同文不再入库/注入）'); openMemory(); try { loadMemRejectList(); } catch (_) {} } else toast('失败：' + ((r && r.error) || ''));
      };
      acts.append(bOk, bNo);
      card.appendChild(acts);
      box.appendChild(card);
    }
    longPanel.appendChild(box);
  }
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
    dailyPanel.appendChild(el('div', 'mem-empty', '暂无每日流水。Agent 的短期观察会归档到「当日流水」，其中值得保留的会自动晋升为长期记忆；14 天后未晋升的会并入月度归档（archive-月份.md），不会丢失。也可以点上方「＋ 新增今日流水」手动记一笔。'));
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
const libState = { items: [], enabled: true, busy: false, filter: 'all' };

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
  openModalAnimated($('#libraryModal'));
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
  meta.appendChild(el('span', 'lib-tag cat', LIB_CATS[libCategory(it)] || LIB_CATS.other));
  // 引用式条目（来自产物空间）：标出来历，原件被删时明确提示而不是静默空掉
  if (it.kind === 'deliverable') {
    if (it.missing) meta.appendChild(el('span', 'lib-tag warn', '⚠ 原件已删除'));
    else meta.appendChild(el('span', 'lib-tag link', '🔗 来自产物 · 跟随更新'));
  }
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

/* 资料分类（与产物空间的 chip 筛选同一套交互）：按来源类型自动归类。
   ★ LIB_CATS 只放**纯文本** —— 它同时被 chip 标签、条目角标、以及
   `textContent` 赋值三处消费，塞 HTML 进去会被当字面量转义出来。
   图标单独放 LIB_CAT_ICONS，只在需要 innerHTML 的地方用。 */
const LIB_CATS = {
  doc: '文档', word: 'Word', pdf: 'PDF', img: '图片OCR', other: '其他',
};
const LIB_CAT_ICONS = {
  doc: 'edit', word: 'file', pdf: 'file', img: 'image', other: 'package',
};
function libCategory(it) {
  const ext = String(it.ext || '').toLowerCase();
  if (it.kind === 'ocr' || /^(png|jpg|jpeg|bmp|tif|tiff)$/.test(ext)) return 'img';
  if (ext === 'pdf') return 'pdf';
  if (/^(doc|docx)$/.test(ext)) return 'word';
  if (/^(md|markdown|txt|srt)$/.test(ext) || it.kind === 'paste') return 'doc';
  return 'other';
}

function renderLibraryList() {
  const box = $('#libList');
  if (!box) return;
  box.innerHTML = '';
  const all = libState.items || [];
  /* 已有资料时收成细栏（把高度让给列表）——资料库正文里上传区/检索/同义词都是固定高度，
     短屏上会把列表挤到只剩一行。空库时才展开完整引导（那时最需要它）。 */
  const modalBox = document.querySelector('#libraryModal .modal-box');
  if (modalBox) modalBox.classList.toggle('has-items', all.length > 0);
  const items = libState.filter === 'all' ? all : all.filter((it) => libCategory(it) === libState.filter);
  // 分类计数同步到 chip 上，一眼看清每类几份
  const counts = { all: all.length };
  for (const it of all) counts[libCategory(it)] = (counts[libCategory(it)] || 0) + 1;
  document.querySelectorAll('#libChips .chip').forEach((c) => {
    const k = c.dataset.lfilter || 'all';
    const n = counts[k] || 0;
    /* ★ 不能用 textContent —— 会把 chip 里的图标 SVG 一起抹掉。
       只替换「文字部分」：图标节点原样保留，末尾追加计数。 */
    const label = (k === 'all' ? '全部' : (LIB_CATS[k] || k)) + (n ? ' ' + n : '');
    let textNode = null;
    for (const node of c.childNodes) {
      if (node.nodeType === 3 && node.nodeValue.trim()) { textNode = node; break; }
    }
    if (textNode) textNode.nodeValue = label;
    else c.appendChild(document.createTextNode(label));
  });
  $('#libCount').textContent = '共 ' + all.length + ' 份' + (libState.filter !== 'all' ? ' · 当前分类 ' + items.length + ' 份' : '');
  if (!items.length) {
    const msg = all.length
      ? '这个分类下还没有资料。上传或粘贴时会按文件类型自动归到对应分类。'
      : '资料库还是空的。上传一份备赛包或模辩文字稿，之后备赛 / 复盘时，Agent 会自动检索并优先引用你自己的口径和数据。';
    box.appendChild(el('div', 'lib-empty', msg));
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

/* 批量入库：支持多文件 + 整个文件夹拖入。
   文件夹通过两次选择达成：①「选择文件」用 webkitdirectory 选文件夹；②拖放区收下 DataTransferItem
   递归展开出的目录条目。上限 LIB_BATCH_LIMIT 份，OCR 的图片会慢一些，逐个出结果不卡界面。 */
const LIB_BATCH_LIMIT = 100;
const LIB_SUPPORTED_EXT = new Set(['txt', 'md', 'markdown', 'srt', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff']);

function libExtOfName(name) {
  const m = String(name || '').match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

/* 从拖放进来的 DataTransferItem 里递归捞出所有文件（webkitGetAsEntry 才能拿到目录） */
async function filesFromDataTransfer(dt) {
  const out = [];
  const items = dt && dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return Array.from((dt && dt.files) || []);

  async function walk(entry, prefix) {
    // 目录深度限制，防止整个磁盘被拖进来时卡死
    const depth = prefix ? prefix.split('/').length : 0;
    if (depth > 6) return;
    if (entry.isFile) {
      const f = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
      if (f) out.push(f);
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    const kids = await new Promise((resolve) => {
      const acc = [];
      const readMore = () => reader.readEntries(
        (batch) => { if (!batch.length) return resolve(acc); acc.push(...batch); readMore(); },
        () => resolve(acc)
      );
      readMore();
    });
    for (const k of kids) await walk(k, prefix ? prefix + '/' + entry.name : entry.name);
  }
  for (const e of entries) await walk(e, '');
  return out;
}

async function libUploadFiles(files) {
  let list = Array.from(files || []);
  if (!list.length) return;
  if (libState.busy) { toast('还有文件在入库，请稍候'); return; }

  // 过滤掉不支持的类型，避免一个个传上去再被服务端拒
  const skipped = [];
  list = list.filter((f) => {
    const ok = LIB_SUPPORTED_EXT.has(libExtOfName(f.name));
    if (!ok) skipped.push(f.name);
    return ok;
  });

  if (!list.length) {
    toast(skipped.length ? ('没有可入库的文件（已跳过 ' + skipped.length + ' 个不支持的格式）') : '没有可入库的文件');
    return;
  }

  const over = list.length - LIB_BATCH_LIMIT;
  if (over > 0) {
    list = list.slice(0, LIB_BATCH_LIMIT);
    toast('一次最多入库 ' + LIB_BATCH_LIMIT + ' 份，本次取前 ' + LIB_BATCH_LIMIT + ' 份（还有 ' + over + ' 份请分批处理）');
  }

  libState.busy = true;
  const box = $('#libUploadState');
  box.classList.remove('hidden');
  const failures = [];
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    box.textContent = '正在入库（' + (i + 1) + '/' + list.length + '）：' + file.name + ' …';
    try {
      const b64 = await fileToBase64(file);
      const r = await libApi('/api/library/upload', { name: file.name, data: b64 });
      if (r && r.ok) ok++;
      else failures.push(file.name + '：' + ((r && r.error) || '未知错误'));
    } catch (e) {
      failures.push(file.name + '：' + e.message);
    }
  }
  libState.busy = false;

  const parts = ['成功 ' + ok + ' 份'];
  if (failures.length) parts.push('失败 ' + failures.length + ' 份');
  if (skipped.length) parts.push('跳过 ' + skipped.length + ' 份（格式不支持）');
  const summary = '入库完成：' + parts.join('，');
  box.textContent = summary + (failures.length ? '\n' + failures.slice(0, 5).join('\n') + (failures.length > 5 ? '\n…等 ' + failures.length + ' 项' : '') : '');
  box.style.whiteSpace = 'pre-wrap';
  toast(summary);
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
  // 分类筛选 chips（与产物空间同一套交互）
  document.querySelectorAll('#libChips .chip').forEach((c) => {
    c.onclick = () => {
      libState.filter = c.dataset.lfilter || 'all';
      document.querySelectorAll('#libChips .chip').forEach((x) => x.classList.toggle('active', x === c));
      renderLibraryList();
    };
  });
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
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('dragover');
      if (libState.busy) { toast('还有文件在入库，请稍候'); return; }
      boxTextSet(box, '正在读取拖入的内容…');
      // 拖文件夹时 dataTransfer.files 只有目录本身，必须走 webkitGetAsEntry 递归展开
      let files = [];
      try { files = await filesFromDataTransfer(e.dataTransfer); }
      catch (_) { files = Array.from((e.dataTransfer && e.dataTransfer.files) || []); }
      if (!files.length) { $('#libUploadState').classList.add('hidden'); toast('没有识别到可入库的文件'); return; }
      libUploadFiles(files);
    });
    function boxTextSet(elm, s) { if (elm) { elm.classList.remove('hidden'); elm.textContent = s; } }
  }
  // 「选择文件夹」：webkitdirectory 一次拿整个目录（不支持的浏览器会退化成普通多选）
  const pickDir = $('#btnLibPickDir');
  const dirInput = $('#libDirInput');
  if (pickDir && dirInput) {
    pickDir.onclick = () => dirInput.click();
    dirInput.onchange = () => {
      if (dirInput.files && dirInput.files.length) libUploadFiles(dirInput.files);
      dirInput.value = '';
    };
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

/* byToken=true 时格子里的值是当天 token 数（账本口径）；否则是消息数（本地兜底口径） */
function renderStatsHeatmap(dayCount, byToken = false) {
  const box = $('#statsHeatmap');
  if (!box) return;
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
      c.title = byToken ? (cell.key + '：' + fmtToken(cell.n) + ' tokens') : (cell.key + '：' + cell.n + ' 条消息');
      row.appendChild(c);
    }
    box.appendChild(row);
  }
}
/* fromLedger=true 时 s 是服务端 /api/stats 的返回；否则是本地 collectStats() 兜底 */
function renderStatsCardsFromStats(s, isLocal) {
  const grid = $('#statsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const u = s.usage || s;                     // 服务端包在 usage 里，本地是扁平的
  const input = Number(u.input) || 0;
  const output = Number(u.output) || 0;
  const cacheRead = Number(u.cacheRead) || 0;
  const cacheWrite = Number(u.cacheWrite) || 0;
  const reasoning = Number(u.reasoning) || 0;
  const totalTok = input + output + cacheRead + cacheWrite + reasoning;
  const hitRate = (input + cacheRead) > 0 ? (cacheRead / (input + cacheRead) * 100) : 0;
  const cards = [
    ['free', fmtToken(s.msgs != null ? s.msgs : (s.messages || 0)), '总消息数'],
    ['grid', String(s.chats || 0), '总对话数'],
    ['arrowDown', fmtToken(input), '输入 Token'],
    ['arrowLeft', fmtToken(output), '输出 Token'],
    ['bolt', fmtToken(cacheRead), '缓存节省 Token'],
    ['target', hitRate.toFixed(1) + '%', '缓存命中率'],
  ];
  if (!isLocal) {
    // 账本才有的口径：活跃天数 / 连续天数 / 总轮次 / 总消耗
    cards.push(['calendar', String(s.activeDays || 0) + ' 天', '活跃天数']);
    if (s.streak) cards.push(['sparkle', String(s.streak) + ' 天', '连续活跃']);
    cards.push(['refresh', fmtToken((u.turns || 0)), '对话轮次']);
    cards.push(['chart', fmtToken(totalTok), '累计 Token']);
  }
  for (const [iconName, val, label] of cards) {
    const c = el('div', 'stats-card');
    c.appendChild(el('div', 'sc-icon', ic(iconName, 16)));
    c.appendChild(el('div', 'sc-val', val));
    c.appendChild(el('div', 'sc-label', label));
    grid.appendChild(c);
  }
}

/* 统计面板：数据源是服务端 append-only 用量账本（/api/stats），
   不再从「当前还存在的对话」里现算 —— 删掉对话不会让历史消耗凭空消失。
   本地 collectStats() 仅作为服务不可用时的兜底。 */
let statsCache = null;
async function fetchStats() {
  try {
    const r = await fetchJSON('/api/stats');
    if (r && r.ok) { statsCache = r; return r; }
  } catch (_) {}
  return null;
}

function renderStatsPane() {
  // 先渲染本地兜底（即时可见），拿到服务端数据再刷新为权威值
  const local = collectStats();
  renderStatsHeatmap(local.dayCount);
  renderStatsCardsFromStats(local, true);
  renderStatsLegend();
  fetchStats().then((r) => {
    if (!r) return;
    renderStatsCardsFromStats(r, false);
    renderStatsHeatmapFromLedger(r.days || []);
    renderStatsModels(r.models || []);
    renderStatsFootnote(r);
  });
}

/* 按账本的「按天 token」画热力图（原来是按消息数，与用量无关） */
function renderStatsHeatmapFromLedger(days) {
  const map = {};
  for (const d of days) {
    map[d.date] = (Number(d.input) || 0) + (Number(d.output) || 0) + (Number(d.cacheRead) || 0);
  }
  renderStatsHeatmap(map, true);
}

function renderStatsModels(models) {
  const box = $('#statsModels');
  if (!box) return;
  box.innerHTML = '';
  if (!models.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const head = el('div', 'stats-subhead', '按模型');
  box.appendChild(head);
  for (const m of models.slice(0, 6)) {
    const row = el('div', 'stats-model-row', '');
    row.appendChild(el('span', 'sm-name', m.model));
    row.appendChild(el('span', 'sm-turns', m.turns + ' 轮'));
    row.appendChild(el('span', 'sm-val', fmtToken((Number(m.input) || 0) + (Number(m.output) || 0)) + ' tokens'));
    box.appendChild(row);
  }
}

function renderStatsFootnote(r) {
  const box = $('#statsFoot');
  if (!box) return;
  const u = r.usage || {};
  const saved = Number(u.cacheRead) || 0;
  const parts = [];
  parts.push('活跃 ' + (r.activeDays || 0) + ' 天');
  if (r.streak) parts.push('连续 ' + r.streak + ' 天');
  if (saved > 0) parts.push('缓存节省 ' + fmtToken(saved));
  parts.push('账本 ' + (r.ledgerRows || 0) + ' 条（删对话不影响历史）');
  box.textContent = parts.join(' · ');
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
        out.innerHTML = '已导出到：<br><code>' + esc(res.path) + '</code><br>' + esc(summary) +
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
      if (out) { out.textContent = '已下载备份文件\n' + summary; out.className = 'settings-result ok'; }
    }
  } catch (e) {
    if (out) { out.textContent = '' + e.message; out.className = 'settings-result err'; }
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
      out.textContent = '导入完成：' + (rr.chats || 0) + ' 个对话、' + (rr.memoryDaily || 0) + ' 天记忆、' + (rr.profiles || 0) + ' 套配置\n旧数据已备份到 data/' + (r.backupDir || '_backup_*');
      out.className = 'settings-result ok';
    }
    toast('导入完成，正在重新加载…');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    if (out) { out.textContent = '' + e.message; out.className = 'settings-result err'; }
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
    toast('上下文已压缩为摘要');
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
try { bindMemToggles(); } catch (_) {}
  try { bindAgentChoices(); } catch (_) {}
{ const br = document.getElementById('btnRunsRefresh'); if (br) br.onclick = () => loadRunsPane(); }
  try { bindCustomSearch(); } catch (_) {}
  try { bindModsearch(); } catch (_) {}
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
  bindMemorySearchUI();
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
    b.onclick = () => { const m = document.getElementById(b.dataset.close); if (m) closeModalAnimated(m); };
  });
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest ? e.target.closest('.modal-close') : null;
    if (closeBtn) {
      const targetId = closeBtn.dataset && closeBtn.dataset.close;
      if (targetId) {
        const m = document.getElementById(targetId);
        if (m) closeModalAnimated(m);
        return;
      }
    }
    // 点击弹窗背景关闭
    if (e.target && e.target.classList && e.target.classList.contains('modal')) {
      closeModalAnimated(e.target);
    }
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) closeModalAnimated(m); });
  });

  // 通用设置：外观（浅色/深色/跟随系统）
  document.querySelectorAll('#themeChoices .gen-choice').forEach((b) => {
    b.onclick = () => setTheme(b.dataset.themeVal);
  });
  // 通用设置：界面语言（简体/繁体/English）
  document.querySelectorAll('#localeChoices .gen-choice').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.localeVal === 'zh-TW' ? 'zh-TW' : b.dataset.localeVal === 'en' ? 'en' : 'zh-CN';
      const crossing = v === 'en' || restoreLocale() === 'en';
      setLocale(v); // 中英互切会整页重载，toast 就来不及看了，只在简繁切换时提示
      if (!crossing) toast(v === 'zh-TW' ? '已切換為繁體中文' : '已切换为简体中文');
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
      sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
      sidebarToggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
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
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return; // 输入法选词中的回车不算数
    if (sendHotkeyMode() === 'enter') {
      // Enter 直发；带任意修饰键视为换行，交给 textarea 默认行为
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    } else if (e.ctrlKey || e.metaKey) {
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
  initComposerGear();
  // 服务商行 + 行内编辑卡：保存 / 添加 / 收起
  const btnSaveProf = $('#btnSaveProfile');
  if (btnSaveProf) btnSaveProf.onclick = saveCurrentProfile;
  const btnAddProvider = $('#btnAddProvider');
  if (btnAddProvider) btnAddProvider.onclick = () => {
    openProfileEditorForNew();
    /* 不能零反馈：点了像坏了（Pro 线 09-15 修过同一问题） */
    toast('填写服务商与 Key，保存后就出现在列表里');
  };
  const btnEditorClose = $('#editorClose');
  if (btnEditorClose) btnEditorClose.onclick = closeProfileEditor;
  // 模型列表：手动添加 / 移除（移除在行内）
  const btnAddModel = $('#btnAddModel');
  if (btnAddModel) btnAddModel.onclick = addModelFromInput;
  const modelInputEl = $('#modelInput');
  if (modelInputEl) modelInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addModelFromInput(); }
  });
  // 获取可用模型：选择器
  const pickSearch = $('#modelPickSearch');
  if (pickSearch) pickSearch.addEventListener('input', () => renderModelPicker(pickSearch.value));
  const btnPickAll = $('#btnPickAll');
  if (btnPickAll) btnPickAll.onclick = () => setVisibleChecks(true);
  const btnPickNone = $('#btnPickNone');
  if (btnPickNone) btnPickNone.onclick = () => setVisibleChecks(false);
  const btnPickCancel = $('#btnPickCancel');
  if (btnPickCancel) btnPickCancel.onclick = closeModelPicker;
  const btnPickAdd = $('#btnPickAdd');
  if (btnPickAdd) btnPickAdd.onclick = addPickedModels;
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
      await loadProfilesUI();
      await refreshStatus();
      if (out) { out.textContent = 'Key 已清除（保存时留空即保持无 Key）。'; out.className = 'settings-result ok'; }
    } catch (e) {
      const out = $('#settingsResult');
      if (out) { out.textContent = '' + e.message; out.className = 'settings-result err'; }
    }
  };
  const baseInput = $('#baseUrlInput');
  if (baseInput) baseInput.addEventListener('input', () => syncEndpointHint(baseInput.value));
  const btnLoad = $('#btnLoadModels');
  if (btnLoad) btnLoad.onclick = loadModels;
  $('#btnTestKey').onclick = async () => {
    const apiKey = $('#apiKeyInput').value.trim();
    const model = currentModelValue();
    const baseUrl = currentBaseUrlValue();
    const out = $('#settingsResult');
    if (!confirmEndpointChange(baseUrl)) {
      out.textContent = '已取消：未确认服务商地址。';
      out.className = 'settings-result err';
      return;
    }
    out.textContent = '正在连接 ' + baseUrl + ' …';
    out.className = 'settings-result';
    try {
      const r = await fetchJSON('/api/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model, baseUrl }),
      });
      out.textContent = r.ok ? '' + r.message : '' + r.message;
      out.className = 'settings-result ' + (r.ok ? 'ok' : 'err');
    } catch (e) {
      out.textContent = '' + e.message;
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
  deepseek:    { baseUrl: 'https://api.deepseek.com',            models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat'], name: 'DeepSeek 官方' },
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
  if (!confirmEndpointChange(baseUrl)) {
    if (out) { out.textContent = '已取消：未确认服务商地址。'; out.className = 'settings-result err'; }
    return;
  }
  try {
    if (btn) { btn.disabled = true; btn.textContent = '正在验证…'; }
    if (out) { out.textContent = '正在连接 ' + endpointHostOf(baseUrl) + ' 验证 Key…'; out.className = 'settings-result'; }
    // 1) 验证
    const r = await fetchJSON('/api/test-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key, model, baseUrl }),
    });
    if (!r.ok) throw new Error(r.message || 'Key 验证失败');
    // 2) 保存为服务商配置并激活（一家服务商；先落一个模型，之后可在设置里加更多）
    const save = await fetchJSON('/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: profileName, baseUrl, models: [{ id: model }], model, apiKey: key }),
    });
    if (!save.ok) throw new Error(save.error || '保存失败');
    await refreshStatus();
    await loadProfilesUI();
    if (out) { out.textContent = '验证通过，已保存！'; out.className = 'settings-result ok'; }
    setTimeout(() => showWizardStep(4), 500);
  } catch (e) {
    if (out) { out.textContent = '' + e.message; out.className = 'settings-result err'; }
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
  try { bindCloseConfirm(); } catch (e) { console.error('[Academy] 关闭确认弹窗初始化失败:', e); }
  try { initScrollFollow(); } catch (e) { console.error('[Academy] 滚动跟随初始化失败:', e); }
  try { initDialogA11y(); } catch (e) { console.error('[Academy] 对话框可达性初始化失败:', e); }
  // 应用外观 + 界面语言
  try { applyTheme(); } catch (_) {}
  try { applyChatFs(); } catch (_) {}
  try { syncLocaleChoices(); } catch (_) {}
  try { applyLocaleToStatic(); } catch (_) {}
  try { reconcileLocaleOnce(); } catch (_) {}
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