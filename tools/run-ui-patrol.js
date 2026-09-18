#!/usr/bin/env node
/* UI 巡检一键跑批（Flash 线）。
 *
 * 为什么要有它：巡检必须用**隔离的数据目录**起服务（ACADEMY_DATA_DIR），
 * 再用 Electron 开真实窗口点按钮 —— 三段流程（起服务 → 跑巡检 → 收尾）
 * 手工做容易漏掉清理或用错端口/数据目录，把测试动作落在真实数据上。
 *
 * 用法：node tools/run-ui-patrol.js
 * 产物：.build/ui-patrol.json + <隔离数据目录>/patrol.log
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8795;
const OUT = path.join(ROOT, '.build', 'ui-patrol.json');
const DATA = path.join(ROOT, '.build', 'patrol-data');

function log(msg) { console.log('[巡检] ' + msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pingOnce() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1500 }, (rs) => {
      rs.resume();
      resolve(rs.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitServer(up) {
  for (let i = 0; i < 40; i++) {
    if (await pingOnce() === up) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  /* 隔离数据目录：每次巡检从空开始，绝不能指向真实 data/ */
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const serverJs = path.join(ROOT, 'app', 'server.js');
  log('起服务（隔离数据目录 ' + DATA + '，端口 ' + PORT + '）');
  const server = spawn(process.execPath, [serverJs, '--port=' + String(PORT)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      ACADEMY_DATA_DIR: DATA,
      ACADEMY_NO_OPEN: '1'
    }),
    stdio: 'ignore'
  });

  try {
    if (!(await waitServer(true))) {
      log('✗ 服务 20 秒内没起来，退出');
      process.exitCode = 1;
      return;
    }
    log('服务已就绪，启动 Electron 巡检（隐藏窗口，约 2-4 分钟）');

    const electronExe = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(electronExe)) {
      log('✗ 找不到 Electron：' + electronExe + '（先跑 runtime 安装脚本）');
      process.exitCode = 1;
      return;
    }
    const r = spawnSync(electronExe, [path.join(__dirname, 'ui-patrol.js'), ROOT, OUT], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, PATROL_PORT: String(PORT) }),
      stdio: 'ignore',
      timeout: 480000
    });
    if (r.error) { log('✗ Electron 执行失败: ' + r.error.message); process.exitCode = 1; return; }
    if (r.status !== 0) { log('✗ Electron 退出码 ' + r.status + '（看日志：' + path.join(DATA, 'patrol.log') + '）'); process.exitCode = 1; return; }

    /* 汇总 */
    const all = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    let total = 0, bad = 0, skipped = 0;
    const badList = [];
    for (const g of all) {
      for (const it of g.results || []) {
        if (it.verdict === '不可见') continue;
        total++;
        if (it.verdict === '跳过') { skipped++; continue; }
        if (it.verdict === '无反应' || it.verdict === '抛错') { bad++; badList.push(g.groupName + ' · ' + (it.id || it.text) + ' 「' + it.text + '」 -> ' + it.verdict + (it.why ? '：' + it.why : '')); }
      }
      if (g.error) { badList.push(g.groupName + ' · 组失败：' + g.error); bad++; }
    }
    log('巡检完成：可见元素 ' + total + '，跳过（副作用）' + skipped + '，可疑 ' + bad);
    if (badList.length) {
      log('---- 可疑清单 ----');
      for (const line of badList) log('  ' + line);
      log('完整结果：' + OUT);
      log('日志：' + path.join(DATA, 'patrol.log'));
    }
  } finally {
    log('收尾：关服务');
    try { server.kill(); } catch (_) {}
    await waitServer(false);
    try { server.kill('SIGKILL'); } catch (_) {}
  }
}

main().catch((e) => { log('ERR ' + e.stack); process.exitCode = 1; });
