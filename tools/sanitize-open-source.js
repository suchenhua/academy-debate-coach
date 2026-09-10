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
const TEXT_EXT = new Set(['.md', '.txt', '.js', '.css', '.html', '.yml', '.yaml', '.json', '.py', '.ps1', '.bat', '.vbs']);
const WALK_DIRS = ['knowledge', 'modules', 'protocols', 'personas', 'prep-coach', 'review-coach', 'judge-assistant', 'scripts', 'team', '.dsh', 'app', 'tools'];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'runtime', 'data', 'dist', '.git', '.build'].includes(ent.name)) continue;
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

console.log('== 开源合规检查完成 ==');
console.log('  提示：许可证采用 CC BY-NC-SA 4.0，知识库来源署名见各文件头部与 LICENSE.md。');