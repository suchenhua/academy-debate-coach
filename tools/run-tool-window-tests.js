#!/usr/bin/env node
/* 独立工具窗实跑验证一键跑批（研究台 / 证据检证 / 资料溯源）。
 *
 * 和 run-ui-patrol.js 同一个理由：必须用隔离数据目录起服务，跑完一定要把服务关掉。
 * 09-19 那次就是手工起的隔离测试服务漏杀，挂在 8790 上把用户的桌面快捷方式带偏了
 *（详见开发日志「测试服务残留占用 8790」事故复盘）。所以这里 try/finally 强制收尾，
 * 端口也固定在应用区间之外（8796）。
 *
 * 用法：node tools/run-tool-window-tests.js
 * 产物：.build/verify-tool-windows.json
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TOOLTEST_PORT || 8796); // 8787~8792 是应用/启动器端口，测试绝不占用
const DATA = path.join(ROOT, '.build', 'tooltest-data');
const OUT = path.join(ROOT, '.build', 'verify-tool-windows.json');

const log = (m) => console.log('[工具窗验证] ' + m);
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
    if ((await pingOnce()) === up) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (await pingOnce()) {
    log('✗ 端口 ' + PORT + ' 上已经有服务在跑，先查清是谁占着（不要再叠一个测试服务）');
    process.exitCode = 1;
    return;
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  log('起服务（隔离数据目录 ' + DATA + '，端口 ' + PORT + '）');
  const server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + String(PORT)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1' }),
    stdio: 'ignore',
  });

  try {
    if (!(await waitServer(true))) { log('✗ 服务 20 秒内没起来'); process.exitCode = 1; return; }

    const electronExe = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(electronExe)) { log('✗ 找不到 Electron：' + electronExe); process.exitCode = 1; return; }

    log('服务就绪，用 Electron 加载三个真实渲染层（约 1 分钟）');
    const r = spawnSync(electronExe, [path.join(__dirname, 'verify-tool-windows.js'), ROOT, OUT], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { TOOLTEST_PORT: String(PORT) }),
      stdio: 'inherit',
      timeout: 300000,
    });
    if (r.error) { log('✗ Electron 执行失败: ' + r.error.message); process.exitCode = 1; return; }
    if (r.status !== 0) { log('✗ Electron 退出码 ' + r.status); process.exitCode = 1; return; }
    log('完整结果：' + OUT);

    /* 第二轮：工具箱按钮 → preload 桥 → IPC 载荷（巡检窗没挂 preload，够不到这条链） */
    log('探测工具箱入口链（带真实 preload 加载主页）');
    const r2 = spawnSync(electronExe, [path.join(__dirname, 'verify-tool-open-ipc.js'), ROOT, String(PORT)], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, TOOLTEST_PORT: String(PORT) }),
      stdio: 'inherit',
      timeout: 180000,
    });
    if (r2.error || r2.status !== 0) {
      log('✗ 工具箱入口链探测失败 ' + (r2.error ? r2.error.message : '退出码 ' + r2.status));
      process.exitCode = 1;
    }
  } finally {
    log('收尾：关服务');
    try { server.kill(); } catch (_) {}
    if (!(await waitServer(false))) {
      try { server.kill('SIGKILL'); } catch (_) {}
      await waitServer(false);
    }
    log('端口 ' + PORT + ' 已释放' + ((await pingOnce()) ? '（⚠️ 仍在被占用，手工确认）' : ''));
  }
}

main();
