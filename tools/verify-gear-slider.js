#!/usr/bin/env node
/* 「模型 + 推理等级」控件（Codex 风格滑条）回归验证 —— Electron 真实渲染。
 *
 * 为什么必须真渲染：这个控件的要害全在**运行时几何与观感**上 ——
 *   · 滑条有没有真的在发送按钮左边、有没有把工具条撑坏
 *   · 拖动到某一档，旋钮位置 / 填充宽度 / 刻度是不是**同一套几何**算出来的
 *   · 高档位有没有真的上紫色能量层与星尘（静态 CSS 在场 ≠ 元素被渲染出来）
 *   · 点开菜单 → 拖动 → 松手，有没有真的把档位写给服务端
 * 静态扫描一条都证明不了，所以按 verify-deliver-tabs.js 的骨架做真渲染断言。
 *
 * 用法（必须用 Electron 跑）：
 *   runtime\electron\dist\electron.exe tools/verify-gear-slider.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8795）上已有隔离数据目录的服务在跑。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-gear-slider.json');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify-gear'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 840, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2500);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? '  OK  ' : '  FAIL') + ' ' + name + (detail ? ' · ' + detail : '')); };

  try {
    const layout = await ex(`(function(){
      var gear = document.getElementById('composerGear');
      var send = document.getElementById('btnSend');
      if (!gear || !send) return { ok: false };
      var g = gear.getBoundingClientRect(), s = send.getBoundingClientRect();
      return {
        ok: true,
        gearRight: Math.round(g.right), sendLeft: Math.round(s.left),
        gearH: Math.round(g.height),
        sameRow: Math.abs((g.top + g.height / 2) - (s.top + s.height / 2)) < 8,
        oldEffort: !!document.getElementById('composerEffortSelect'),
        seatText: (document.getElementById('gearSeat') || {}).innerText || '',
      };
    })()`);
    check('控件渲染出来了', layout.ok);
    check('★ 控件在发送按钮左侧（且同一行）', layout.ok && layout.gearRight <= layout.sendLeft + 1 && layout.sameRow,
      'gear.right=' + layout.gearRight + ' send.left=' + layout.sendLeft + ' sameRow=' + layout.sameRow);
    check('★ 旧的「思考强度」下拉已移除', layout.ok && layout.oldEffort === false);
    check('收起态席按钮上能读到档位名', /标准|轻量|最强|关闭/.test(layout.seatText || ''), JSON.stringify(layout.seatText));

    await ex(`(function(){ document.getElementById('gearSeat').click(); return 1; })()`);
    await sleep(400);
    const geo = await ex(`(function(){
      var menu = document.getElementById('gearMenu');
      var track = document.getElementById('gearTrack');
      if (!menu || !track) return { ok: false };
      var open = !menu.classList.contains('hidden');
      var t = track.getBoundingClientRect();
      var fill = track.querySelector('[data-gear-part="fill"]');
      var knob = track.querySelector('[data-gear-part="knob"]');
      var f = fill.getBoundingClientRect(), k = knob.getBoundingClientRect();
      var ticks = Array.prototype.slice.call(track.querySelectorAll('[data-gear-part="tick"]'));
      var knobCenterX = k.left + k.width / 2;
      return {
        ok: open,
        trackW: Math.round(t.width), trackH: Math.round(t.height),
        knobD: Math.round(k.width),
        fillRight: Math.round(f.right), knobCenterX: Math.round(knobCenterX),
        ticks: ticks.length,
        tickLefts: ticks.map(function(x){ return Math.round(x.getBoundingClientRect().left); }),
        knobInside: k.left >= t.left - 1 && k.right <= t.right + 1,
        trackInsideMenu: t.right <= menu.getBoundingClientRect().right + 1 && t.left >= menu.getBoundingClientRect().left - 1,
      };
    })()`);
    check('点开菜单后滑条可见', geo.ok);
    check('★ 旋钮是正圆且直径 = 轨道高', geo.ok && geo.knobD === geo.trackH, 'knobD=' + geo.knobD + ' trackH=' + geo.trackH);
    check('★ 填充右端与旋钮圆心重合（同一套内缩几何）', geo.ok && Math.abs(geo.fillRight - geo.knobCenterX) <= 2,
      'fillRight=' + geo.fillRight + ' knobCenterX=' + geo.knobCenterX);
    check('★ 两端的圆完整落在轨道内（不顶出被裁）', geo.ok && geo.knobInside);
    check('滑条不溢出菜单', geo.ok && geo.trackInsideMenu);
    check('四个刻度点在场（对应四档）', geo.ok && geo.ticks === 4, 'ticks=' + geo.ticks);
    check('★ 刻度点等距分布', geo.ok && (function(){
      var dd = [];
      for (var i = 1; i < geo.tickLefts.length; i++) dd.push(geo.tickLefts[i] - geo.tickLefts[i-1]);
      var max = Math.max.apply(null, dd), min = Math.min.apply(null, dd);
      return max - min <= 2;
    })(), JSON.stringify(geo.tickLefts));

    const drag = await ex(`(function(){
      var root = document.getElementById('composerGear');
      var track = document.getElementById('gearTrack');
      var r = track.getBoundingClientRect();
      function pd(type, x){
        track.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height/2, pointerId: 1, isPrimary: true }));
      }
      pd('pointerdown', r.left + 2);
      pd('pointermove', r.right - 2);
      var stars = track.querySelector('[data-gear-part="stars"]');
      return {
        energy: root.style.getPropertyValue('--gear-energy'),
        dataEnergy: root.getAttribute('data-energy'),
        stars: track.querySelectorAll('.gear-star').length,
        starOpacity: stars ? stars.style.opacity : '',
      };
    })()`);
    await sleep(300);
    check('★ 拖到最高档后能量强度 = 1（越往右越通电）', String(drag.energy) === '1', 'energy=' + drag.energy);
    check('★ 高档位亮起能量层（data-energy=1）', drag.dataEnergy === '1');
    check('★ 星尘粒子已渲染（最高档 22 颗）', drag.stars === 22, 'stars=' + drag.stars);

    const low = await ex(`(function(){
      var root = document.getElementById('composerGear');
      var track = document.getElementById('gearTrack');
      var r = track.getBoundingClientRect();
      function pd(type, x){
        track.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height/2, pointerId: 1, isPrimary: true }));
      }
      var x = r.left + (r.width) * (1/3);
      pd('pointerdown', x);
      return { energy: root.style.getPropertyValue('--gear-energy'), stars: track.querySelectorAll('.gear-star').length };
    })()`);
    await sleep(300);
    check('★ 第二档处能量为 0（左半段保持纯净的蓝）', Number(low.energy) === 0, 'energy=' + low.energy);
    check('★ 第二档处无星尘（还没通电）', low.stars === 0, 'stars=' + low.stars);

    const committed = await ex(`(async function(){
      var track = document.getElementById('gearTrack');
      var r = track.getBoundingClientRect();
      function pd(type, x){
        track.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: r.top + r.height/2, pointerId: 1, isPrimary: true }));
      }
      pd('pointerdown', r.right - 2);
      pd('pointermove', r.right - 2);
      pd('pointerup', r.right - 2);
      await new Promise(function(s){ setTimeout(s, 1200); });
      var st = await (await fetch('/api/status')).json();
      return { effort: st.reasoningEffort };
    })()`);
    check('★ 松手后档位已写入服务端（config.reasoningEffort = max）', committed.effort === 'max', 'reasoningEffort=' + committed.effort);

    const kb = await ex(`(async function(){
      var track = document.getElementById('gearTrack');
      track.focus();
      track.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      await new Promise(function(s){ setTimeout(s, 1200); });
      var st = await (await fetch('/api/status')).json();
      track.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
      await new Promise(function(s){ setTimeout(s, 1200); });
      var st2 = await (await fetch('/api/status')).json();
      return { afterLeft: st.reasoningEffort, afterEnd: st2.reasoningEffort };
    })()`);
    check('★ 方向键能切档（← 降到 high）', kb.afterLeft === 'high', 'afterLeft=' + kb.afterLeft);
    check('★ End 键直接到最高档', kb.afterEnd === 'max', 'afterEnd=' + kb.afterEnd);

    const neg = await ex(`(function(){
      var st = document.createElement('style');
      st.id = '__neg_geo';
      st.textContent = '#gearTrack .gear-knob{left:0 !important}';
      document.head.appendChild(st);
      var track = document.getElementById('gearTrack');
      var t = track.getBoundingClientRect();
      var k = track.querySelector('[data-gear-part="knob"]').getBoundingClientRect();
      st.remove();
      return { knobLeft: Math.round(k.left), trackLeft: Math.round(t.left), outside: k.left < t.left - 1 };
    })()`);
    check('★ 负向对照：旋钮被钉在 left:0 时确实越界（证明内缩几何断言非空转）', neg.outside,
      'knobLeft=' + neg.knobLeft + ' trackLeft=' + neg.trackLeft);

    await sleep(200);
    const failed = results.filter((r) => !r.ok);
    console.log('');
    console.log('控件回归验证：' + (results.length - failed.length) + '/' + results.length + ' 通过');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2), 'utf8');
    app.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('验证脚本异常：' + (e && e.stack || e));
    app.exit(2);
  }
});
