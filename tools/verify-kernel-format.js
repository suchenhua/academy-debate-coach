#!/usr/bin/env node
/* 内核格式契约检查 —— 换内核前后都该跑一次。
 *
 * 为什么需要：App 有一处**依赖内核内部格式**的地方 —— 它 tail 内核写在
 * data/.dsh/sessions 里那些 session*.jsonl 运行日志，用来取
 *   ① 逐字流式正文 / 推理片段 ② **token 用量**（账本、统计面板、上下文占比）
 * 这条契约历史上已经变过一次：0.1.1 的 rec.type='assistant/chunk' → 0.1.5 挪进了
 * assistant/message 的 data.stream[]（见 server.js 的 usageChunksFromRecord）。
 * 它变了不会报错，只会**静默**地让统计空掉 —— 所以必须有东西盯着。
 *
 * 两种模式：
 *   node tools/verify-kernel-format.js          离线：直接跑内核（假 Key），只验证结构
 *   node tools/verify-kernel-format.js --live    走 App 真实链路跑一条最小对话，验证用量确实能提取
 *
 * 离线模式能抓住「会话文件不再叫 *.jsonl / 不再写在预期位置 / App 依赖的
 * data.stream[] 信封消失」这三类会让解析整体失效的变化（不需要 Key、不花钱）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

if (process.platform === 'win32') {
  try { spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
}

const ROOT = path.join(__dirname, '..');
const LIVE = process.argv.includes('--live');
const PROBE_ROOT = path.join(ROOT, '.build', 'kernel-format');
const DATA = path.join(PROBE_ROOT, 'data');
const PORT = 18957;
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmr = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' · ' + detail : ''));
}

/* 与 server.js 的 usageChunksFromRecord 同一套规则 */
function usageChunksFromRecord(rec) {
  const out = [];
  if (rec.type === 'assistant/chunk' && rec.data && rec.data.chunk && rec.data.chunk.type === 'usage' && rec.data.chunk.usage) {
    out.push(rec.data.chunk.usage);
  } else if (rec.type === 'assistant/message' && Array.isArray(rec.data && rec.data.stream)) {
    for (const item of rec.data.stream) {
      const c = item ? (item.chunk || item) : null;
      if (c && c.type === 'usage' && c.usage) out.push(c.usage);
    }
  }
  return out;
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + PORT], {
    env: Object.assign({}, process.env, { ACADEMY_NO_OPEN: '1', ACADEMY_DATA_DIR: DATA }),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const ctx = { child, log: '' };
  child.stdout.on('data', (d) => { ctx.log += d; });
  child.stderr.on('data', (d) => { ctx.log += d; });
  return ctx;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/config'); if (r.ok) return true; } catch (_) {} await sleep(500); }
  return false;
}
async function stop(ctx) {
  try { ctx.child.kill(); } catch (_) {}
  for (let i = 0; i < 20; i++) { if (ctx.child.exitCode !== null) break; await sleep(200); }
  try { spawnSync('taskkill', ['/PID', String(ctx.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  await sleep(400);
}

(async () => {
  console.log('== 内核格式契约检查（' + (LIVE ? '真实链路' : '离线结构') + '）==');
  rmr(PROBE_ROOT);
  fs.mkdirSync(DATA, { recursive: true });

  /* 0) 静态：App 侧两套格式分支与金丝雀都还在 */
  const serverSrc = fs.readFileSync(path.join(ROOT, 'app', 'server.js'), 'utf8');
  check('App 侧保留两代 session 格式的解析分支（assistant/chunk + assistant/message）',
    serverSrc.includes("rec.type === 'assistant/chunk'") && serverSrc.includes("rec.type === 'assistant/message'")
    && serverSrc.includes("endsWith('.jsonl')"));
  check('App 侧有用量提取金丝雀（跑成功却取不到用量会被记下）',
    serverSrc.includes('usageExtractState') && serverSrc.includes('usageExtract:'));

  let usageState = null;

  if (LIVE) {
    /* ---- 真实链路：真 Key 必须在起服务之前就位（服务启动时读一次配置）---- */
    for (const f of ['config.json', 'profiles.json']) {
      const src = path.join(ROOT, 'data', f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA, f));
    }
    const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch (_) { return {}; } })();
    if (!cfg.apiKey) { console.error('❌ --live 需要 data/config.json 里有可用 Key'); process.exit(1); }
    console.log('（已复制真实配置，内容不打印；本次会真实调用一次模型，成本约几分钱）');

    const ctx = startServer();
    if (!await waitUp()) { console.error('❌ 隔离服务未就绪\n' + ctx.log.slice(-1500)); process.exit(1); }
    await sleep(1500);
    console.log('\n--- 走 App 链路跑一条最小对话 ---');
    const res = await fetch(BASE + '/api/chat/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'free', text: '回复：好的', history: [] }),
    });
    const body = await res.text();
    console.log('HTTP ' + res.status + '　响应 ' + body.length + 'B');
    await sleep(1500);
    const st = await (await fetch(BASE + '/api/status')).json().catch(() => ({}));
    usageState = st && st.usageExtract;
    console.log('[server] ' + ctx.log.split(/\r?\n/).filter((l) => /usage|upgrade/.test(l)).join(' | ').slice(0, 500));
    await stop(ctx);
  } else {
    /* ---- 离线：先起一次服务 materialize 出 patch 与 settings，再直接跑内核（假 Key）---- */
    const ctx = startServer();
    if (!await waitUp()) { console.error('❌ 隔离服务未就绪\n' + ctx.log.slice(-1500)); process.exit(1); }
    await sleep(1500);
    await stop(ctx);

    const patch = path.join(DATA, 'persona.patch.yml');
    check('补丁文件已 materialize（内核能加载我们的插件链）', fs.existsSync(patch));
    const node = fs.existsSync(path.join(ROOT, 'runtime', 'node', 'node.exe'))
      ? path.join(ROOT, 'runtime', 'node', 'node.exe') : process.execPath;
    const bin = path.join(ROOT, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const env = Object.assign({}, process.env, {
      DSH_HOME: path.join(DATA, '.dsh'),
      DEEPSEEK_API_KEY: 'sk-format-probe-0000',   // 19 位，避开合规扫描的「sk- + 20 位」
      ACADEMY_NO_OPEN: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      ACADEMY_WRITE_ROOT: path.join(DATA, 'deliverables'),
    });
    console.log('\n--- 直接跑内核（假 Key，预期在模型调用处失败 —— 够它写出 session 日志）---');
    const r = spawnSync(node, [bin, '--profile', 'headless', '--patch', patch, '回复：好的'],
      { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 90000 });
    const errLine = String(r.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    console.log('内核 exit=' + r.status + '　末行 stderr: ' + errLine.slice(0, 160));
    check('内核失败点停在「模型调用」（说明补丁/插件链加载没问题）',
      /AUTH|api key|Authentication|invalid/i.test(errLine) || r.status !== 0,
      errLine.slice(0, 120));
  }

  /* ---- 公共：检查 session 日志结构 ---- */
  const sess = path.join(DATA, '.dsh', 'sessions');
  const files = [];
  const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } } catch (_) {} };
  walk(sess);
  const jsonl = files.filter((f) => f.endsWith('.jsonl'));
  check('内核会话日志仍写在 data/.dsh/sessions 下、且仍是 *.jsonl',
    jsonl.length > 0, files.length + ' 个文件，其中 .jsonl ' + jsonl.length + ' 个');

  let types = {};
  let hasStreamEnvelope = false;
  let parseErrors = 0;
  let usageHits = 0;
  for (const f of jsonl) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let o = null;
      try { o = JSON.parse(line); } catch (_) { parseErrors++; continue; }
      if (o && typeof o.type === 'string') types[o.type] = (types[o.type] || 0) + 1;
      if (o && typeof o.type === 'string' && o.type.indexOf('assistant/') === 0 && Array.isArray(o.data && o.data.stream)) hasStreamEnvelope = true;
      if (o && usageChunksFromRecord(o).length) usageHits++;
    }
  }
  check('会话记录仍是可解析的 JSONL 且带 type 字段', jsonl.length > 0 && parseErrors === 0,
    '解析失败 ' + parseErrors + ' 行　类型：' + JSON.stringify(types));
  check('App 依赖的 data.stream[] 信封仍在（0.1.5+ 格式）', hasStreamEnvelope,
    hasStreamEnvelope ? '' : '没找到 assistant/* 且 data.stream 为数组的记录');

  if (LIVE) {
    check('★ 真实调用后 App 取到了 token 用量（金丝雀 ok=true）', !!(usageState && usageState.ok === true),
      JSON.stringify(usageState));
    check('★ session 日志里确实有带 usage 的记录（App 解析规则命中）', usageHits > 0, '命中 ' + usageHits + ' 条');
  } else {
    console.log('  ℹ️ 离线不校验用量数值（没有真实调用）。发版前请再跑一次：node tools/verify-kernel-format.js --live');
  }

  const fails = results.filter((r) => !r.ok);
  console.log('\n内核格式契约检查：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  if (fails.length) { console.log('演练目录已保留：' + DATA); process.exit(1); }
  rmr(PROBE_ROOT);
  process.exit(0);
})().catch((e) => { console.error('ERR ' + (e && e.stack || e)); process.exit(1); });
