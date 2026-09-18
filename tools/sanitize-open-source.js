/*
 * sanitize-open-source.js（开源发布版）
 * 开源合规检查（可重复执行，幂等）：
 *   1. 扫描并报告残留的 QFUD「内部资料/禁止外传」水印（源码注释、文件头、独立 txt）；
 *   2. 删除独立的 QFUD 声明 txt 文件；
 *   3. 检查是否有引用不存在目录的资料路径（references/team-materials 等）；
 *   4. 输出检查清单，便于确认发布前干净。
 * 用法：node tools/sanitize-open-source.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* 注意：必须含 .mjs —— runtime/academy-text-stream.mjs 是我们自己写的内核插件，
   下面第 2 步专门把它加进扫描列表，就是因为它里面一旦写死开发机绝对路径，
   分包在别人机器上会让**整个内核起不来**。但本集合原先没有 .mjs，扩展名过滤那一步
   会把它直接跳过 —— 这个护栏等于失效（实测：往该文件注入本机项目路径，检查依旧
   「✓ 通过」并 exit 0）。.cjs / .mts 同理补齐。 */
const TEXT_EXT = new Set(['.md', '.txt', '.js', '.mjs', '.cjs', '.mts', '.css', '.html', '.yml', '.yaml', '.json', '.py', '.ps1', '.bat', '.vbs']);
const WALK_DIRS = ['knowledge', 'modules', 'protocols', 'personas', 'prep-coach', 'review-coach', 'judge-assistant', 'scripts', 'team', '.dsh', 'app', 'tools'];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // vendor = 原样分发的第三方库（如 pdfjs-dist），与 node_modules 同理不扫：
      // 它们体量大、压缩过，扫了既慢又容易误报，而且我们并未修改它们。
      if (['node_modules', 'runtime', 'data', 'dist', '.git', '.build', 'vendor'].includes(ent.name)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

console.log('== Academy 辩论教练 · 开源合规检查 ==');

// 1) 收集所有文本文件
const files = [];
for (const name of WALK_DIRS) {
  const p = path.join(ROOT, name);
  if (fs.existsSync(p)) files.push(...walk(p));
}
for (const f of ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'README.md', 'INSTALL.md', 'LICENSE.md', '使用说明.txt', '安装说明.txt']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
}
/* runtime/ 整体是第三方内核（几万个文件，不扫），但下面这两个是**我们自己写的**，
   而且 patch 里正好出现过「开发机绝对路径」导致分包后在别人机器上内核起不来的事故。 */
for (const f of ['runtime/persona.patch.yml', 'runtime/academy-text-stream.mjs']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
}

// 2) 删除独立的 QFUD 声明 txt（这些是旧的内部标记，开源版不应存在）
let removedTxt = 0;
for (const file of files) {
  if (path.basename(file) === 'QFUD内部资料声明.txt') {
    try { fs.rmSync(file, { force: true }); removedTxt++; } catch (e) { console.warn('rm fail:', file); }
  }
}
console.log('  ✂ 删除 QFUD 声明 txt:', removedTxt, '个');

// 3) 扫描残留在文件体内的 QFUD 水印文本（报告 + 可选清除）
const WATERMARK_RE = /QFUD\s*计划\s*·\s*内部资料|未经授权不得外传|禁止复制、分发|仅供 QFUD 计划授权人员使用/g;
const HEADER_RE = /^\/?\*?[>#]?\s*⚠?\s*QFUD/gm;
const SELF = __filename;
let bodyTouched = 0;
const found = [];
for (const file of files) {
  if (file === SELF) continue;
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  if (!text) continue;
  const hits = text.match(WATERMARK_RE);
  if (hits) {
    found.push(path.relative(ROOT, file) + ' (' + hits.length + ' 处)');
    // 清除整行水印（保持文件其余内容不变）
    const cleaned = text
      .split(/\r?\n/)
      .filter((line) => !WATERMARK_RE.test(line))
      .join('\n');
    if (cleaned !== text) {
      fs.writeFileSync(file, cleaned, 'utf8');
      bodyTouched++;
    }
  }
}
console.log('  ✂ 清除文件体积水印:', bodyTouched, '个');
if (found.length) {
  console.log('  ── 含水印文件：');
  found.forEach((f) => console.log('    · ' + f));
}

// 4) 检查不应出现的内部资料路径引用
const BAD_REF = /references\/|team-materials|tournament-results|coaching-excerpts/g;
const badRefs = [];
for (const file of files) {
  if (file === SELF) continue;
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  if (!text) continue;
  if (BAD_REF.test(text)) badRefs.push(path.relative(ROOT, file));
}
if (badRefs.length) {
  console.log('  ── 含内部资料路径/人名引用（需人工确认）：');
  badRefs.forEach((f) => console.log('    · ' + f));
} else {
  console.log('  ✓ 无内部资料路径/人名引用');
}

/* 5) 阻断项：这几类命中就是「不能发」，pack.js 会据此拒绝打包。
   （原来这里只报告不阻断，结果 patch 里带开发机绝对路径照样进了包 ——
     那个文件在别人机器上会让内核整个起不来，用户只看到「Agent 运行失败」。）

   注意「开发机路径」这一项的写法：**不把本机路径/用户名/工作区名写进本文件**，
   而是运行时从 __dirname 推导出当前项目路径，再检查有没有文件把它写死了。
   否则这个检查脚本自己就成了泄露源（刚踩过这个坑）。 */
const PARENT = path.dirname(ROOT);
const SELF_PATHS = [ROOT, ROOT.replace(/\\/g, '/'), PARENT, PARENT.replace(/\\/g, '/')]
  .filter((s) => s && s.length > 3);

const BLOCKERS = [
  ['API Key 形态（sk-…）', /sk-[A-Za-z0-9_-]{20,}/g],
  ['真实用户目录（非占位）', /[A-Za-z]:\\Users\\(?!你的用户名)/g],
];
const extra = (process.env.ACADEMY_SELF_PATTERNS || '').split(',').map((s) => s.trim()).filter(Boolean);
extra.forEach((p) => BLOCKERS.push(['自定义（ACADEMY_SELF_PATTERNS）', new RegExp(p, 'g')]));

const blockers = [];
for (const file of files) {
  if (file === SELF) continue;
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  if (!text) continue;
  for (const [label, re] of BLOCKERS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) blockers.push(path.relative(ROOT, file) + ' → ' + label + '：' + m[0].slice(0, 60));
  }
  const leaked = SELF_PATHS.find((p) => text.indexOf(p) !== -1);
  if (leaked) blockers.push(path.relative(ROOT, file) + ' → 写死了本机项目路径：' + leaked);
}
console.log('');
if (blockers.length) {
  console.log('  ❌ 阻断项命中（不允许打包）：');
  blockers.forEach((b) => console.log('    · ' + b));
  console.log('  修正后重新运行；确认误报可用 ACADEMY_SKIP_SANITIZE_BLOCK=1 放行（不推荐）。');
} else {
  console.log('  ✓ 阻断项检查通过（无 API Key / 无开发机路径 / 无真实用户目录）');
}

console.log('== 开源合规检查完成 ==');
console.log('  提示：许可证采用 CC BY-NC-SA 4.0，知识库来源署名见各文件头部与 LICENSE.md。');

if (blockers.length && process.env.ACADEMY_SKIP_SANITIZE_BLOCK !== '1') {
  process.exit(1);
}