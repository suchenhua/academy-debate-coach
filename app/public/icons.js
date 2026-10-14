/* ============================================================================
   图标系统 —— 线性 SVG sprite
   ----------------------------------------------------------------------------
   为什么不用 emoji：emoji 是彩色字形，宽度/风格随字体栈变化，多个排在一起
   会互相抢注意力，界面显得廉价。Apple HIG 的 Clarity 要求图标视觉一致、
   服从内容。这里统一为 24×24 线性图标（1.75 描边、圆角端点），继承 currentColor，
   因此自动跟随文字颜色与深浅主题。

   用法：
     HTML  <svg class="ic"><use href="#i-prep"></use></svg>
     JS    icon('prep')  → '<svg class="ic"><use href="#i-prep"></use></svg>'

   新增图标：在 ICONS 里加一条 { name: '<path .../>' }，路径一律 24×24 视框。
   ========================================================================== */

(function () {
  'use strict';

  /* 线性图标路径表。键名即 #i-<name>。
     统一规范：24×24 视框、fill:none、stroke:currentColor、线宽 1.75。 */
  var ICONS = {
    /* ── 主导航（四种工作模式）────────────────────────────────────────── */
    free:     '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.9-.9L3 20.5l1.6-4.7A8.4 8.4 0 0 1 3.7 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"/>',
    prep:     '<path d="M9 3.5h6a1.5 1.5 0 0 1 1.5 1.5v.5H7.5V5A1.5 1.5 0 0 1 9 3.5Z"/><path d="M7.5 5.5h9A2.5 2.5 0 0 1 19 8v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 17V8a2.5 2.5 0 0 1 2.5-2.5Z"/><path d="M8.5 10.5h7M8.5 14h4.5"/>',
    review:   '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    judge:    '<path d="M12 4.5v15M7 20h10"/><path d="M4.5 10h15"/><path d="M7.5 10 4.5 15.5a3 3 0 0 0 6 0L7.5 10ZM16.5 10l-3 5.5a3 3 0 0 0 6 0l-3-5.5Z"/>',

    /* ── 顶栏 / 全局操作 ──────────────────────────────────────────────── */
    toolbox:  '<path d="M4 8.5h16v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z"/><path d="M9 8.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2.5"/><path d="M4 12.5h16"/><path d="M11 12.5v2"/>',
    plus:     '<path d="M12 5v14M5 12h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    search:   '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    close:    '<path d="M18 6 6 18M6 6l12 12"/>',
    check:    '<path d="m4.5 12.5 5 5 10-11"/>',
    warn:     '<path d="M10.3 4.3 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    info:     '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',

    /* ── 内容区操作 ──────────────────────────────────────────────────── */
    library:  '<rect x="4" y="4.5" width="3.2" height="15" rx="1"/><rect x="9.4" y="4.5" width="3.2" height="15" rx="1"/><path d="m15.6 5.4 2.9.8a1 1 0 0 1 .7 1.2l-3.4 12.1"/><path d="M4 20.5h16"/>',
    package:  '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
    memory:   '<path d="M9 3.5h6a1.5 1.5 0 0 1 0 3H9a1.5 1.5 0 0 1 0-3ZM9 17.5h6a1.5 1.5 0 0 1 0 3H9a1.5 1.5 0 0 1 0-3Z"/><path d="M12 6.5v11"/><path d="M12 8.5H8a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h4M12 8.5h4a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-4"/>',
    export:   '<path d="M12 3.5v11"/><path d="m8 10.5 4 4 4-4"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
    download: '<path d="M12 3.5v11"/><path d="m8 10.5 4 4 4-4"/><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"/>',
    upload:   '<path d="M12 20.5v-11"/><path d="m8 13.5 4-4 4 4"/><path d="M4.5 7.5v-2a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v2"/>',
    attach:   '<path d="M20 11.5 12.4 19a5 5 0 0 1-7-7l7.6-7.6a3.3 3.3 0 0 1 4.7 4.7L10 16.8a1.7 1.7 0 0 1-2.4-2.4l7-7"/>',
    trash:    '<path d="M4.5 6.5h15"/><path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5"/><path d="M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
    edit:     '<path d="M16.5 4.2a2.3 2.3 0 0 1 3.3 3.3L8.5 18.8 4 20l1.2-4.5L16.5 4.2Z"/>',
    history:  '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4.5V9H8"/><path d="M12 7.5V12l3 2"/>',
    star:     '<path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9L12 3.6Z"/>',
    copy:     '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5v-2a2.5 2.5 0 0 0-2.5-2.5H6a2.5 2.5 0 0 0-2.5 2.5V13a2.5 2.5 0 0 0 2.5 2.5h2"/>',
    eye:      '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff:   '<path d="M10.6 6.1A8.6 8.6 0 0 1 12 6c6 0 9.5 6 9.5 6a15.6 15.6 0 0 1-3.4 4.1M6.6 7.6A15.5 15.5 0 0 0 2.5 12s3.5 6 9.5 6a8.9 8.9 0 0 0 3.8-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3.5 3.5 17 17"/>',
    refresh:  '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V9H16"/>',
    sun:      '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    moon:     '<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8Z"/>',
    chevronRight: '<path d="m9 5 7 7-7 7"/>',
    chevronDown:  '<path d="m5 9 7 7 7-7"/>',
    arrowLeft:    '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
    arrowDown:    '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
    flow:     '<rect x="3.5" y="4" width="6" height="5" rx="1.5"/><rect x="14.5" y="15" width="6" height="5" rx="1.5"/><path d="M6.5 9v7.5a2.5 2.5 0 0 0 2.5 2.5h5.5"/>',
    scale:    '<path d="M12 4.5v15M7 20h10"/><path d="M4.5 10h15"/><path d="M7.5 10 4.5 15.5a3 3 0 0 0 6 0L7.5 10ZM16.5 10l-3 5.5a3 3 0 0 0 6 0l-3-5.5Z"/>',
    file:     '<path d="M13.5 3.5H7A2.5 2.5 0 0 0 4.5 6v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5V9.5l-6-6Z"/><path d="M13.5 3.5v6h6"/>',
    folder:   '<path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h3l2 2.5h7A2.5 2.5 0 0 1 20.5 9.5V17A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17V7Z"/>',
    plugin:   '<path d="M9 3.5v3M15 3.5v3"/><path d="M6.5 6.5h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z"/><path d="M12 10.5v5M9.5 13h5"/>',
    chart:    '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx=".8"/><rect x="12" y="8" width="3" height="9" rx=".8"/><rect x="17" y="10" width="3" height="7" rx=".8"/>',
    shield:   '<path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.7 7 9 4.1-1.3 7-4.7 7-9V6.2L12 3.5Z"/><path d="m9 12 2 2 4-4"/>',
    bolt:     '<path d="M13.8 2.8 5 13.2a.6.6 0 0 0 .5 1h4.9l-1.2 6.9a.6.6 0 0 0 1.1.5L19 11.3a.6.6 0 0 0-.5-1h-4.9l1.2-6.9a.6.6 0 0 0-1.1-.6Z"/>',
    save:     '<path d="M5.5 3.5h9l5 5v11a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M8 3.5v6h7v-6"/><rect x="8" y="13" width="8" height="6" rx="1"/>',
    lightbulb:'<path d="M9.5 18h5"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 1 3.5 10.9c-.4.3-.5.7-.5 1.1v.5h-6V15c0-.4-.1-.8-.5-1.1A6 6 0 0 1 12 3Z"/>',
    book:     '<path d="M4.5 4.5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2h-6v-13Z"/><path d="M19.5 4.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6v-13Z"/>',
    link:     '<path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5"/><path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5"/>',
    send:     '<path d="M20.5 3.5 3.5 10.5l7 2.5 2.5 7 7.5-16.5Z"/><path d="m10.5 13 4-4"/>',
    stop:     '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
    user:     '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    sparkle:  '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/>',
    calendar: '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/><path d="M3.5 10.5h17M8 3.5v4M16 3.5v4"/>',
    lock:     '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    wand:     '<path d="m4 20 11-11"/><path d="m14 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/><path d="m19 12 .7 1.3 1.3.7-1.3.7L19 16l-.7-1.3-1.3-.7 1.3-.7L19 12Z"/>',
    grid:     '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    list:     '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
    monitor:  '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
    hand:     '<path d="M8 12V5.5a1.75 1.75 0 0 1 3.5 0V11"/><path d="M11.5 10.5V4.75a1.75 1.75 0 0 1 3.5 0v5.75"/><path d="M15 10.5V6.75a1.75 1.75 0 0 1 3.5 0V14a7 7 0 0 1-7 7h-.6a6 6 0 0 1-5-2.7l-2.3-3.5a1.75 1.75 0 0 1 2.7-2.2L8 14.5"/>',
    bell:     '<path d="M18 9a6 6 0 1 0-12 0c0 4-1.5 5.5-1.5 5.5h15S18 13 18 9Z"/><path d="M13.7 18a2 2 0 0 1-3.4 0"/>',
    robot:    '<rect x="4" y="8.5" width="16" height="10.5" rx="3.5"/><path d="M12 5v3.5"/><circle cx="12" cy="3.7" r="1.2"/><path d="M9 12.8h.01M15 12.8h.01M9.5 16h5"/>',
    clock:    '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    image:    '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 17 4.7-4.7a2 2 0 0 1 2.8 0L16.5 17"/><path d="m14.5 13 1.7-1.7a2 2 0 0 1 2.8 0l1.5 1.5"/>',
    key:      '<circle cx="8" cy="13" r="4.5"/><path d="m11.5 9.5 8-8"/><path d="m17 4 2 2M14.5 6.5l2 2"/>',
    panel:    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
    broom:    '<path d="m14 4 6 6"/><path d="M12.5 5.5 18.5 11.5l-4 4-6-6 4-4Z"/><path d="M8.5 9.5 3.5 20.5l11-5"/>',
    target:   '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    compass:  '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
    wave:     '<path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/><path d="M3 17c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>',
    queue:    '<path d="M8.5 7.5h11M8.5 12h11M8.5 16.5h11"/><path d="m3.5 7.5 1.5 1.5 2-2.5"/><path d="m3.5 12 1.5 1.5 2-2.5"/><path d="m3.5 16.5 1.5 1.5 2-2.5"/>',
    sidebar:  '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M10.5 4.5v15"/><path d="m15.5 10-2 2 2 2"/>'
  };

  /* 需要实心填充的图标（勾、星、闪电等观感更好） */
  var FILLED = { check: 0, stop: 0 };

  /** 生成一个图标元素。
   *  @param {string} name  ICONS 中的键名
   *  @param {object} [opt] { size:number, cls:string, title:string }
   *  @returns {string} HTML 字符串 */
  function icon(name, opt) {
    opt = opt || {};
    if (!ICONS[name]) {
      if (window.console) console.warn('[icons] 未知图标:', name);
      return '';
    }

    var size = Math.min(64, Math.max(8, parseInt(opt.size, 10) || 18));
    var cls = 'ic' + (opt.cls ? ' ' + String(opt.cls).replace(/[^A-Za-z0-9_-]/g, '') : '');
    var title = opt.title ? ' role="img" aria-label="' + String(opt.title).replace(/"/g, '&quot;') + '"' : ' aria-hidden="true"';
    return '<svg class="' + cls + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"' +
      ' stroke-linecap="round" stroke-linejoin="round"' + title + '><use href="#i-' + name + '"></use></svg>';
  }

  /** 把 sprite 注入到 body 末尾（只需一次）。 */
  function injectSprite() {
    if (document.getElementById('academy-icon-sprite')) return;
    var svg = ['<svg id="academy-icon-sprite" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">'];
    for (var k in ICONS) {
      if (!Object.prototype.hasOwnProperty.call(ICONS, k)) continue;
      svg.push('<symbol id="i-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + '</symbol>');
    }
    svg.push('</svg>');
    var host = document.createElement('div');
    host.innerHTML = svg.join('');
    document.body.appendChild(host.firstChild);
  }

  window.AcademyIcons = { icon: icon, injectSprite: injectSprite, ICONS: ICONS };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSprite);
  } else {
    injectSprite();
  }
})();
