#!/usr/bin/env node
/* 端口撞车回归测试（Flash 线）。
 *
 * 盯的是同一个症状的三种触发者：用户（或子涵自己）双击桌面图标后「卡 45 秒然后什么都没出现」，
 * 或者「点 Flash 打开的却是 Pro 的界面」。根因都在「主进程只盯自己请求的那个端口，
 * 而 server.js 撞到占用会自己 +1 挪走」+「只看端口上有没有服务就复用」。
 *
 * 修法要求主进程按 /api/status 里的 instanceRoot 认「这是不是我这份」，并扫描一段端口。
 * 这段决策只有真跑 electron-main 才测得出来，所以这里真的起三次主进程，
 * 看它的启动日志走了哪条分支、最后落在哪个端口上。
 *
 * 四种场景（请求端口统一用 8793，避开 8787~8792 的应用区间 —— 见开发日志 09-19 事故复盘）：
 *   D 端口空闲                                        → 正常自启并落在请求端口（绝大多数用户走这条）
 *   A 端口被非本 App 的服务占（对 /api/status 答 404）→ 应换端口自启并找得回来
 *   B 端口被另一份副本占（答 200 但 instanceRoot 不同）→ 应判为「别人的副本」跳过
 *   C 本副本已有 server 在跑                          → 应直接复用，不再起第二个
 *
 * 用法：node tools/verify-port-fallback.js
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const REQ_PORT = Number(process.env.PORTFALLBACK_PORT || 8793);
const DATA = path.join(ROOT, '.build', 'portfallback-data');
const LOG = path.join(ROOT, 'data', 'electron-launch.log');   // 主进程日志写在这里（不是用户数据）
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const ELECTRON = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logOffset() { try { return fs.statSync(LOG).size; } catch (_) { return 0; } }
function newLog(from) {
  try {
    const buf = Buffer.alloc(fs.statSync(LOG).size - from);
    const fd = fs.openSync(LOG, 'r');
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}
function statusOn(port, ms) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: ms || 600 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
/* electron-main 起的 server 是它的子进程，taskkill /T 连树一起收；
   只按自己 spawn 到的 PID 杀 —— 这台机器上还有别的 electron.exe，按镜像名杀会连别人的干掉。 */
function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

/* 起一个假邻居占住 port：mode='foreign404' 模拟任意本地 HTTP 服务，
   mode='otherCopy' 模拟另一份 Academy 副本（有 version，指纹不同） */
function startDecoy(port, mode) {
  const srv = http.createServer((req, res) => {
    if (mode === 'otherCopy') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, version: '9.9.9', edition: 'pro', instanceRoot: 'deadbeef0000' }));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 未找到: ' + req.url);
  });
  srv.listen(port, '127.0.0.1');
  return srv;
}

async function runMainCase(name, expectNeedles, opts) {
  const decoy = opts.decoy ? startDecoy(REQ_PORT, opts.decoy) : null;
  if (decoy) await new Promise((r) => decoy.once('listening', r));
  const from = logOffset();
  const child = spawn(ELECTRON, [path.join(ROOT, 'app', 'electron-main.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ACADEMY_PORT: String(REQ_PORT), ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1' }),
    stdio: 'ignore',
  });
  const out = [];
  try {
    let tail = '';
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      tail = newLog(from);
      if (expectNeedles.every((n) => tail.indexOf(n) !== -1)) break;
    }
    const hit = expectNeedles.filter((n) => tail.indexOf(n) !== -1);
    out.push({ case: name + ' · 日志分支', pass: hit.length === expectNeedles.length, got: '命中 ' + hit.length + '/' + expectNeedles.length + '：' + expectNeedles.map((n) => (tail.indexOf(n) !== -1 ? '✓' : '✗') + n).join(' | ') + (hit.length === expectNeedles.length ? '' : '\n---- 实际日志 ----\n' + tail.split('\n').slice(0, 12).join('\n')) });

    /* 最终连上的端口必须真在应答，而且应答的是本副本 —— 日志说就绪不算数 */
    let usedPort = 0;
    const pm = tail.match(/server 就绪（端口 (\d{4,5})/g);
    const rm = tail.match(/server 已在 (\d{4,5}) 运行/g);
    const last = (pm || []).concat(rm || []).pop() || '';
    usedPort = Number((last.match(/\d{4,5}/) || ['0'])[0]);
    const st = usedPort ? await statusOn(usedPort, 1500) : null;
    let own = false;
    try { own = !!st && JSON.parse(st.body).instanceRoot === require(path.join(ROOT, 'app', 'instance-id.js')).SELF; } catch (_) {}
    out.push({ case: name + ' · 实际端口在应答且指纹是自己的', pass: own, got: 'port=' + usedPort + ' status=' + (st ? st.status : '(无应答)') });

    /* 工具窗拿到的 --port 也必须是这个实际端口（主窗口 spawn 时带的就是它） */
    out.push({ case: name + ' · 端口 ≠ 被占的请求端口', pass: !usedPort || usedPort !== REQ_PORT || opts.expectReuseReq === true, got: 'used=' + usedPort + ' req=' + REQ_PORT });
  } finally {
    killTree(child.pid);
    if (decoy) decoy.close();
    await sleep(800);
  }
  return out;
}

async function main() {
  if (!fs.existsSync(ELECTRON) || !fs.existsSync(NODE)) {
    console.log('✗ 缺 runtime（electron / node），先跑 tools/setup-runtime.js');
    process.exitCode = 1;
    return;
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const all = [];

  /* D 放在最前：端口干干净净是绝大多数用户的实际路径，一旦弄坏就是「谁都起不来」，
     比撞车场景更致命，所以先钉它。 */
  console.log('D · 端口空闲（绝大多数用户的正常路径）');
  all.push(...await runMainCase('D 端口空闲正常启动', [
    '启动隐藏 server（端口 ' + REQ_PORT + ' 起）',
    'server 就绪（端口 ' + REQ_PORT + '）',
  ], { expectReuseReq: true }));

  console.log('A · 端口被非本 App 的服务占用');
  all.push(...await runMainCase('A 外部服务占端口', [
    '启动隐藏 server（端口 ' + REQ_PORT + ' 起）',
    'server 就绪（端口 ',
  ], { decoy: 'foreign404' }));

  console.log('B · 端口被另一份副本占用');
  all.push(...await runMainCase('B 别的副本占端口', [
    '被其它副本占用，改用 ',
    'server 就绪（端口 ',
  ], { decoy: 'otherCopy' }));

  console.log('C · 本副本的 server 已在跑（应复用，不再起第二个）');
  const own = spawn(NODE, [path.join(ROOT, 'app', 'server.js'), '--port=' + REQ_PORT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1' }),
    stdio: 'ignore',
  });
  let up = null;
  for (let i = 0; i < 60; i++) { up = await statusOn(REQ_PORT, 800); if (up && up.status === 200) break; await sleep(500); }
  if (!up || up.status !== 200) {
    all.push({ case: 'C 前置：本副本 server 起在 ' + REQ_PORT, pass: false, got: '(没起来)' });
    killTree(own.pid);
  } else {
    all.push(...await runMainCase('C 复用本副本', ['检测到本副本的 server 已在 ' + REQ_PORT + ' 运行，直接复用'], { expectReuseReq: true }));
    killTree(own.pid);
  }

  const fails = all.filter((r) => !r.pass);
  console.log('端口撞车回归：' + (all.length - fails.length) + '/' + all.length + ' 通过');
  for (const r of all) console.log((r.pass ? '  ✅ ' : '  ❌ ') + r.case + (r.pass ? '' : '\n      got=' + String(r.got).replace(/\n/g, '\n      ')));
  /* 收尾核对：测试请求端口区间必须全部释放，不给用户留挂着的进程 */
  const leak = [];
  for (let p = REQ_PORT; p <= REQ_PORT + 2; p++) { const s = await statusOn(p, 300); if (s) leak.push(p); }
  console.log(leak.length ? '  ⚠️ 端口仍被占：' + leak.join(',') : '  端口 ' + REQ_PORT + '~' + (REQ_PORT + 2) + ' 已释放');
  if (leak.length || fails.length) process.exitCode = 1;
}

main().catch((e) => { console.log('ERR ' + e.stack); process.exitCode = 1; });
