#!/usr/bin/env node
/* askInput 应用内输入弹窗实跑验证（Electron 真实渲染）。
 *
 * 为什么需要它：caseRename 原来用 window.prompt，Electron 直接抛错
 * 「点了没反应」。换成 askInput 后要证明两件事：
 *   1. 提交路径：填值 → 点确定 → 拿到 {values}
 *   2. 取消路径：点取消 / 关闭按钮 → 拿到 null
 * 静态扫描查不出「弹窗渲染出来但按钮没绑上」这类运行时问题。
 *
 * 用法（必须用 Electron 跑）：
 *   .\runtime\electron\dist\electron.exe tools/verify-input-modal.js <项目根> [输出json]
 * 前置：PATROL_PORT（默认 8795）上已有隔离数据目录的服务在跑。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-input-modal.json');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1180, height: 760, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2500);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];

  /* ---- 1. 提交路径：双字段（一个必填一个可留空），点确定 ---- */
  const submit = await ex(`(function(){
    return new Promise(function(res){
      var p = askInput({ title: '验证提交', fields: [
        { key: 'motion', label: '辩题名称', value: '测试辩题' },
        { key: 'side', label: '持方', value: '正方', optional: true }
      ]});
      p.then(function(v){ res({ resolved: true, v: v }); });
      setTimeout(function(){ var ok = document.getElementById('inputModalOk'); if (ok) ok.click(); }, 400);
    });
  })()`);
  results.push({
    case: '提交路径',
    pass: !!(submit && submit.resolved && submit.v && submit.v.motion === '测试辩题' && submit.v.side === '正方'),
    got: JSON.stringify(submit)
  });

  /* ---- 2. 取消路径：点取消，必须 resolve(null) 而不是永远挂起 ---- */
  const cancel = await ex(`(function(){
    return new Promise(function(res){
      var p = askInput({ title: '验证取消', fields: [{ key: 'a', label: 'A' }] });
      p.then(function(v){ res({ resolved: true, v: v }); });
      setTimeout(function(){ var c = document.getElementById('inputModalCancel'); if (c) c.click(); }, 400);
    });
  })()`);
  results.push({
    case: '取消路径',
    pass: !!(cancel && cancel.resolved && cancel.v === null),
    got: JSON.stringify(cancel)
  });

  /* ---- 3. × 关闭路径：同样必须 resolve(null) ---- */
  const close = await ex(`(function(){
    return new Promise(function(res){
      var p = askInput({ title: '验证关闭', fields: [{ key: 'a', label: 'A' }] });
      p.then(function(v){ res({ resolved: true, v: v }); });
      setTimeout(function(){ var c = document.querySelector('#inputModal .modal-close'); if (c) c.click(); }, 400);
    });
  })()`);
  results.push({
    case: '×关闭路径',
    pass: !!(close && close.resolved && close.v === null),
    got: JSON.stringify(close)
  });

  /* ---- 4. 必填校验：清空必填项点确定 → 弹窗不关、不提交 ---- */
  const required = await ex(`(function(){
    return new Promise(function(res){
      var p = askInput({ title: '验证必填', fields: [{ key: 'a', label: 'A' }] });
      p.then(function(v){ res({ resolved: true, v: v }); });
      setTimeout(function(){
        var modal = document.getElementById('inputModal');
        var inp = modal.querySelector('input');
        if (inp) inp.value = '';
        var ok = document.getElementById('inputModalOk');
        if (ok) ok.click();
        /* 再给 300ms：如果错误地提交/关闭了，promise 会 resolve */
        setTimeout(function(){
          res({ resolved: false, stillOpen: !modal.classList.contains('hidden') });
        }, 300);
      }, 400);
    });
  })()`);
  results.push({
    case: '必填校验（留空不提交）',
    pass: !!(required && !required.resolved && required.stillOpen),
    got: JSON.stringify(required)
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const fails = results.filter((r) => !r.pass);
  console.log('askInput 验证：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  for (const r of results) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '  got=' + r.got));
  app.quit();
  if (fails.length) process.exitCode = 1;
}).catch(function (e) { console.error('ERR ' + e.message); app.quit(); process.exitCode = 1; });
