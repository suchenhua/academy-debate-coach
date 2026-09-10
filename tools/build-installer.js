/*
 * build-installer.js — 生成「Academy辩论教练-安装版.exe」
 *
 * 原理（不依赖 7-Zip SFX，纯 Windows 自带 .NET 编译）：
 *   1. 归一化安装脚本的行尾/编码（bat/vbs=无BOM CRLF，ps1=带BOM CRLF）
 *   2. 校验 tools/pack.js 产出的便携版 zip 已包含安装辅助文件
 *   3. 用系统自带 csc.exe 编译一个小型 WinForms 自解压外壳（带应用图标）
 *   4. stub.exe + 32字节分隔标记 + 便携版zip 拼接为最终 setup.exe
 *   双击 setup.exe → 解压到临时目录 → 隐藏运行 setup.bat → 装到
 *   %LOCALAPPDATA%\AcademyDebateCoach → 创建桌面/开始菜单快捷方式 → 打开浏览器
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
/* 产物除项目内 dist/ 外，再复制一份到「工作区 dist/」（项目目录的上一级），方便直接发人。
   护栏：项目若直接放在磁盘根目录（如 E:\App），上一级就是盘根，此时不复制。
   需要指定别处时用 ACADEMY_SHARE_DIST=<目录>。 */
function resolveShareDist() {
  const explicit = (process.env.ACADEMY_SHARE_DIST || '').trim();
  if (explicit) return explicit;
  const parent = path.dirname(ROOT);
  if (path.dirname(parent) === parent) return '';
  return path.join(parent, 'dist');
}
const SHARE_DIST = resolveShareDist();
const ZIP = path.join(DIST, 'Academy-Bianlun-Coach-portable.zip');
const STUB_OUT = path.join(ROOT, 'tools', 'sfx', 'AcademySetupStub.exe');
const CS_SRC = path.join(ROOT, 'tools', 'sfx', 'SfxLauncher.cs');
const EXE_NAME_CN = 'Academy辩论教练-安装版.exe';
const EXE_NAME_EN = 'Academy-Bianlun-Coach-setup.exe';
const EXE = path.join(DIST, EXE_NAME_CN);
const MAGIC = Buffer.from('ACADEMY-SETUP-OVERLAY-V1-7F3A9C21B64E', 'ascii');

const NO_TEST = process.argv.includes('--no-test');

// 需要归一化行尾/编码的安装脚本
const NORMALIZE = [
  'setup.bat', '一键安装.bat', 'uninstall.bat', 'launch.vbs', '安装说明.txt', '使用说明.txt',
];
const NORMALIZE_PS1 = ['install-shortcuts.ps1'];

function log(msg) { console.log(msg); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

function normalizeCrlf(text) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

function find7za() {
  const candidates = [
    path.join(ROOT, 'tools', '7za.exe'),
    path.join(process.env.TEMP || 'C:\\Windows\\Temp', '7zextra', '7za.exe'),
    path.join(process.env.TEMP || 'C:\\Windows\\Temp', '7za.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  fail('找不到 7za.exe（请放到 tools\\7za.exe）。');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, ...opts });
  if (r.error) fail(`无法启动 ${cmd}: ${r.error.message}`);
  return r.status;
}

function step0Normalize() {
  log('== 0) 归一化安装脚本编码与行尾 ==');
  for (const name of NORMALIZE) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) fail(`缺少 ${name}`);
    const text = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, normalizeCrlf(text));
    log('  ✓ ' + name + ' → UTF-8 无BOM + CRLF');
  }
  for (const name of NORMALIZE_PS1) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) fail(`缺少 ${name}`);
    let text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    fs.writeFileSync(p, '\uFEFF' + normalizeCrlf(text));
    log('  ✓ ' + name + ' → UTF-8 带BOM + CRLF');
  }
}

function step1VerifyZip(sevenZr) {
  log('== 1) 校验便携版 zip（应已由 tools/pack.js 完整打包） ==');
  if (!fs.existsSync(ZIP)) fail('缺少便携版 zip：' + ZIP);
  const list = spawnSync(sevenZr, ['l', '-slt', ZIP], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (list.status !== 0) fail('7za 无法读取 zip（exit ' + list.status + '）');
  const hasSetup = String(list.stdout || '').split(/\r?\n/).some((l) => l === 'Path = setup.bat');
  if (!hasSetup) fail('zip 里没有 setup.bat。请先运行 tools\\pack.js 重新打包（一键打包.bat 会自动完成两步）。');
  log('  ✓ zip 已包含安装辅助文件（setup.bat 等）');

  if (!NO_TEST) {
    log('  校验 zip 完整性（7za t，约 1 分钟）...');
    const t = run(sevenZr, ['t', '-y', ZIP]);
    if (t !== 0) fail('zip 完整性校验失败（exit ' + t + '）');
    log('  ✓ zip 完整');
  }
}

function findCsc() {
  const candidates = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  fail('找不到系统自带 C# 编译器 csc.exe（需要 .NET Framework 4.x，Windows 10/11 均自带）。');
}

function step2CompileStub(csc) {
  log('== 2) 编译安装外壳（WinForms，约 12 KB） ==');
  if (!fs.existsSync(CS_SRC)) fail('缺少 ' + CS_SRC);
  const fx = path.dirname(csc);
  const refs = [
    'System.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll',
    'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll',
  ].map((dll) => path.join(fx, dll));
  const args = [
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
    '/win32icon:' + path.join(ROOT, 'appicon.ico'),
    '/out:' + STUB_OUT,
  ].concat(refs.map((r) => '/r:' + r), [CS_SRC]);
  const r = spawnSync(csc, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) fail('无法启动 csc：' + r.error.message);
  if (r.status !== 0) fail('编译失败：\n' + (r.stdout || '') + (r.stderr || ''));
  if (!fs.existsSync(STUB_OUT)) fail('编译产物缺失');
  log('  ✓ 外壳已编译：' + STUB_OUT + '（' + fs.statSync(STUB_OUT).size + ' 字节）');
}

function step3Concat() {
  log('== 3) 拼接最终安装版 exe ==');
  if (!fs.existsSync(STUB_OUT)) fail('缺少外壳 ' + STUB_OUT);
  if (!fs.existsSync(ZIP)) fail('缺少 zip ' + ZIP);
  fs.mkdirSync(DIST, { recursive: true });
  const stub = fs.readFileSync(STUB_OUT);
  const zipStat = fs.statSync(ZIP);
  if (zipStat.size < 50 * 1024 * 1024) fail('zip 异常偏小，拒绝打包');

  const wfd = fs.openSync(EXE, 'w');
  try {
    fs.writeSync(wfd, stub);
    fs.writeSync(wfd, MAGIC);
    const rfd = fs.openSync(ZIP, 'r');
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let pos = 0;
    let total = 0;
    try {
      let n;
      while ((n = fs.readSync(rfd, buf, 0, buf.length, pos)) > 0) {
        fs.writeSync(wfd, buf, 0, n);
        pos += n;
        total += n;
      }
    } finally {
      fs.closeSync(rfd);
    }
    if (total !== zipStat.size) fail('拼接长度不一致：' + total + ' != ' + zipStat.size);
  } finally {
    fs.closeSync(wfd);
  }

  const head = Buffer.alloc(2);
  const fd = fs.openSync(EXE, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head[0] !== 0x4D || head[1] !== 0x5A) fail('产物不是有效的 Windows 程序（MZ 头校验失败）');
  log('  ✓ 拼接完成，校验通过');
}

async function main() {
  const t0 = Date.now();
  log('== Academy 辩论教练 · 安装版打包 ==');
  step0Normalize();
  const sevenZr = find7za();
  step1VerifyZip(sevenZr);
  const csc = findCsc();
  step2CompileStub(csc);
  await step3Concat();

  const exeStat = fs.statSync(EXE);
  log('  ✓ ' + EXE);
  log('    大小：' + (exeStat.size / 1024 / 1024).toFixed(1) + ' MB');

  if (SHARE_DIST) {
    try {
      fs.mkdirSync(SHARE_DIST, { recursive: true });
      for (const name of [EXE_NAME_CN, EXE_NAME_EN]) {
        fs.copyFileSync(EXE, path.join(SHARE_DIST, name));
        log('  ✓ 已导出 ' + path.join(SHARE_DIST, name));
      }
    } catch (e) { log('（导出失败，可忽略）' + e.message); }
  }
  log('== 完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒 ==');
  log('');
  log('发给小白用户：只需要这一个文件 → ' + (SHARE_DIST ? path.join(SHARE_DIST, EXE_NAME_CN) : EXE));
  log('双击 → 等待 1~3 分钟 → 浏览器自动打开。');
}

main().catch((e) => { console.error('✗ ' + (e && e.stack || e)); process.exit(1); });
