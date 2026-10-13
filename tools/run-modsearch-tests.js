#!/usr/bin/env node
/* 增强检索（ModSearch）一键跑批：引擎级回归 + 设置卡真渲染回归。
 *
 * 和 run-ui-patrol.js / run-tool-window-tests.js 同一个理由：
 * 真渲染必须用**隔离数据目录**起服务，跑完一定要把服务关掉（09-19 那次漏杀把用户快捷方式带偏了）。
 * 端口固定 8797，在应用/启动器区间（8787~8792）之外。
 *
 * 用法：node tools/run-modsearch-tests.js [--skip-ui] [--ui-only]
 *   --skip-ui  只跑引擎级（不起 Electron，快）
 *   --ui-only 只跑真渲染（engine-real 每次要烧 2 credits，调界面时不需要）
 * 产物：.build/verify-modsearch-ui.json
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PATROL_PORT || 8797);
const DATA = path.join(ROOT, '.build', 'modsearch-patrol-data');
const OUT = path.join(ROOT, '.build', 'verify-modsearch-ui.json');
const SKIP_UI = process.argv.slice(2).includes('--skip-ui');
const UI_ONLY = process.argv.slice(2).includes('--ui-only');   // 只跑真渲染：engine-real 每次会烧 2 credits，迭代界面时不需要它

const log = (m) => console.log('[增强检索] ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pingOnce() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1500 }, (rs) => {
      rs.resume(); resolve(rs.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitServer(up) {
  for (let i = 0; i < 40; i++) { if ((await pingOnce()) === up) return true; await sleep(500); }
  return false;
}
/* 只按拿到的 PID 连树杀：这台机器上还跑着别的 electron.exe，按镜像名杀会误伤 */
function killPid(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}

async function main() {
  let code = 0;
  let server = null;
  try {
    // 1) 引擎级（自带隔离目录与子进程编排）—— --ui-only 时整段跳过，别白烧免注册额度
    if (UI_ONLY) {
      log('① 已按 --ui-only 跳过引擎级（不烧免注册额度）');
    } else {
      log('① 引擎级回归（含一次真实搜索，消耗免注册额度约 2 credits）');
      const eng = spawnSync(process.execPath, [path.join(__dirname, 'verify-modsearch.js'), '--suite'], {
        cwd: ROOT, encoding: 'utf8', timeout: 300000,
      });
      process.stdout.write(String(eng.stdout || ''));
      if (String(eng.stderr || '').trim()) process.stdout.write('[stderr] ' + String(eng.stderr).slice(-500) + '\n');
      if (eng.status !== 0) { log('✗ 引擎级回归未通过（exit=' + eng.status + '）'); code = 1; }
    }

    if (SKIP_UI) { log('已按 --skip-ui 跳过真渲染'); return; }

    // 2) 设置卡真渲染
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    /* 真渲染这一段用**替身 CLI**，不打真上游：
       · 「试搜一次」的成功回显是拼出来的 DOM（条数/用时/引擎/credits/样例），之前只验过失败那一支；
       · 让它每次都真发请求，等于每次回归都烧免注册额度，还受上游 IP 限流摆布（红了分不清是坏了还是被限流）。
       真实上游那条路归引擎级的 engine-real 用例负责。替身必须与「辩论」相关——
       不相关的替身会让相关性打分拦下，那就成了测失败分支。 */
    const UI_STUB = path.join(ROOT, '.build', 'modsearch-ui-stub.js');
    fs.writeFileSync(UI_STUB,
      "console.log(JSON.stringify({mode:'search',results:[{source:'web',engine:'ui-stub',status:'ok',warnings:[]," +
      "attempts:[{engine:'ui-stub',ok:true,durationSeconds:0.2,credits:2}],items:[" +
      "{title:'辩论赛的基本流程（界面替身样例）',url:'https://example.test/a',snippet:'正方反方交替发言',published_at:''}," +
      "{title:'华语辩论的常见赛制（界面替身样例）',url:'https://example.test/b',snippet:'奥瑞冈与新加坡制',published_at:''}," +
      "{title:'Debate formats primer (stub sample)',url:'https://example.test/c',snippet:'Parliamentary and Asian styles',published_at:''}" +
      "]}]}));\n");
    log('② 起隔离服务（' + DATA + '，端口 ' + PORT + '，增强检索走界面替身）');
    server = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + String(PORT)], {
      cwd: ROOT, env: Object.assign({}, process.env, {
        ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1', ACADEMY_MODSEARCH_CLI: UI_STUB,
      }), stdio: 'ignore',
    });
    if (!(await waitServer(true))) { log('✗ 服务 20 秒内没起来'); code = 1; return; }
    const electronExe = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(electronExe)) { log('✗ 找不到 Electron：' + electronExe); code = 1; return; }
    log('③ Electron 真渲染验证设置卡');
    /* ★ 必须清掉 ELECTRON_RUN_AS_NODE：从别的 Electron 宿主（含本仓库的自动化环境）里继承下来时，
       electron.exe 会退化成纯 Node，require('electron') 直接 MODULE_NOT_FOUND ——
       看着像脚本坏了，其实是环境把 Electron 变成了 node。（首次跑就撞上这个） */
    const env = Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, PATROL_PORT: String(PORT) });
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electronExe, [path.join(__dirname, 'verify-modsearch-ui.js'), ROOT, OUT], {
      cwd: ROOT, env, stdio: 'inherit', timeout: 300000,
    });
    if (r.error) { log('✗ Electron 执行失败：' + r.error.message); code = 1; }
    else if (r.status !== 0) { log('✗ 真渲染未通过（exit=' + r.status + '，明细见 ' + OUT + '）'); code = 1; }
    else log('✓ 真渲染通过');
  } finally {
    if (server) { killPid(server.pid); await waitServer(false); log('隔离服务已收尾'); }
  }
  process.exit(code);
}

main().catch((e) => { console.error('[增强检索] 跑批异常：', e); process.exit(1); });
