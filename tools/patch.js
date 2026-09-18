#!/usr/bin/env node
/* -----------------------------------------------
 * patch.js — 生成「Academy辩论教练-修复补丁-vX.Y.Z.exe」
 *
 * 解决什么问题：老用户为了一个几十行的修复，要重下 175MB 的完整安装包。
 * 本脚本把**改动过的文件**打成一个自解压小补丁（实测 2~3MB），双击一次即可升级。
 *
 * 与 pack.js / build-installer.js 的关系：
 *   pack.js             → 完整便携版 zip（首次分发）
 *   build-installer.js  → 安装版 exe（首次安装）
 *   patch.js（本文件）   → 修复补丁 exe（已装用户升级）
 *   三者共用 tools/sfx/*.cs 外壳与 csc 编译方式，产物都是「stub + 32字节标记 + zip」。
 *
 * 用法：
 *   node tools/patch.js --name="PDF 乱码修复" --notes="修正中文 PDF 提取"
 *   node tools/patch.js --files=app/pdf-text.js,app/server.js --name="..."
 *   node tools/patch.js --since=HEAD~1            # 取该提交之后改动过的文件
 *   node tools/patch.js --all-changed             # 取 git 工作区全部改动（默认）
 *
 * 默认文件来源 = git 工作区改动（已修改 + 未跟踪），并自动排除开发期文件。
 * 之所以默认用 git 而不是手工列：手工列迟早会漏掉一个文件，
 * 而「漏文件」在这个场景下的表现是用户打完补丁仍然坏着 —— 最难排查的那种。
 * ----------------------------------------------- */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SFX_DIR = path.join(ROOT, 'tools', 'sfx');
const STUB = path.join(SFX_DIR, 'AcademyPatchStub.exe');
const CS_SRC = path.join(SFX_DIR, 'PatchLauncher.cs');
const MAGIC = Buffer.from('ACADEMY-PATCH-OVERLAY-V1-9D4B7E3A15C8', 'ascii');
const BUILD_DIR = path.join(ROOT, '.build', 'patch');

/* 绝不进补丁的内容：
   - 开发期文件（开发日志、dist、build 产物）
   - 用户数据（data/）—— 补丁只更新程序，绝不能碰用户数据
   - 运行时（runtime/ 有 438MB，且本次修复用不到）
   - 自解压外壳产物本身 */
const EXCLUDE_RE = [
  /^dist\//i, /^\.build\//i, /^\.git\//i, /^\.backup\//i,
  /^data\//i, /^runtime\//i, /^node_modules\//i,
  /^开发日志\.md$/i, /^_patch_backup\//i,
  /\.exe$/i, /\.zip$/i, /\.log$/i, /\.tmp$/i,
];

function log(m) { console.log(m); }
function fail(m) { console.error('✗ ' + m); process.exit(1); }

function parseArgs(argv) {
  const out = { name: '', notes: '', from: '', to: '', files: '', since: '', edition: '' };
  for (const a of argv) {
    let m;
    if ((m = a.match(/^--name=(.*)$/))) out.name = m[1];
    else if ((m = a.match(/^--notes=(.*)$/))) out.notes = m[1];
    else if ((m = a.match(/^--from=(.*)$/))) out.from = m[1];
    else if ((m = a.match(/^--to=(.*)$/))) out.to = m[1];
    else if ((m = a.match(/^--files=(.*)$/))) out.files = m[1];
    else if ((m = a.match(/^--since=(.*)$/))) out.since = m[1];
    else if ((m = a.match(/^--edition=(.*)$/))) out.edition = m[1];
  }
  return out;
}

/* 补丁生成时必须先固定型号：patch.js 读 edition.js 拿版本号，
   而 edition 由环境变量/烘焙标记决定，这里统一先写环境变量再 require。 */
function loadEdition(want) {
  if (want) process.env.ACADEMY_EDITION = want;
  return require(path.join(ROOT, 'app', 'edition.js'));
}

// ---------- 收集要打进补丁的文件 ----------
function gitLines(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail('无法执行 git：' + r.error.message);
  if (r.status !== 0) fail('git ' + args.join(' ') + ' 失败：' + (r.stderr || '').trim());
  return String(r.stdout || '').split(/\r?\n/).filter(Boolean);
}

/* 从 git 取「改动过的文件」。
   --porcelain 的普通格式对含空格/中文的路径会加引号并转义，
   所以加 -z 用 NUL 分隔且不做转义 —— 工作区路径全是中文，普通格式必踩坑。 */
function changedFilesFromGit(since) {
  const set = new Set();
  if (since) {
    // 该提交之后被改动过的文件（含重命名/删除；删除的下面会因不存在被跳过）
    for (const line of gitLines(['diff', '--name-only', '-z', since + '..HEAD'])) {
      if (line) set.add(line);
    }
    for (const line of gitLines(['diff', '--name-only', '-z'])) if (line) set.add(line);
    for (const line of gitLines(['ls-files', '--others', '--exclude-standard', '-z'])) if (line) set.add(line);
    return Array.from(set);
  }
  // 默认：工作区相对 HEAD 的全部改动 + 未跟踪文件
  const raw = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (raw.error) fail('无法执行 git：' + raw.error.message);
  if (raw.status !== 0) fail('git status 失败：' + (raw.stderr || '').trim());
  // -z 输出：XY <path>\0  对重命名是 XY <new>\0<old>\0
  const parts = String(raw.stdout || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const status = rec.slice(0, 2);
    const p = rec.slice(3);
    if (p) set.add(p);
    if (status[0] === 'R' || status[1] === 'R') i++;   // 跳过重命名的旧路径
  }
  return Array.from(set);
}

function walkDir(dir, base, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (ent.isDirectory()) walkDir(full, base, out);
    else if (ent.isFile()) out.push(rel);
  }
}

function collectFiles(args) {
  let list;
  if (args.files) {
    list = args.files.split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
    log('  来源：--files 手工指定');
  } else {
    list = changedFilesFromGit(args.since);
    log('  来源：git 工作区改动' + (args.since ? '（自 ' + args.since + ' 起）' : ''));
  }

  // git 只报「直接改动」的文件；像 app/vendor/ 这种整目录新增，
  // status 会给一条目录路径，必须展开成里面的每个文件。
  const expanded = [];
  for (const rel of list) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;                 // 已删除的文件不打进补丁
    const st = fs.statSync(full);
    if (st.isDirectory()) walkDir(full, ROOT, expanded);
    else expanded.push(rel);
  }

  const seen = new Set();
  const kept = [];
  const skipped = [];
  for (const rel of expanded) {
    const norm = rel.replace(/\\/g, '/');
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (EXCLUDE_RE.some((re) => re.test(norm))) { skipped.push(norm); continue; }
    kept.push(norm);
  }
  kept.sort();
  return { kept, skipped };
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ---------- 找到 csc ----------
function findCsc() {
  const cands = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  fail('找不到系统自带 C# 编译器 csc.exe（需要 .NET Framework 4.x，Windows 10/11 均自带）。');
}

/* 用 csc 编译外壳。
   ★ 必须从 Node 用 spawnSync 调用，不要改成 PowerShell：
     工作区路径含中文，Windows PowerShell 5.1 把参数转交给 csc 时会按 ANSI 编码丢字，
     表现为「fatal error CS2005: /win32icon 选项缺少文件规范」+「CS2008 未指定源文件」。
     Node 的 spawnSync 按 UTF-16 传参，不受影响。tools/build-installer.js 同理。 */
function compileStub(csc) {
  if (!fs.existsSync(CS_SRC)) fail('缺少 ' + CS_SRC);
  const fx = path.dirname(csc);
  const refs = ['System.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll',
    'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll']
    .map((d) => path.join(fx, d));
  const args = [
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
    // 源码里有中文界面文案；不给 codepage 时 csc 按系统 ANSI 读，会变乱码
    '/codepage:65001',
    '/win32icon:' + path.join(ROOT, 'appicon.ico'),
    '/out:' + STUB,
  ].concat(refs.map((r) => '/r:' + r), [CS_SRC]);
  const r = spawnSync(csc, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) fail('无法启动 csc：' + r.error.message);
  if (r.status !== 0) fail('外壳编译失败：\n' + (r.stdout || '') + (r.stderr || ''));
  if (!fs.existsSync(STUB)) fail('外壳编译产物缺失');
  log('  ✓ 外壳已编译（' + fs.statSync(STUB).size + ' 字节）');
}

// ---------- 打 zip（复用 Windows 自带 bsdtar，与 pack.js 一致） ----------
function makeZip(zipPath, cwd, items) {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  const r = spawnSync('tar', ['-a', '-cf', zipPath, '-C', cwd].concat(items), {
    cwd, stdio: 'inherit', windowsHide: true,
  });
  if (r.error) fail('无法启动 tar：' + r.error.message + '（需要 Windows 10/11 自带 bsdtar）');
  if (r.status !== 0) fail('tar 打包失败，exit ' + r.status);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const edition = loadEdition(args.edition);
  const version = edition.version;
  const toVer = args.to || version;
  const fromVer = args.from || '';

  log('== Academy 辩论教练 · 修复补丁 ==');
  log('  型号：' + edition.name + '　版本：v' + version);

  // 1) 收集文件
  const { kept, skipped } = collectFiles(args);
  if (!kept.length) fail('没有收集到任何要更新的文件（工作区没有改动？或用 --files 指定）');
  log('  文件：' + kept.length + ' 个' + (skipped.length ? '（排除 ' + skipped.length + ' 个开发期文件）' : ''));

  // 2) 铺 payload
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const payloadDir = path.join(BUILD_DIR, 'payload');
  let totalBytes = 0;
  const manifestLines = [];
  for (const rel of kept) {
    const src = path.join(ROOT, rel);
    const dst = path.join(payloadDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const size = fs.statSync(src).size;
    totalBytes += size;
    manifestLines.push(sha256File(src) + '  ' + rel);
    if (size > 20 * 1024 * 1024) log('    · 大文件：' + rel + '（' + (size / 1048576).toFixed(1) + 'MB）');
  }
  fs.writeFileSync(path.join(BUILD_DIR, 'files.sha256'), manifestLines.join('\n') + '\n', 'utf8');

  // 3) 清单
  const patchName = args.name || ('修复补丁 v' + toVer);
  const defaultNotes = [
    '修正中文 PDF 进资料库显示为乱码的问题',
    '（中文 PDF 多用 CID 字体，旧提取器把字形编号当成了文字编码）',
    '顺带修复：约 4.5MB 以上的 PDF / Word 附件传不上来',
    '顺带修复：部分大体积 PDF 提取时报错中断',
  ].join('\r\n');
  const notes = (args.notes || defaultNotes).replace(/\\n/g, '\r\n');
  const manifest = [
    'name=' + patchName,
    'toversion=' + toVer,
    'fromversion=' + fromVer,
    'builtat=' + new Date().toISOString(),
    'filecount=' + kept.length,
    'totalbytes=' + totalBytes,
    'payload=payload',
    'notes=' + notes.split('\r\n').join('\\n'),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(BUILD_DIR, 'patch.txt'), manifest, 'utf8');

  // 4) 打 zip
  const rawZip = path.join(BUILD_DIR, 'patch.zip');
  makeZip(rawZip, BUILD_DIR, ['patch.txt', 'files.sha256', 'payload']);

  // 5) 编译外壳 + 拼接
  const csc = findCsc();
  compileStub(csc);

  const exeName = 'Academy辩论教练-修复补丁-v' + toVer + (edition.key === 'flash' ? '' : '-' + edition.name) + '.exe';
  const DIST = path.join(ROOT, 'dist');
  fs.mkdirSync(DIST, { recursive: true });
  const exePath = path.join(DIST, exeName);

  const stubBuf = fs.readFileSync(STUB);
  const zipBuf = fs.readFileSync(rawZip);
  fs.writeFileSync(exePath, Buffer.concat([stubBuf, MAGIC, zipBuf]));

  // MZ 头自检
  const head = Buffer.alloc(2);
  const fd = fs.openSync(exePath, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head[0] !== 0x4D || head[1] !== 0x5A) fail('产物不是有效的 Windows 程序（MZ 头校验失败）');

  // 6) 自检：从成品 exe 里把 zip 抠回来，验证清单与哈希一一对上
  log('  · 自检：从成品里回读并校验…');
  const whole = fs.readFileSync(exePath);
  const idx = whole.indexOf(MAGIC);
  if (idx < 0) fail('自检失败：成品里找不到叠加标记');
  const inner = whole.subarray(idx + MAGIC.length);
  if (!(inner[0] === 0x50 && inner[1] === 0x4B)) fail('自检失败：叠加数据不是 zip');
  const backZip = path.join(BUILD_DIR, '__verify.zip');
  fs.writeFileSync(backZip, inner);
  const verifyDir = path.join(BUILD_DIR, '__verify');
  fs.mkdirSync(verifyDir, { recursive: true });
  const un = spawnSync('tar', ['-xf', backZip, '-C', verifyDir], { windowsHide: true });
  if (un.status !== 0) fail('自检失败：无法解出叠加的 zip');
  const backList = fs.readFileSync(path.join(verifyDir, 'files.sha256'), 'utf8')
    .split(/\r?\n/).filter(Boolean);
  if (backList.length !== kept.length) fail('自检失败：清单条目数 ' + backList.length + ' ≠ ' + kept.length);
  let verified = 0;
  for (const line of backList) {
    const sp = line.indexOf('  ');
    const want = line.slice(0, sp);
    const rel = line.slice(sp + 2);
    const f = path.join(verifyDir, 'payload', rel);
    if (!fs.existsSync(f)) fail('自检失败：payload 里缺少 ' + rel);
    if (sha256File(f) !== want) fail('自检失败：哈希不符 ' + rel);
    verified++;
  }
  if (!fs.existsSync(path.join(verifyDir, 'patch.txt'))) fail('自检失败：缺少 patch.txt');
  log('  ✓ 自检通过（' + verified + ' 个文件哈希全部吻合）');

  // 7) 生成一份「给用户照做」的说明（纯 ASCII 文件名 + UTF-8 带 BOM，
  //    这样 Windows 记事本和微信里都不会乱码；配合 exe 一起发）
  const readmeName = '【先看我】修复补丁怎么用.txt';
  const readme = [
    'Academy 辩论教练 · 修复补丁使用说明',
    '============================================================',
    '',
    '这个补丁修了什么：',
    '  · PDF 传进「资料库」后正文显示成乱码 —— 已修好，中文 PDF 能正常识别',
    '  · 4.5MB 以上的 PDF / Word 附件传不上来 —— 已修好',
    '  · 部分页数多的 PDF 提取到一半报错 —— 已修好',
    '',
    '------------------------------------------------------------',
    '怎么用（三步，不用卸载、不用重装）',
    '------------------------------------------------------------',
    '',
    '  第 1 步  双击这个补丁文件（' + exeName + '）',
    '',
    '  第 2 步  看清楚「安装位置」那一栏：',
    '            · 如果已经自动填好了 → 直接点右下角「开始修复」',
    '            · 如果是空的 → 点「更改…」，选中你当初安装辩论教练的',
    '              那个文件夹（里面应该能看到 app 和 runtime 两个子文件夹）',
    '',
    '  第 3 步  等它跑完（几秒钟），弹窗问「现在打开辩论教练吗」→ 点「是」',
    '',
    '------------------------------------------------------------',
    '几点说明',
    '------------------------------------------------------------',
    '',
    '  · 你的对话记录、API Key、上传的资料 都不会动，只替换程序文件。',
    '  · 修复前会自动把原文件备份到安装目录的 _patch_backup 文件夹；',
    '    万一出问题，补丁会自己还原回去。',
    '  · 如果 Windows 弹出蓝色的「Windows 已保护你的电脑」，',
    '    点「更多信息」→「仍要运行」即可（程序没买微软签名，不是病毒）。',
    '  · 要是杀毒软件拦它，选「允许」或先临时关闭杀毒软件再点一次。',
    '',
    '------------------------------------------------------------',
    '出问题了怎么办',
    '------------------------------------------------------------',
    '',
    '  · 双击没反应：等 10 秒；还不行就右键 →「以管理员身份运行」。',
    '  · 提示「找不到安装目录」：点「更改…」手动选，参考第 2 步。',
    '  · 修复失败：窗口里会写明原因，程序已自动还原，软件照常能用。',
    '    可以把原因截图发到 QQ 群 386631298。',
    '',
    '============================================================',
    '  QFUD · 驻青四校联合辩论培训计划',
    '',
  ].join('\r\n');

  // 8) 导出到工作区 dist/（方便直接发人），与 build-installer.js 同口径
  const parent = path.dirname(ROOT);
  const shareDist = (process.env.ACADEMY_SHARE_DIST || '').trim() ||
    (path.dirname(parent) === parent ? '' : path.join(parent, 'dist'));
  const exeStat = fs.statSync(exePath);
  if (shareDist) {
    try {
      fs.mkdirSync(shareDist, { recursive: true });
      fs.copyFileSync(exePath, path.join(shareDist, exeName));
      // UTF-8 带 BOM：记事本/微信打开中文不乱码
      fs.writeFileSync(path.join(shareDist, readmeName), '\uFEFF' + readme, 'utf8');
      log('  ✓ 已导出 ' + path.join(shareDist, exeName));
      log('  ✓ 已导出 ' + path.join(shareDist, readmeName));
    } catch (e) { log('  （导出失败，可忽略）' + e.message); }
  }

  log('');
  log('== 完成 ==');
  log('  产物：' + exePath);
  log('  大小：' + (exeStat.size / 1024 / 1024).toFixed(2) + ' MB（原始文件合计 ' + (totalBytes / 1024 / 1024).toFixed(2) + ' MB）');
  log('  文件：' + kept.length + ' 个');
  log('');
  log('发给用户：只需要这一个 exe。双击 → 自动找到安装位置 → 「开始修复」→ 完成。');
  if (skipped.length) {
    log('');
    log('  已排除（开发期文件，不进补丁）：');
    for (const s of skipped.slice(0, 12)) log('    · ' + s);
    if (skipped.length > 12) log('    · …（其余 ' + (skipped.length - 12) + ' 个）');
  }
}

main();
