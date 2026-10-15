#!/usr/bin/env node
/* 体检整改 F3（服务商地址变更护栏）定向验证 —— Flash 线。
 *
 * 要证明的四件事（源码只能证明「写了」，不能证明「拦得住」）：
 *   1) 地址框旁常驻显示目标主机，陌生主机必须变红；
 *   2) 陌生主机必须经过确认；用户取消时**一个字都不写**；
 *   3) 确认后写入，服务端审计日志记下 from/to/host，且**绝不落 API Key**；
 *   4) 切搜索方式不再顺带提交地址（否则改动地址可以绕过确认直接落盘）。
 *
 * 用法：node tools/run-verify-endpoint.js   （自带隔离数据目录 + 独立端口）
 * 产物：.build/verify-endpoint.json
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = process.argv[2] || path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.build', 'verify-endpoint.json');
const PORT = Number(process.env.VERIFY_PORT || 8798);
const DATA = path.join(ROOT, '.build', 'endpoint-verify-data');
app.setPath('userData', path.join(DATA, 'electron-user-data'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD = 'https://evil-collector.example/v1';   // 陌生主机
const BAD2 = 'https://another-thief.example/v1';   // 旁路探针用
/* 运行时拼出来，源码里不留完整的 sk- 长串：开源合规检查会把它当真实密钥拦下打包。 */
const SECRET = 'sk-' + 'VERIFY-SECRET-DO-NOT-LOG';
let step = 'boot';
const mark = (s) => { step = s; console.log('… ' + s); };
const ping = () => new Promise((resolve) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1200 }, (s) => { s.resume(); resolve(s.statusCode === 200); });
  q.on('error', () => resolve(false)); q.on('timeout', () => { q.destroy(); resolve(false); });
});
const readConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch (_) { return {}; } };
const readAudit = () => { try { return fs.readFileSync(path.join(DATA, 'endpoint-audit.log'), 'utf8'); } catch (_) { return ''; } };

app.whenReady().then(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const { spawn } = require('child_process');
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + PORT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1', ELECTRON_RUN_AS_NODE: '1' }),
    stdio: 'ignore', windowsHide: true
  });
  mark('等待本地服务就绪');
  for (let i = 0; i < 40 && !(await ping()); i++) await sleep(500);
  if (!(await ping())) { console.log('✗ 本地服务起不来'); try { server.kill(); } catch (_) {} app.exit(4); }

  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const renderErrors = [];
  win.webContents.on('console-message', (e, level, message) => { if (level >= 2) renderErrors.push(message); });
  mark('加载页面');
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2500);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const push = (name, pass, got) => { results.push({ name, pass, got }); console.log((pass ? '  ✅ ' : '  ❌ ') + name + ' · ' + got); };
  const hardKill = setTimeout(() => {
    console.log('⏰ 看门狗触发，卡在：' + step);
    try { fs.writeFileSync(OUT, JSON.stringify({ watchdog: step, results }, null, 2), 'utf8'); } catch (_) {}
    try { server.kill(); } catch (_) {}
    app.exit(3);
  }, 150000);

  /* confirm 由测试控制：记录文案 + 按 __answer 返回，绝不真的弹窗（Electron 里会挂住渲染进程） */
  await ex("(function(){window.__confirms=[];window.__answer=false;window.confirm=function(m){window.__confirms.push(String(m||''));return !!window.__answer;};return 1;})()");

  mark('1 地址提示常驻显示');
  const c1 = await ex("(function(){var h=document.getElementById('endpointHint');return JSON.stringify({exists:!!h});})()");
  push('endpointHint 元素存在', JSON.parse(c1).exists, c1);

  mark('2 已知主机不告警');
  const knownHost = await ex("(function(){var b=(state.status&&state.status.baseUrl)||'https://api.deepseek.com';return endpointHostOf(b);})()");
  const c2 = await ex("(function(){var b=(state.status&&state.status.baseUrl)||'https://api.deepseek.com';" +
    "document.getElementById('baseUrlInput').value=b;var before=window.__confirms.length;" +
    "var ok=confirmEndpointChange(b);var h=document.getElementById('endpointHint');" +
    "return JSON.stringify({ok:ok,warn:h.classList.contains('warn'),text:h.textContent,asked:window.__confirms.length>before,host:endpointHostOf(b)});})()");
  const v2 = JSON.parse(c2);
  push('已知主机：不弹确认 + 提示不标红', v2.ok === true && !v2.asked && !v2.warn && v2.text.indexOf(v2.host) >= 0, c2);

  mark('3 陌生主机必须确认');
  const c3 = await ex("(function(){document.getElementById('baseUrlInput').value='" + BAD + "';" +
    "var before=window.__confirms.length;var ok=confirmEndpointChange(currentProviderBaseUrl());var h=document.getElementById('endpointHint');" +
    "return JSON.stringify({ok:ok,warn:h.classList.contains('warn'),text:h.textContent,asked:window.__confirms.length>before,msg:window.__confirms[window.__confirms.length-1]||''});})()");
  const v3 = JSON.parse(c3);
  push('陌生主机：弹确认 + 提示标红', v3.ok === false && v3.asked && v3.warn && v3.msg.indexOf('evil-collector.example') >= 0, c3);
  push('确认文案把后果讲清楚（Key 与对话内容去向）', v3.msg.indexOf('API Key') >= 0 && v3.msg.indexOf('陌生主机') >= 0, JSON.stringify(v3.msg.slice(0, 60)));

  mark('4 取消时一字不写');
  const baseBefore = readConfig().baseUrl || '';
  const auditBefore = readAudit();
  await ex("(function(){document.getElementById('apiKeyInput').value='" + SECRET + "';document.getElementById('profileNameInput').value='体检探针';return 1;})()");
  await ex("(function(){window.__answer=false;document.getElementById('btnSaveProfile').click();return 1;})()");
  await sleep(1200);
  const c4 = await ex("JSON.stringify({result:(document.getElementById('settingsResult')||{}).textContent||''})");
  const cfg4 = readConfig(), audit4 = readAudit();
  push('取消后 settingsResult 说明已取消', /已取消/.test(JSON.parse(c4).result), JSON.stringify(JSON.parse(c4).result));
  push('取消后 config 未变、无新审计行', (cfg4.baseUrl || '') === baseBefore && audit4 === auditBefore, 'baseUrl=' + String(cfg4.baseUrl) + ' 审计行数=' + audit4.split('\n').filter(Boolean).length);

  mark('5 确认后写入 + 审计不落 Key');
  await ex("(function(){window.__answer=true;document.getElementById('btnSaveProfile').click();return 1;})()");
  await sleep(1800);
  const c5 = await ex("JSON.stringify({result:(document.getElementById('settingsResult')||{}).textContent||''})");
  const audit5 = readAudit();
  const lines5 = audit5.split('\n').filter(Boolean);
  const last = lines5[lines5.length - 1] || '';
  push('确认后保存成功并回显目标主机', /已保存/.test(JSON.parse(c5).result) && /evil-collector\.example/.test(JSON.parse(c5).result), JSON.stringify(JSON.parse(c5).result));
  push('审计日志新增一行且含 from/to/host', /to=https:\/\/evil-collector\.example/.test(last) && /from=/.test(last) && /host=/.test(last), JSON.stringify(last));
  push('审计日志里没有任何密钥片段', audit5.indexOf(SECRET) < 0 && audit5.indexOf('sk-') < 0, 'SECRET命中=' + (audit5.indexOf(SECRET) >= 0) + ' sk-命中=' + (audit5.indexOf('sk-') >= 0));

  mark('6 切搜索方式不得顺带提交地址');
  const cfg5 = readConfig();
  await ex("(function(){document.getElementById('baseUrlInput').value='" + BAD2 + "';return 1;})()");
  const chip = await ex("(function(){var c=document.querySelector('#searchModeChoices .gen-choice');if(!c)return 'none';c.click();return (c.dataset.searchMode||'')+'|'+(c.textContent||'').trim().slice(0,8);})()");
  await sleep(1500);
  const cfg6 = readConfig();
  const audit6 = readAudit();
  push('搜索方式切换不改 baseUrl（旁路已堵）', (cfg6.baseUrl || '') === (cfg5.baseUrl || ''), '前=' + String(cfg5.baseUrl) + ' 后=' + String(cfg6.baseUrl) + ' chip=' + chip);
  push('切换也不产生新的地址审计行', audit6 === audit5, '行数 ' + audit5.split('\n').filter(Boolean).length + '->' + audit6.split('\n').filter(Boolean).length);

  mark('渲染进程报错检查');
  push('无渲染进程报错', renderErrors.length === 0, renderErrors.slice(0, 3).join(' | ') || 'clean');

  clearTimeout(hardKill);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ results: results }, null, 2), 'utf8');
  const fails = results.filter((r) => !r.pass);
  console.log('');
  console.log('F3 地址护栏：' + (results.length - fails.length) + '/' + results.length + ' 通过' + (fails.length ? '，失败 ' + fails.length : '，全部通过'));
  try { server.kill(); } catch (_) {}
  app.exit(fails.length ? 1 : 0);
}).catch((e) => {
  console.log('✗ 卡在[' + step + ']：' + e.message);
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ error: e.message, step: step }, null, 2), 'utf8'); } catch (_) {}
  app.exit(2);
});
