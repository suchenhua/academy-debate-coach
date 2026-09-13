/*
 * pack.js — 一键打可分发 zip
 * 步骤：
 *   1. 校验/补齐 DSH 内核 + 内置 node（存在则跳过）
 *   2. 用 Windows 自带 tar（bsdtar）打 zip（避免 Compress-Archive 长路径损坏）
 *   3. 校验 zip 可读、条目数合理
 * 产物：dist/Academy-Bianlun-Coach-portable.zip
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ZIP = path.join(DIST, 'Academy-Bianlun-Coach-portable.zip');
const NODE = process.env.ACADEMY_NODE || path.join(ROOT, 'runtime', 'node', 'node.exe');
/* DSH 内核两种布局都要认：新版扁平 runtime/dsh/@deepseek-ai/...，旧版嵌套 runtime/dsh/node_modules/@deepseek-ai/... */
const DSH_BIN_CANDIDATES = [
  path.join(ROOT, 'runtime', 'dsh', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(ROOT, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
];
const DSH_BIN = DSH_BIN_CANDIDATES.find((p) => fs.existsSync(p)) || DSH_BIN_CANDIDATES[1];

const ITEMS = [
  'start.bat', '一键打包.bat', '一键安装.bat', 'setup.bat', 'uninstall.bat',
  'launch.vbs', '启动辩论助手(Electron桌面版).vbs', 'install-shortcuts.ps1', 'appicon.ico', '安装说明.txt',
  'README.md', '使用说明.txt', '小白安装指南.md',
  'AGENTS.md', 'SOUL.md', 'TOOLS.md', 'LICENSE.md',
  'app', '.dsh',
  // runtime 逐项列出：dsh-old-010 / dsh-new 是历史试验内核，绝不能进分发包
  'runtime/node', 'runtime/electron', 'runtime/dsh',
  'runtime/persona.patch.yml',
  // 正文流式插件：被 persona.patch.yml 的 insert 引用，漏打包会导致内核整个起不来
  'runtime/academy-text-stream.mjs',
  'knowledge', 'modules', 'prep-coach', 'review-coach', 'judge-assistant',
  'protocols', 'personas', 'scripts', 'tools',
];

function log(msg) { console.log(msg); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

/* 发版前版本一致性自检：APP_VERSION 是单一来源，但 README 标题/正文、安装外壳
   AssemblyVersion 仍需手工同步。这里只做「提醒 + 可选阻断」，避免发版后
   安装程序与 App 自称的版本号不一致。
   用 ACADEMY_STRICT_VERSION=1 可把不一致升级为打包失败。 */
function checkVersionConsistency() {
  const serverSrc = path.join(ROOT, 'app', 'server.js');
  const m = fs.readFileSync(serverSrc, 'utf8').match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) { log('· 版本自检：未能从 app/server.js 解析 APP_VERSION，跳过'); return; }
  const ver = m[1];
  const problems = [];
  const readme = path.join(ROOT, 'README.md');
  if (fs.existsSync(readme)) {
    const text = fs.readFileSync(readme, 'utf8');
    // README 里出现的所有 vX.Y.Z / X.Y.Z 版本号，收集去重后比对
    const found = Array.from(new Set((text.match(/v?\d+\.\d+\.\d+/g) || []).map((s) => s.replace(/^v/i, ''))));
    const stale = found.filter((x) => x !== ver);
    if (stale.length) problems.push('README.md 仍写着 ' + stale.map((x) => 'v' + x).join('、') + '（应为 v' + ver + '）');
  }
  const cs = path.join(ROOT, 'tools', 'sfx', 'SfxLauncher.cs');
  if (fs.existsSync(cs)) {
    const am = fs.readFileSync(cs, 'utf8').match(/AssemblyVersion\(\s*["'](\d+)\.(\d+)\.(\d+)\.(\d+)["']/);
    // 捕获组是 [1]=major [2]=minor [3]=patch [4]=build，
    // 要和 APP_VERSION 的 major.minor.patch 逐位对应（早先这里索引整体错开了一位，
    // 结果「一致也报不一致、真不一致反而可能漏报」，等于护栏失效）
    const want = ver.split('.');
    if (am && !(am[1] === want[0] && am[2] === want[1] && am[3] === want[2])) {
      problems.push('SfxLauncher.cs AssemblyVersion 为 ' + am[1] + '.' + am[2] + '.' + am[3] + '.' + am[4] + '（应为 ' + ver + '.0）');
    }
  }
  if (!problems.length) { log('✓ 版本一致性自检：v' + ver + '（README / 安装外壳已同步）'); return; }
  for (const p of problems) log('⚠ 版本不一致：' + p);
  if (process.env.ACADEMY_STRICT_VERSION === '1') fail('版本不一致（ACADEMY_STRICT_VERSION=1，已阻断打包）');
  log('  （提示：改完再打包，或用 ACADEMY_STRICT_VERSION=0 忽略）');
}

log('== Academy 辩论教练 · 一键打包 ==');

// 0) 内核检查（不存在时尝试从源目录复制）
if (!fs.existsSync(DSH_BIN) || !fs.existsSync(NODE)) {
  log('运行内核不完整，尝试自动补齐…');
  const setup = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'setup-runtime.js')], { cwd: ROOT, stdio: 'inherit' });
  if (setup.status !== 0) fail('运行内核补齐失败（用 ACADEMY_DSH_SOURCE=<已解压的 runtime 目录> 指定来源后重试）');
}
if (!fs.existsSync(DSH_BIN)) fail('DSH 内核缺失: ' + DSH_BIN);
if (!fs.existsSync(NODE)) fail('内置 node 缺失: ' + NODE);
const ELECTRON_BIN = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON_BIN)) fail('Electron 桌面版内核缺失: ' + ELECTRON_BIN + '（需先放入 runtime/electron/dist）');
log('✓ 内核就绪（DSH + node + Electron）');

// 0.3) 清理 Electron 下载中间产物（electron.zip 不需要进分发包）
try {
  const staleZip = path.join(ROOT, 'runtime', 'electron', 'electron.zip');
  if (fs.existsSync(staleZip)) { fs.rmSync(staleZip, { force: true }); log('✓ 已清理 Electron 中间 zip'); }
} catch (_) {}

// 0.35) 发版前版本一致性自检（README / 安装外壳 vs APP_VERSION）
checkVersionConsistency();

// 0.4) 安装脚本行尾/编码归一化（必须在消毒之前，防止 PS1 的 BOM 丢失、bat 行尾异常）
function normalizeCrlf(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}
for (const name of ['setup.bat', '一键安装.bat', 'uninstall.bat', 'launch.vbs', '启动辩论助手(Electron桌面版).vbs', '安装说明.txt', '使用说明.txt']) {
  const p = path.join(ROOT, name);
  if (fs.existsSync(p)) fs.writeFileSync(p, normalizeCrlf(fs.readFileSync(p, 'utf8')));
}
const ps1 = path.join(ROOT, 'install-shortcuts.ps1');
if (fs.existsSync(ps1)) fs.writeFileSync(ps1, '\uFEFF' + normalizeCrlf(fs.readFileSync(ps1, 'utf8')));
log('✓ 安装脚本编码归一化');

// 0.5) 开源合规检查：确保无内部资料水印/隐私/行政内容残留（本发行版只有开源版一条线）
const sanitizeJs = path.join(ROOT, 'tools', 'sanitize-open-source.js');
if (fs.existsSync(sanitizeJs)) {
  log('执行开源合规检查…');
  const s = spawnSync(process.execPath, [sanitizeJs], { cwd: ROOT, stdio: 'inherit' });
  if (s.status !== 0) fail('开源合规检查失败');
} else {
  fail('缺少 tools/sanitize-distribution.js，拒绝打包（防止未消毒内容进入发行包）');
}

// 0.6) 裁剪运行时体积：dsh 里运行时不用的 .map/.ts/.d.ts/.md/.pdb + Electron 未用 locale。
//      放在打包流程里，升级内核或重下 Electron 之后下次打包会自动重裁，不用手工维护。
const pruneJs = path.join(ROOT, 'tools', 'prune-runtime.js');
if (fs.existsSync(pruneJs)) {
  log('裁剪运行时体积…');
  const pruned = spawnSync(process.execPath, [pruneJs], { cwd: ROOT, stdio: 'inherit' });
  if (pruned.status !== 0) fail('运行时裁剪失败');
} else {
  fail('缺少 tools/prune-runtime.js');
}

// 1) 准备输出目录（zip 与被归档内容隔离：dist 不在 ITEMS 里）
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const missing = ITEMS.filter((item) => !fs.existsSync(path.join(ROOT, item)));
if (missing.length) fail('以下待打包内容缺失: ' + missing.join(', '));
log('✓ 待打包内容完整（' + ITEMS.length + ' 项）');

// 2) tar -a -cf 输出.zip -C ROOT item1 item2 ...（bsdtar 处理深路径）
log('正在打包（约 200~400MB 内容，需要几分钟，请勿关闭窗口）…');
const args = ['-a', '-cf', ZIP, '-C', ROOT].concat(ITEMS);
const t0 = Date.now();
const r = spawnSync('tar', args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (r.error) fail('无法启动 tar：' + r.error.message + '（需要 Windows 10/11 自带 bsdtar）');
if (r.status !== 0) fail('tar 打包失败，exit ' + r.status);
log('✓ 打包完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');

// 3) 校验：大小 + 条目数（报「找不到中央目录」= 没打完）
const stat = fs.statSync(ZIP);
if (stat.size < 50 * 1024 * 1024) fail('zip 异常小（' + (stat.size / 1024 / 1024).toFixed(1) + ' MB），可能打包不完整');
const list = spawnSync('tar', ['-tf', ZIP], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
if (list.status !== 0) fail('zip 校验失败：无法读取中央目录（' + String(list.stderr || '').slice(0, 200) + '）');
const count = String(list.stdout || '').split(/\r?\n/).filter(Boolean).length;
if (count < 5000) fail('zip 条目数异常（' + count + '），打包不完整');
log('✓ zip 校验通过：' + (stat.size / 1024 / 1024).toFixed(1) + ' MB，' + count.toLocaleString() + ' 个条目');
/* 产物除项目内 dist/ 外，再复制一份到「工作区 dist/」（项目目录的上一级），方便直接发人。
   护栏：项目若直接放在磁盘根目录（如 E:\App），上一级就是盘根，此时不复制，
   避免在盘根上乱建目录。需要指定别处时用 ACADEMY_SHARE_DIST=<目录>。 */
function resolveShareDir() {
  const explicit = (process.env.ACADEMY_SHARE_DIST || '').trim();
  if (explicit) return explicit;
  const parent = path.dirname(ROOT);
  if (path.dirname(parent) === parent) return ''; // 上一级是磁盘根目录，放弃
  return path.join(parent, 'dist');
}
const shareDir = resolveShareDir();
if (shareDir) {
  try {
    fs.mkdirSync(shareDir, { recursive: true });
    for (const name of [path.basename(ZIP), 'Academy辩论教练-便携版.zip']) {
      fs.copyFileSync(ZIP, path.join(shareDir, name));
    }
    log('✓ 已导出到 ' + shareDir);
  } catch (e) { log('（导出失败，可忽略）' + e.message); }
}
log('');
log('分发文件：');
log('  ' + ZIP);
log('');
log('把 zip 发给对方 → 解压到任意目录 → 双击 启动辩论助手(Electron桌面版).vbs → 填入 API Key 即用。');
log('== 完成 ==');