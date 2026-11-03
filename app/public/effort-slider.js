/* effort-slider.js — Codex 风格「模型 + 推理等级」控件
 *
 * 由来：子涵看到 dsh-codex-effort-slider（DSH 插件，MIT，Microqian2th）后提出
 *   「把咱们对话框那的模型选择器和强度选择做成这个东西，然后移到发送按钮的左边」。
 * 本文件是那个插件的**思想与观感**在 Academy 桌面版前端的独立实现：
 *   · 一档一色：填充从蓝渐变到紫罗兰，越往右越「通电」，最高档亮起紫色星云 + 星尘粒子
 *   · 官方那一行的数值文字跟着变色（Off 档保持灰）
 *   · 收起态的席按钮上也按档位着色（点开之前就看得见）
 * 配色/能量/粒子/速率全部是**位置的纯函数**，与档位数无关 —— 换成 2 档或 6 档照样成立。
 *
 * 与那个插件的结构差异（刻意的）：
 *   它是 DSH 插件，只能用 DOM 桥去改造官方那条「推理等级」行；
 *   我们是自己的前端，所以直接把这个控件做成第一等公民（自带席按钮 + 菜单 + 滑条），
 *   不需要 portal、不需要认官方锚点、也不存在「认不出就静默失效」。
 *
 * 对外接口（window.AcademyEffort）：
 *   init({ getModelName, onModelChange, onEffortChange })   初始化并接管
 *   sync({ effort, modelName, busy })                       外部状态变化时刷新
 *   OPTIONS                                                 四档的 id / 中文名
 */
(function () {
  'use strict';

  /* ── 四档：id 与中文名。顺序即滑条从左到右的顺序（与内核 off<low<high<max 一致）。 ── */
  var OPTIONS = [
    { id: 'off', name: '关闭' },
    { id: 'low', name: '轻量' },
    { id: 'high', name: '标准' },
    { id: 'max', name: '最强' },
  ];

  /* ── 尺寸与速率常量（必须在任何用到它们的计算之前） ── */
  var TRACK_HEIGHT = 26;
  var KNOB_SIZE = TRACK_HEIGHT;
  var KNOB_RADIUS = KNOB_SIZE / 2;
  var STARFIELD_DURATION_MEAN = 1.5;
  var STARFIELD_DURATION_SPREAD = 0.08;
  var STARFIELD_MIN = 0.5;
  var GOLDEN_RATIO = 0.6180339887498949;
  var MAX_SPEED_FACTOR = 2;
  var REDUCED_MOTION_SLOWDOWN = 2.6;
  var MIN_HEIGHT_SLOTS = 3;

  /* 颜色锚点：第二档以前是纯净的蓝，之后才渐入紫，最高档到深紫。 */
  var COLOR_BLUE = [18, 10, 143];
  var COLOR_VIOLET = [147, 51, 234];
  var COLOR_DEEP = [76, 29, 149];
  var COLOR_TEXT_VIOLET = [139, 92, 246];

  /* 能量段起点：档位表里第二档的位置（4 档 → 1/3）。 */
  var ENERGY_START = 1 / 3;
  var ENERGY_END = 2 / 3;

  function clamp01(v) { if (!(v > 0)) return 0; return v > 1 ? 1 : v; }
  function indexFromPct(pct, count) {
    if (count <= 1) return 0;
    return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))));
  }
  function pctFromIndex(index, count) {
    if (count <= 1) return 0;
    return Math.max(0, Math.min(count - 1, index)) / (count - 1);
  }
  function mixColor(from, to, t) {
    var k = clamp01(t);
    return [
      Math.round(from[0] + (to[0] - from[0]) * k),
      Math.round(from[1] + (to[1] - from[1]) * k),
      Math.round(from[2] + (to[2] - from[2]) * k),
    ];
  }
  function rgbOf(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  /** 位置 → 填充色（渐变右端的颜色）。 */
  function fillColorFor(pct) {
    var t = clamp01(pct);
    if (t <= ENERGY_START) return rgbOf(COLOR_BLUE);
    if (t <= ENERGY_END) return rgbOf(mixColor(COLOR_BLUE, COLOR_VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START)));
    return rgbOf(mixColor(COLOR_VIOLET, COLOR_DEEP, (t - ENERGY_END) / (1 - ENERGY_END)));
  }
  /** 填充层背景：左端恒为蓝、右端是当前位置的颜色 —— high 档自然「左蓝右紫」。 */
  function fillBackgroundFor(pct) {
    return 'linear-gradient(90deg,' + rgbOf(COLOR_BLUE) + ',' + fillColorFor(pct) + ')';
  }
  function isOffLevel(level) {
    if (!level) return false;
    var c = [level.id, level.name];
    for (var i = 0; i < c.length; i += 1) {
      if (typeof c[i] !== 'string') continue;
      var flat = c[i].replace(/\s+/g, '').toLowerCase();
      if (flat === 'off' || flat === 'none' || flat === '关闭' || flat === '无') return true;
    }
    return false;
  }
  /** 位置 → 数值文字色；Off 档返回空串（= 清掉内联色，回到设计系统原色）。 */
  function valueColorFor(pct, level) {
    if (isOffLevel(level)) return '';
    return 'var(--c-accent-text)';
  }
  /** 位置 → 能量强度 0..1：第二档以前为 0（干净的蓝），之后线性渐入。 */
  function energyFor(pct) { return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START)); }
  /** 位置 → 粒子速率：high（2/3 处）= 1×，最高档 2×，左端下限 0.35×。 */
  function speedFor(pct) { return Math.min(2, Math.max(0.35, 3 * clamp01(pct) - 1)); }
  function particleCountFor(pct) { return Math.round(energyFor(pct) * 22); }
  /** 旋钮圆心 / 填充终点 / 刻度共用同一套内缩几何 —— 两端的圆永远是完整的圆。 */
  function knobOffsetOf(pct) {
    var t = Math.round(clamp01(pct) * 10000) / 10000;
    return 'calc(' + KNOB_RADIUS + 'px + ' + t + ' * (100% - ' + KNOB_RADIUS * 2 + 'px))';
  }

  function starHash01(index, salt) {
    var value = (index + 1) * salt * 2654435761 % 4294967296;
    return ((value >>> 8) % 1000) / 1000;
  }
  function starBrightnessFor(index) { return STARFIELD_MIN + (1 - STARFIELD_MIN) * starHash01(index, 61); }
  function starDurationFor(index, speedFactor) {
    var speed = Math.min(MAX_SPEED_FACTOR, Math.max(0.35, typeof speedFactor === 'number' ? speedFactor : MAX_SPEED_FACTOR));
    var spread = 1 - STARFIELD_DURATION_SPREAD + 2 * STARFIELD_DURATION_SPREAD * starHash01(index, 29);
    return STARFIELD_DURATION_MEAN * MAX_SPEED_FACTOR / speed * spread;
  }
  /** 相位只跟 index 有关（黄金比低差异序列）：拖动改变粒子数时不会整体重排。 */
  function starDelayFor(index, duration) {
    var p = PARTICLES[index];
    var phase = p && typeof p.phase === 'number' ? p.phase : 0;
    return -((phase + starHash01(index, 53) * 0.03) % 1) * duration;
  }
  function starCountFor(pct) { return particleCountFor(pct); }
  /** 星星层不跟星云一起淡入（否则 high 档被星云 0.5 透明度压得看不见）。 */
  function starLayerOpacityFor(pct) { return 0.6 + 0.4 * energyFor(pct); }

  /* 22 颗星的（高度, 相位）。高度用确定性随机排列的等距槽位，与相位排名解耦，
     并挑一个盐值保证「相位相邻」的两颗至少差 MIN_HEIGHT_SLOTS 槽，避免并成一坨。 */
  var PARTICLES = (function buildParticles() {
    var count = 22, out = [], i;
    for (i = 0; i < count; i += 1) out.push({ y: 0, phase: (i + 1) * GOLDEN_RATIO % 1 });
    var byPhase = [];
    for (i = 0; i < count; i += 1) byPhase.push(i);
    byPhase.sort(function (a, b) { return out[a].phase - out[b].phase; });
    var slots = null;
    for (var salt = 71; salt < 4000 && slots === null; salt += 1) {
      var cand = [];
      for (i = 0; i < count; i += 1) cand.push(i);
      cand.sort(function (a, b) {
        var ha = starHash01(a, salt), hb = starHash01(b, salt);
        return ha === hb ? a - b : ha - hb;
      });
      var ok = true;
      for (var k = 1; k < count && ok; k += 1) if (Math.abs(cand[k] - cand[k - 1]) < MIN_HEIGHT_SLOTS) ok = false;
      if (ok) slots = cand;
    }
    if (slots === null) { slots = []; for (i = 0; i < count; i += 1) slots.push(i * 5 % count); }
    for (var rank = 0; rank < count; rank += 1) out[byPhase[rank]].y = 8 + (slots[rank] / (count - 1)) * 84;
    return out;
  })();

  /* ════════════════ 控件本体 ════════════════ */

  var els = {};
  var opts = { getModelName: null, onModelChange: null, onEffortChange: null };
  var state = { effort: 'high', modelName: '', busy: false, open: false, draftPct: null, error: '' };
  var root = null;

  function levelIndexOf(id) {
    for (var i = 0; i < OPTIONS.length; i += 1) if (OPTIONS[i].id === id) return i;
    return indexOfDefault();
  }
  function indexOfDefault() { var i = levelIndexOfRaw('high'); return i < 0 ? 0 : i; }
  function levelIndexOfRaw(id) {
    for (var i = 0; i < OPTIONS.length; i += 1) if (OPTIONS[i].id === id) return i;
    return -1;
  }
  function currentIndex() { return Math.max(0, levelIndexOf(state.effort)); }
  function currentPct() { return pctFromIndex(currentIndex(), OPTIONS.length); }

  /** 滑条上「当前显示」的位置：拖动中是草稿位置，否则是已生效档位。 */
  function shownPct() { return state.draftPct === null ? currentPct() : state.draftPct; }

  function renderStars(container, pct) {
    var count = starCountFor(pct);
    var speed = speedFor(pct);
    var reduced = false;
    try { reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) {}
    /* 只在数量变化时重建，避免每帧重排 —— 相位只跟 index 有关，重建也不会跳。 */
    if (container.childElementCount !== count) {
      container.innerHTML = '';
      for (var i = 0; i < count; i += 1) {
        var star = document.createElement('span');
        star.className = 'gear-star';
        star.style.top = PARTICLES[i].y + '%';
        var dot = document.createElement('span');
        dot.className = 'gear-star__dot';
        var b = starBrightnessFor(i).toFixed(3);
        dot.style.setProperty('--gear-b', b);
        star.appendChild(dot);
        container.appendChild(star);
      }
    }
    /* 时长/负相位**必须内联**：写成 CSS 变量时负相位在真引擎里不生效（插件实测踩过）。 */
    for (var j = 0; j < container.childElementCount; j += 1) {
      var node = container.children[j];
      var dur = starDurationFor(j, speed) * (reduced ? REDUCED_MOTION_SLOWDOWN : 1);
      node.style.animationDuration = dur.toFixed(3) + 's';
      node.style.animationDelay = starDelayFor(j, dur).toFixed(3) + 's';
    }
  }

  function paint() {
    if (!root) return;
    var pct = shownPct();
    var idx = indexFromPct(pct, OPTIONS.length);
    var level = OPTIONS[idx];
    var energy = energyFor(pct);
    root.style.setProperty('--gear-energy', String(energy));
    root.setAttribute('data-energy', energy > 0 ? '1' : '0');

    if (els.fill) {
      els.fill.style.width = knobOffsetOf(pct);
      els.fill.style.background = fillBackgroundFor(pct);
    }
    if (els.energy) els.energy.style.width = knobOffsetOf(pct);
    if (els.knob) els.knob.style.left = knobOffsetOf(pct);
    if (els.stars) {
      els.stars.style.width = knobOffsetOf(pct);
      els.stars.style.opacity = starLayerOpacityFor(pct).toFixed(3);
      renderStars(els.stars, pct);
    }
    if (els.ticks) {
      for (var t = 0; t < els.ticks.length; t += 1) {
        els.ticks[t].style.left = knobOffsetOf(pctFromIndex(t, OPTIONS.length));
        els.ticks[t].setAttribute('data-on', t <= idx ? '1' : '0');
      }
    }
    if (els.track) {
      els.track.setAttribute('aria-valuemax', String(OPTIONS.length - 1));
      els.track.setAttribute('aria-valuenow', String(idx));
      els.track.setAttribute('aria-valuetext', level.name);
      /* title 只放**档位名本身** —— 英文模式的词典是「整串精确匹配 + 若干正则」，
         拼成「推理等级：最强」这种合成串两边都命中不了、会残留中文。
         档位名是词典里已有的键（最强 → Max），放在 title 里能被精确替换掉。
         上下文由上面那行「推理等级 / Effort」标签承担，不必再塞进 tooltip。 */
      els.track.title = level.name;
    }
    /* 数值文字跟着变色；Off 档空串 = 清掉内联色，回到原样。 */
    if (els.value) {
      els.value.textContent = level.name;
      els.value.style.color = valueColorFor(currentPct(), OPTIONS[currentIndex()]);
    }
    if (els.seatEffort) {
      els.seatEffort.textContent = level.name;
      els.seatEffort.style.color = valueColorFor(currentPct(), OPTIONS[currentIndex()]);
    }
    if (els.error) {
      els.error.textContent = state.error || '';
      els.error.hidden = !state.error;
    }
  }

  /** 指针位置 → 百分比（用同一套内缩几何，拖到两端必定命中端点档位）。 */
  function pctAt(clientX) {
    var rect = els.track.getBoundingClientRect();
    var x = clientX - rect.left - KNOB_RADIUS;
    var span = rect.width - KNOB_RADIUS * 2;
    if (!(span > 0)) return 0;
    return clamp01(x / span);
  }

  function refreshSeat() {
    if (els.seatModel) els.seatModel.textContent = state.modelName || '未配置';
    if (els.seat) els.seat.disabled = state.busy;
  }

  /* ── 开合 ── */
  function openMenu() {
    if (state.open || state.busy) return;
    state.open = true;
    state.draftPct = null;
    state.error = '';
    els.menu.classList.remove('hidden');
    els.seat.setAttribute('aria-expanded', 'true');
    paint();
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }
  function closeMenu() {
    if (!state.open) return;
    state.open = false;
    state.draftPct = null;
    els.menu.classList.add('hidden');
    els.seat.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
    paint();
  }
  function onDocDown(e) { if (root && !root.contains(e.target)) closeMenu(); }
  function onDocKey(e) { if (e.key === 'Escape') { closeMenu(); els.seat.focus(); } }

  /* ── 拖动 ── */
  var dragging = false;
  var pendingId = null;
  var commitTimer = null;
  var COMMIT_THROTTLE_MS = 120;

  function onTrackDown(e) {
    if (state.busy) return;
    dragging = true;
    try { els.track.setPointerCapture(e.pointerId); } catch (_) {}
    state.draftPct = pctAt(e.clientX);
    paint();
    e.preventDefault();
  }
  function onTrackMove(e) {
    if (!dragging) return;
    state.draftPct = pctAt(e.clientX);
    paint();
    scheduleCommit();
    e.preventDefault();
  }
  function onTrackUp(e) {
    if (!dragging) return;
    dragging = false;
    try { els.track.releasePointerCapture(e.pointerId); } catch (_) {}
    scheduleCommit(true);
  }
  /** 拖动写入降频：同档位去重 + 定时合并；松手立刻落地。 */
  function scheduleCommit(immediate) {
    var id = OPTIONS[indexFromPct(state.draftPct === null ? currentPct() : state.draftPct, OPTIONS.length)].id;
    if (id === state.effort) { pendingId = null; return; }
    pendingId = id;
    if (immediate) { if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; } commit(pendingId); return; }
    if (commitTimer) return;
    commitTimer = setTimeout(function () { commitTimer = null; if (pendingId) commit(pendingId); }, COMMIT_THROTTLE_MS);
  }
  async function commit(id) {
    var prev = state.effort;
    state.effort = id;
    state.error = '';
    paint();
    try {
      var ok = await opts.onEffortChange(id);
      if (ok === false) throw new Error('切换失败');
      state.draftPct = null;
      paint();
    } catch (err) {
      /* 失败回滚到真实档位，并说明原因 —— 不谎报成功。 */
      state.effort = prev;
      state.draftPct = null;
      state.error = (err && err.message) ? err.message : '档位切换失败';
      paint();
    }
  }

  function onKeyDown(e) {
    if (state.busy) return;
    var idx = currentIndex(), next = -1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, idx - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(OPTIONS.length - 1, idx + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = OPTIONS.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    state.draftPct = null;
    commit(OPTIONS[next].id);
  }

  function init(o) {
    opts = Object.assign(opts, o || {});
    root = document.getElementById('composerGear');
    if (!root) return null;
    els = {
      root: root,
      seat: document.getElementById('gearSeat'),
      seatModel: document.getElementById('gearModel'),
      seatEffort: document.getElementById('gearEffort'),
      menu: document.getElementById('gearMenu'),
      value: document.getElementById('gearEffortValue'),
      track: document.getElementById('gearTrack'),
      fill: root.querySelector('[data-gear-part="fill"]'),
      energy: root.querySelector('[data-gear-part="energy"]'),
      stars: root.querySelector('[data-gear-part="stars"]'),
      knob: root.querySelector('[data-gear-part="knob"]'),
      error: null,
      ticks: Array.prototype.slice.call(root.querySelectorAll('[data-gear-part="tick"]')),
    };
    var err = document.createElement('div');
    err.className = 'gear-error';
    err.setAttribute('role', 'status');
    err.hidden = true;
    els.menu.appendChild(err);
    els.error = err;

    els.seat.onclick = function () { state.open ? closeMenu() : openMenu(); };
    els.track.addEventListener('pointerdown', onTrackDown);
    els.track.addEventListener('pointermove', onTrackMove);
    els.track.addEventListener('pointerup', onTrackUp);
    els.track.addEventListener('pointercancel', onTrackUp);
    els.track.addEventListener('keydown', onKeyDown);
    /* 吞掉自己的 click：别让拖动被当成点击穿透到别的控件。 */
    els.track.addEventListener('click', function (e) { e.stopPropagation(); });
    refreshSeat();
    paint();
    return api;
  }

  function sync(next) {
    if (!next) return;
    if (next.modelName !== undefined) state.modelName = String(next.modelName || '');
    if (next.effort !== undefined) state.effort = levelIndexOfRaw(next.effort) >= 0 ? next.effort : 'high';
    if (next.busy !== undefined) state.busy = !!next.busy;
    refreshSeat();
    paint();
  }

  var api = { init: init, sync: sync, OPTIONS: OPTIONS, close: closeMenu,
    _internals: { fillColorFor: fillColorFor, energyFor: energyFor, speedFor: speedFor,
      particleCountFor: particleCountFor, indexFromPct: indexFromPct, pctFromIndex: pctFromIndex,
      knobOffsetOf: knobOffsetOf, valueColorFor: valueColorFor, isOffLevel: isOffLevel,
      starDurationFor: starDurationFor, starLayerOpacityFor: starLayerOpacityFor, PARTICLES: PARTICLES } };
  window.AcademyEffort = api;
})();
