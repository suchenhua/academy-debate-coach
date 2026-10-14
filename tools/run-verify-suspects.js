#!/usr/bin/env node
/* 一键跑「巡检可疑项」定向复核：隔离数据目录 + 独立端口起服务，再用 electron.exe 真渲染。
 * 用法：node tools/run-verify-suspects.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = path.join(ROOT, '.build', 'verify-suspects-data');
const electronExe = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) { console.log('✗ 找不到 Electron：' + electronExe); process.exit(1); }

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const env = Object.assign({}, process.env, {
  ACADEMY_DATA_DIR: DATA,
  ACADEMY_NO_OPEN: '1',
  PATROL_PORT: PORT
});
delete env.ELECTRON_RUN_AS_NODE;

const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + PORT], { cwd: ROOT, env, stdio: 'ignore' });
const ping = () => new Promise((res) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: 800 }, (r) => { r.resume(); res(true); });
  req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
});
(async () => {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await ping()) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) { console.log('✗ 隔离服务起不来（端口 ' + PORT + '）'); try { server.kill(); } catch (_) {} process.exit(4); }
  const r = spawnSync(electronExe, [path.join(__dirname, 'verify-patrol-suspects.js'), ROOT], { cwd: ROOT, env, stdio: 'inherit', timeout: 300000 });
  if (r.error) console.log('✗ 执行失败: ' + r.error.message);
  try { server.kill(); } catch (_) {}
  console.log('退出码 ' + r.status);
  process.exit(r.status === 0 ? 0 : 1);
})();
