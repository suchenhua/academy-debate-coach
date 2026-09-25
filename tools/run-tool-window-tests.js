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

/* 真实 spawn 出去的窗口是 detached 的，探测进程退出不代表它们关了。
   只按自己拿到的 PID 连树杀 —— 这台机器上还跑着别的 electron.exe，按镜像名杀会误伤。 */
const spawnedWindows = [];
function killPid(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

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

/* 扫应用端口区间，找出是否有**本副本**的 App 正在运行（同一个 instanceRoot）。
   有的话，「不带 --port」那条会正确地连到它 —— 那不是 bug，是断言写死了目标端口。
   返回那个端口号，没有则返回 0。 */
function getInstanceRoot() {
  try {
    /* 模块导出：{ instanceRoot(rootDir) -> 12位hex, SELF: 本副本的 12 位hex } */
    const idMod = require(path.join(ROOT, 'app', 'instance-id.js'));
    if (typeof idMod.SELF === 'string' && idMod.SELF) return idMod.SELF;
    if (typeof idMod === 'function') return idMod();
    if (typeof idMod.instanceRoot === 'function') return idMod.instanceRoot(ROOT);
  } catch (_) {}
  return null;
}
function probeStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/api/status', timeout: 900 }, (rs) => {
      let b = '';
      rs.on('data', (c) => { b += c; });
      rs.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function scanForLiveCopy() {
  const mine = getInstanceRoot();
  if (!mine) return 0;
  for (let p = 8787; p <= 8807; p++) {
    const j = await probeStatus(p);
    if (j && j.ok && j.instanceRoot && j.instanceRoot === mine) return p;
  }
  return 0;
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

    /* 第三轮：真的把壳 spawn 起来，核它能不能认出本副本的 server。
       第一轮用的是自带 mock IPC 的测试壳，摸不到 tool-window.js 里的 probeServer。
       不带 --port 那次尤其有用：本机 8790 上真站着一个非本 App 的服务，
       身份核验要是没生效，它就会连错过去。

       ⚠️ 已知前提：这一轮假设本机**没有**同副本的 App 正在运行。
       若子涵的桌面版开着（同一个 instanceRoot 的服务在 8787~8807 上应答），
       「不带 --port」那次会**正确地**认出那个服务并连过去 —— 行为是对的，
       但断言写死了「必须连到 PORT(8796)」，于是报 ❌。
       遇到这种失败先确认是不是这种情况，不要当成回归。 */
    let livePort = 0;
    if (process.env.TOOLTEST_ALLOW_LIVE_APP !== '1') livePort = await scanForLiveCopy();
    if (livePort) {
      log('⚠️ 本机已有同副本 App 在 ' + livePort + ' 端口运行。');
      log('   「不带 --port」那条会（正确地）连到它 —— 断言写死了必须连 ' + PORT + '，必然失败，本轮跳过该条。');
      log('   想连它一起测：关掉桌面版，或设 TOOLTEST_ALLOW_LIVE_APP=1。');
    }
    log('真实 spawn 工具窗，核端口识别');
    const lgPath = path.join(DATA, 'tool-research-launch.log');
    const spawnCases = [
      { label: '带 --port（主窗口 spawn 的实际路径）', args: ['--port=' + String(PORT)] },
      { label: '不带 --port（独立启动，靠扫 8787~8807 认身份）', args: [] },
    ].filter((c) => !(livePort && c.args.length === 0));
    for (const c of spawnCases) {
      try { fs.rmSync(lgPath, { force: true }); } catch (_) {}
      const el = spawn(electronExe, [path.join(ROOT, 'app', 'tool-window.js'), '--tool=research'].concat(c.args), {
        cwd: ROOT, env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA }), stdio: 'ignore',
      });
      spawnedWindows.push(el.pid);
      await sleep(7000);
      let txt = '';
      try { txt = fs.readFileSync(lgPath, 'utf8'); } catch (_) {}
      const connected = txt.indexOf('已连接，端口 ' + PORT) !== -1;
      log('  ' + (connected ? '✅' : '❌') + ' ' + c.label);
      if (!connected) { log('      启动日志：' + (txt.trim().split('\n').slice(-2).join(' / ') || '(没生成)')); process.exitCode = 1; }
      killPid(el.pid);
      await sleep(800);
    }
  } finally {
    log('收尾：关遗留窗口 + 关服务');
    for (const pid of spawnedWindows) killPid(pid);
    try { server.kill(); } catch (_) {}
    if (!(await waitServer(false))) {
      try { server.kill('SIGKILL'); } catch (_) {}
      await waitServer(false);
    }
    log('端口 ' + PORT + ' 已释放' + ((await pingOnce()) ? '（⚠️ 仍在被占用，手工确认）' : ''));
  }
}

main();
