/*
 * upgrade-dsh.js — 一键升级 App 内置的 DSH 内核
 *
 * 背景：App 的 runtime/dsh 是一棵完整的 npm 依赖树（200+ 个 @deepseek-ai/dsh-* 包），
 * 只换 dsh 包本身会导致版本不一致，必须整棵树一起换。
 * App 自带的 node.exe 是裸的、没有 npm，所以借系统 npm 在临时目录装好再整体搬过来。
 *
 * 用法：
 *   node tools/upgrade-dsh.js                  # 装 npm 上最新版
 *   node tools/upgrade-dsh.js 0.1.5-rc.2       # 装指定版本
 *   node tools/upgrade-dsh.js --list           # 只看有哪些版本
 *
 * 流程：解析版本 -> 临时目录 npm install -> 备份旧内核 -> 替换 -> 校验能启动
 * 安全：旧内核先备份到 .backup/dsh-<旧版本>-<日期>/，失败可手动回滚。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = '@deepseek-ai/dsh';
const DSH_DIR = path.join(ROOT, 'runtime', 'dsh');
const NODE_MODULES = path.join(DSH_DIR, 'node_modules');
const DSH_PKG_JSON = path.join(NODE_MODULES, '@deepseek-ai', 'dsh', 'package.json');
const DSH_BIN = path.join(NODE_MODULES, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const NODE_EXE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const STAGE = path.join(ROOT, '.dsh-upgrade-staging');

function log(m) { console.log(m); }
function fail(m) { console.error('✗ ' + m); process.exit(1); }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32', ...opts });
  if (r.error) fail('无法执行 ' + cmd + '：' + r.error.message);
  return r.status;
}
function currentVersion() {
  try { return JSON.parse(fs.readFileSync(DSH_PKG_JSON, 'utf8')).version; } catch (_) { return ''; }
}

const argv = process.argv.slice(2);
const wantList = argv.includes('--list');
const target = argv.find((a) => !a.startsWith('--')) || '';

/* 用系统 npm：App 自带 node 是裸的 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (wantList) {
  log('== npm 上 ' + PKG + ' 的可用版本 ==');
  process.exit(run(NPM, ['view', PKG, 'versions', '--json']));
}

const before = currentVersion();
log('== Academy 辩论教练 · DSH 内核升级 ==');
log('当前内核: ' + (before || '（未安装）'));
log('目标版本: ' + (target || 'npm 最新（latest）'));

/* 0) 拒绝在 App 运行时升级：文件会被占用 */
if (fs.existsSync(DSH_BIN)) {
  const probe = path.join(DSH_DIR, '.upgrade_write_test');
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch (e) {
    fail('内核目录不可写（App 可能正在运行），请先完全退出 App 再升级。');
  }
}

/* 1) 在临时目录装好整棵树 */
log('\n[1/5] 在临时目录安装依赖树（约 200MB，1~3 分钟）…');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({ name: 'dsh-upgrade-staging', private: true, version: '1.0.0' }, null, 2));
const spec = PKG + (target ? '@' + target : '@latest');
const installCode = run(NPM, ['install', spec, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: STAGE });
if (installCode !== 0) fail('npm install 失败（exit ' + installCode + '）');

const stagedPkg = path.join(STAGE, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
if (!fs.existsSync(stagedPkg)) fail('安装后找不到 ' + PKG + '，请检查网络或版本号。');
const after = JSON.parse(fs.readFileSync(stagedPkg, 'utf8')).version;
log('  ✓ 已安装 ' + PKG + '@' + after);
if (after === before) log('  （与当前版本相同，仍会继续执行覆盖安装）');

/* 2) 备份旧内核 */
let backup = '';
if (fs.existsSync(DSH_DIR)) {
  const stamp = new Date().toISOString().slice(0, 10);
  backup = path.join(ROOT, '.backup', 'dsh-' + (before || 'unknown') + '-' + stamp);
  if (fs.existsSync(backup)) backup = backup + '-' + Date.now().toString(36);
  log('\n[2/5] 备份旧内核 → ' + path.relative(ROOT, backup));
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  const rc = run('robocopy', [DSH_DIR, backup, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']);
  if (rc > 7) fail('备份失败（robocopy exit ' + rc + '）');
  log('  ✓ 备份完成');
} else {
  log('\n[2/5] 无旧内核，跳过备份');
}

/* 3) 替换 */
log('\n[3/5] 替换内核文件…');
fs.rmSync(DSH_DIR, { recursive: true, force: true });
fs.mkdirSync(DSH_DIR, { recursive: true });
const rc2 = run('robocopy', [path.join(STAGE, 'node_modules'), NODE_MODULES, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP']);
if (rc2 > 7) fail('复制失败（robocopy exit ' + rc2 + '）');
log('  ✓ 替换完成');

/* 4) 校验依赖树完整性 */
log('\n[4/5] 校验依赖树…');
if (!fs.existsSync(DSH_BIN)) fail('找不到内核入口 ' + DSH_BIN);
const agentDir = path.join(NODE_MODULES, '@deepseek-ai');
const pkgCount = fs.existsSync(agentDir) ? fs.readdirSync(agentDir).filter((n) => n.startsWith('dsh')).length : 0;
if (pkgCount < 50) fail('@deepseek-ai/dsh-* 包数量异常（' + pkgCount + ' 个），依赖树可能不完整。');
const binOk = spawnSync(NODE_EXE, [DSH_BIN, '--version'], { encoding: 'utf8', windowsHide: true });
const reported = String(binOk.stdout || '').trim();
log('  ✓ dsh 包数量: ' + pkgCount);
log('  ✓ 内核自报版本: ' + (reported || '(无输出)'));

/* 5) 收尾 */
log('\n[5/5] 清理临时目录…');
fs.rmSync(STAGE, { recursive: true, force: true });

log('');
log('== 升级完成 ==');
log('  ' + (before || '（无）') + '  →  ' + after);
if (backup) log('  旧内核备份: ' + path.relative(ROOT, backup));
log('');
log('请启动 App 跑一个任务确认（发「回复：好的」即可）。');
log('若出现问题，把备份目录改名回 runtime/dsh 即可回滚。');
