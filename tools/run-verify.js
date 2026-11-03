#!/usr/bin/env node
/* 起隔离数据目录的服务 → 跑指定 Electron 验证脚本 → 收尾。 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.VERIFY_PORT || 8796);
const TARGET = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-out.json');
const DATA = path.join(ROOT, '.build', 'verify-data-' + path.basename(TARGET, '.js'));

const log = (m) => console.log('[verify] ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pingOnce() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1500 }, (rs) => { rs.resume(); resolve(rs.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitServer(up) {
  for (let i = 0; i < 40; i++) { if (await pingOnce() === up) return true; await sleep(500); }
  return false;
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + PORT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1' }),
    stdio: 'ignore',
  });
  try {
    if (!(await waitServer(true))) { log('✗ 服务没起来'); process.exitCode = 1; return; }
    log('服务就绪 :' + PORT + '，数据目录 ' + DATA);
    const electronExe = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
    /* ELECTRON_RUN_AS_NODE 一旦残留，electron.exe 会退化成纯 Node，连 require('electron') 都拿不到。
       从别的工具链（或本次会话）继承来的这个变量必须显式删掉。 */
    const childEnv = Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, PATROL_PORT: String(PORT) });
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const rr = spawnSync(electronExe, [path.join(ROOT, 'tools', TARGET), ROOT, OUT], {
      cwd: ROOT,
      env: childEnv,
      stdio: 'inherit',
      timeout: 300000,
    });
    if (rr.error) { log('✗ Electron 失败: ' + rr.error.message); process.exitCode = 1; return; }
    process.exitCode = rr.status || 0;
  } finally {
    try { server.kill(); } catch (_) {}
    await waitServer(false);
    try { server.kill('SIGKILL'); } catch (_) {}
  }
})();
