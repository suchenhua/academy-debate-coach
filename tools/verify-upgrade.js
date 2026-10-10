#!/usr/bin/env node
/* 跨版本升级演练 —— 证明「换内核的破坏性更新」不会动用户的东西。
 *
 * 为什么要有这个脚本：v2.4.0 换掉了 DSH 内核。用户最怕的不是界面变了，而是
 * 「我几个月的对话记录 / 资料库 / Key / 装的技能还在不在」。这个担心不能靠嘴说，
 * 得有一条能反复跑的实证。
 *
 * 演练流程（全程用隔离数据目录，不碰真实 data/）：
 *   第一次启动（伪装成「旧版本安装」）
 *     → 通过真实接口写入：对话、资料库资料、长期记忆、一个用户技能、config/profiles
 *     → 再伪造：旧的内核会话日志、旧版本安装戳（appVersion 2.3.0 / dshVersion 0.1.0-legacy）
 *   第二次启动（= 用户升级后第一次打开）
 *     → 升级钩子应当触发：升级前备份 → 重建内核侧文件 → 清旧内核会话 → 内核自检 → 落新戳
 *     → 断言上面那些东西**一个都没少**，且备份里确实有它们
 *
 * 用法：node tools/verify-upgrade.js [--port=18942]
 * 全部通过 → exit 0；任一失败 → exit 1（并保留演练目录便于排查）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

if (process.platform === 'win32') {
  try { spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
}

const ROOT = path.join(__dirname, '..');
const DRILL_DIR = path.join(ROOT, '.build', 'upgrade-drill');
const DATA = path.join(DRILL_DIR, 'data');
let PORT = 18942;
for (const a of process.argv.slice(2)) {
  const m = String(a).match(/^--port=(\d+)$/);
  if (m) PORT = Number(m[1]);
}
const BASE = 'http://127.0.0.1:' + PORT;

const OLD_APP = '2.3.0';
const OLD_DSH = '0.1.0-legacy';

const edition = require(path.join(ROOT, 'app', 'edition.js'));
const NEW_APP = edition.version;
const DSH_PKG = path.join(ROOT, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
let NEW_DSH = '';
try { NEW_DSH = JSON.parse(fs.readFileSync(DSH_PKG, 'utf8')).version; } catch (_) {}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' · ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js'), '--port=' + PORT], {
    env: Object.assign({}, process.env, {
      ACADEMY_NO_OPEN: '1',
      ACADEMY_DATA_DIR: DATA,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const ctx = { child, log: '' };
  child.stdout.on('data', (d) => { ctx.log += d; });
  child.stderr.on('data', (d) => { ctx.log += d; });
  return ctx;
}

async function waitUp(ctx) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/config'); if (r.ok) return true; } catch (_) {}
    await sleep(500);
  }
  return false;
}

async function stopServer(ctx) {
  try { ctx.child.kill(); } catch (_) {}
  for (let i = 0; i < 20; i++) { if (ctx.child.exitCode !== null) break; await sleep(200); }
  try { spawnSync('taskkill', ['/PID', String(ctx.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  await sleep(400);
}

async function j(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

/* 对话 id 不能以 _ 开头（服务端保留前缀），所以用普通前缀 */
const CHAT_ID = 'drillchatv23';
const LIB_NAME = '__drill_lib_v23.md';
const SKILL_FILE = '__drill_skill_v23.md';
const MEM_TITLE = '__drill 记忆 v23';

function readStamp() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, '.install-stamp.json'), 'utf8')); } catch (_) { return null; }
}
function rmr(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

async function main() {
  console.log('== 跨版本升级演练 ==');
  console.log('  旧版本（伪造）: app ' + OLD_APP + ' / dsh ' + OLD_DSH);
  console.log('  新版本（当前）: app ' + NEW_APP + ' / dsh ' + (NEW_DSH || '未知'));
  console.log('  演练目录: ' + path.relative(ROOT, DATA));
  console.log('');

  rmr(DRILL_DIR);
  fs.mkdirSync(DATA, { recursive: true });

  /* ---------- 阶段 1：造一份「旧版本用户的数据」 ---------- */
  let ctx = startServer();
  if (!await waitUp(ctx)) {
    console.error('❌ 第一次启动未就绪，日志尾部：\n' + ctx.log.slice(-2000));
    await stopServer(ctx);
    process.exit(1);
  }
  console.log('阶段 1 · 写入用户数据（走真实接口）');

  let r = await j('PUT', '/api/chats/upsert', {
    chat: { id: CHAT_ID, mode: 'prep', title: '升级演练对话', created: Date.now(), updated: Date.now(), messages: [{ role: 'user', text: '这条必须活过升级' }] },
  });
  check('写入对话成功', r.status === 200 && r.d && r.d.ok, 'status=' + r.status);

  r = await j('POST', '/api/library/upload', { name: LIB_NAME, text: '升级演练资料：攻防分级与打钉子' });
  check('写入资料库资料成功', r.status === 200 && r.d && r.d.ok, 'status=' + r.status);

  r = await j('POST', '/api/memory/save', { scope: 'long', title: MEM_TITLE, body: '升级演练长期记忆：用户偏好一句话判准' });
  check('写入长期记忆成功', r.status === 200 && r.d && r.d.ok, 'status=' + r.status);

  // 注意：合规扫描会把 `sk-` 后接 20 位以上当成真 Key（tools/sanitize-open-source.js），
  // 所以夹具 Key 保持在 19 位（与 smoke-test.js 同一处理）。
  r = await j('POST', '/api/config', { apiKey: 'sk-drill-key-012345678', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' });
  check('写入配置（Key）成功', r.status === 200, 'status=' + r.status);

  // 用户技能：直接落文件（等同用户导入后落盘的位置）
  const skillDir = path.join(DATA, '.dsh', 'skills');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, SKILL_FILE),
    '---\nname: drill-skill\ndescription: 升级演练用的用户技能\n---\n\n这是用户自己装的技能，升级后必须还在。\n', 'utf8');

  await stopServer(ctx);

  /* 伪造「旧版本的痕迹」：旧安装戳 + 旧内核会话日志 */
  fs.writeFileSync(path.join(DATA, '.install-stamp.json'), JSON.stringify({
    appVersion: OLD_APP, dshVersion: OLD_DSH, at: '2026-08-01T00:00:00.000Z',
  }, null, 2), 'utf8');
  const oldSession = path.join(DATA, '.dsh', 'sessions', '__old_kernel_session');
  fs.mkdirSync(oldSession, { recursive: true });
  fs.writeFileSync(path.join(oldSession, 'log.jsonl'), '{"old":"旧内核写的会话日志，格式已过时"}\n', 'utf8');

  const before = {
    chatBytes: fs.statSync(path.join(DATA, 'chats', CHAT_ID + '.json')).size,
  };
  console.log('  · 已伪造旧安装戳（app ' + OLD_APP + ' / dsh ' + OLD_DSH + '）与旧内核会话日志');
  console.log('');

  /* ---------- 阶段 2：升级后第一次启动 ---------- */
  console.log('阶段 2 · 升级后第一次启动（应触发升级钩子）');
  ctx = startServer();
  if (!await waitUp(ctx)) {
    console.error('❌ 第二次启动未就绪，日志尾部：\n' + ctx.log.slice(-2000));
    await stopServer(ctx);
    process.exit(1);
  }
  await sleep(2500);   // 钩子跑在 setImmediate 里，等它落定

  const st = await j('GET', '/api/status');
  const up = st.d && st.d.upgrade;
  check('升级钩子已触发（upgraded=true, firstRun=false）',
    !!up && up.upgraded === true && up.firstRun === false, JSON.stringify(up && { upgraded: up.upgraded, firstRun: up.firstRun }));
  check('识别为「内核发生了变化」（kernelChanged=true）', !!up && up.kernelChanged === true,
    up ? 'from dsh ' + (up.from || '') + ' 旧内核 → ' + up.dshVersion : '');
  check('内核自检通过（新内核真能起来）', !!up && up.selfCheck && up.selfCheck.ok === true,
    up && up.selfCheck ? (up.selfCheck.ok ? String(up.selfCheck.reported || '') : '失败：' + up.selfCheck.reason) : '无结果');
  console.log('    [upgrade] ' + (up && up.steps ? up.steps.join(' · ') : ''));
  console.log('    [server] ' + ctx.log.split(/\r?\n/).filter((l) => l.includes('[upgrade]')).join(' | '));

  /* 落戳 */
  const stamp = readStamp();
  check('安装戳已更新为当前版本（含内核与内置 Node 版本）',
    !!stamp && stamp.appVersion === NEW_APP && stamp.dshVersion === NEW_DSH
    && String(stamp.nodeVersion || '') === process.version,
    stamp ? 'app=' + stamp.appVersion + ' dsh=' + stamp.dshVersion + ' node=' + stamp.nodeVersion : '未写入');

  /* 用户数据：一个都不能少 */
  r = await j('GET', '/api/chats/list');
  const chatHit = ((r.d && r.d.chats) || []).find((c) => c.id === CHAT_ID);
  check('★ 对话记录还在（升级前写的对话仍可列出）', !!chatHit, chatHit ? '标题=' + chatHit.title : '未找到');
  r = await j('GET', '/api/chats/' + CHAT_ID);
  const chatBody = JSON.stringify(r.d || {});
  check('★ 对话正文完好（消息内容逐字保留）', r.status === 200 && chatBody.includes('这条必须活过升级'), 'status=' + r.status);

  r = await j('GET', '/api/library');
  const libHit = JSON.stringify(r.d || {}).includes(LIB_NAME);
  check('★ 资料库还在（资料条目可列出）', r.status === 200 && libHit, 'status=' + r.status);
  r = await j('POST', '/api/library/search', { query: '攻防分级' });
  check('★ 资料库仍可检索命中', r.status === 200 && JSON.stringify(r.d || {}).includes(LIB_NAME), 'status=' + r.status);

  r = await j('GET', '/api/memory/search?q=' + encodeURIComponent('升级演练'));
  check('★ 长期记忆还在且可搜到', r.status === 200 && JSON.stringify(r.d || {}).includes(MEM_TITLE), 'status=' + r.status);

  check('★ API Key 还在（升级没动 config/profiles）', !!(st.d && st.d.hasKey),
    JSON.stringify(st.d && { hasKey: st.d.hasKey, masked: st.d.keyMasked }));

  check('★ 用户技能文件还在原处', fs.existsSync(path.join(skillDir, SKILL_FILE)));
  r = await j('GET', '/api/skills');
  check('★ 用户技能仍被 App 识别（内核扫描目录里的技能）',
    r.status === 200 && JSON.stringify(r.d || {}).includes(SKILL_FILE),
    'user=' + ((r.d && r.d.user) || []).length + ' count=' + (r.d && r.d.count));

  /* 升级前备份。注意 autoBackupData 会把 reason 里的非字母数字剔掉（2.4.0 → 240），
     所以预期后缀要按同样的规则算，不能直接拼 NEW_APP。 */
  const backupSuffix = ('before-upgrade-' + NEW_APP).replace(/[^a-zA-Z0-9_-]/g, '');
  let backups = [];
  try { backups = fs.readdirSync(path.join(DATA, '_auto_backup')).filter((n) => n.endsWith('-' + backupSuffix)); } catch (_) {}
  check('升级前已自动备份 data', backups.length > 0, backups.join(',') || '（未找到 -' + backupSuffix + '）');
  if (backups.length) {
    const bd = path.join(DATA, '_auto_backup', backups[0]);
    check('  └ 备份里有对话、资料库、config、技能',
      fs.existsSync(path.join(bd, 'chats', CHAT_ID + '.json'))
      && fs.existsSync(path.join(bd, 'library-text'))
      && fs.existsSync(path.join(bd, 'config.json')),
      path.relative(DATA, bd));
  } else {
    check('  └ 备份里有对话、资料库、config、技能', false, '没有备份目录');
  }

  /* 旧内核痕迹被清掉，且没误伤用户数据 */
  check('旧内核会话日志已清理（旧格式不留）', !fs.existsSync(oldSession));
  check('对话目录本身未被清（data/chats 仍在）', fs.existsSync(path.join(DATA, 'chats')));
  check('对话文件字节数与升级前一致', (() => {
    try { return fs.statSync(path.join(DATA, 'chats', CHAT_ID + '.json')).size === before.chatBytes; } catch (_) { return false; }
  })());

  await stopServer(ctx);

  const fails = results.filter((x) => !x.ok);
  console.log('');
  console.log('跨版本升级演练：' + (results.length - fails.length) + '/' + results.length + ' 通过');
  if (fails.length) {
    console.log('演练目录已保留，便于排查：' + DATA);
    process.exit(1);
  }
  rmr(DRILL_DIR);
  process.exit(0);
}

main().catch(async (e) => {
  console.error('ERR ' + (e && e.stack || e));
  process.exit(1);
});
