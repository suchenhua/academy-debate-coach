#!/usr/bin/env node
/*
 * prune-runtime.js — 裁剪内置 DSH 内核里「运行时用不到、且可再生成」的文件，减小分发包体积。
 *
 * 只删这些扩展名（都是开发期资料，运行时只加载 .js/.mjs/.cjs）：
 *   .map 源映射 · .ts/.mts/.cts 类型与源码 · .pdb 调试符号 · .md 文档 · .cc/.h/.hh C++ 源码
 *
 * 三道安全护栏：
 *   1. 永不删 LICENSE / LICENCE / COPYING / NOTICE / AUTHORS / CONTRIBUTORS 类文件（合规）；
 *   2. .ts / .mts / .cts 必须存在同名 .js/.mjs/.cjs 兄弟文件才删——否则可能是被 tsx 直接加载的
 *      唯一实现，一律保留并打印出来；
 *   3. DSH 部分只动 runtime/dsh，不碰 runtime/node、app、knowledge；
 *      Electron 部分只删 dist/locales 里未保留的 .pak。
 *
 * 另外裁剪 Electron 未使用的界面语言包（只保留 en-US / zh-CN / zh-TW，缺的语言 Chromium 自动回退）。
 *
 * 用法：
 *   node tools/prune-runtime.js          # 实际裁剪
 *   node tools/prune-runtime.js --dry    # 只看会删什么，不动文件
 *
 * 打包脚本（tools/pack.js）会自动调用本脚本，所以升级内核 / 重新下载 Electron 之后
 * 不需要手工重跑 —— 下次打包会重新裁一遍。
 * 可逆：node tools/upgrade-dsh.js <版本> 重装完整内核；Electron 的 locale 从官方包再取。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DSH = path.join(ROOT, 'runtime', 'dsh');
const DRY = process.argv.includes('--dry');

const PRUNE_EXT = new Set(['.map', '.pdb', '.md', '.markdown', '.cc', '.hh', '.h']);
const KEEP_RE = /^(license|licence|copying|notice|authors|contributors)/i;

/* 识别 TS 系文件（含 .d.ts / .d.mts / .d.cts），返回去掉后缀的词干 + 该词干应当存在的 JS 兄弟后缀。
   顺序很重要：.d.ts 必须先于 .ts 匹配。 */
const TS_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts', '.ts', '.mts', '.cts'];
const TS_SIBLINGS = {
  '.d.ts': ['.js', '.mjs', '.cjs'], '.d.mts': ['.mjs', '.js'], '.d.cts': ['.cjs'],
  '.ts': ['.js', '.mjs', '.cjs'], '.mts': ['.mjs', '.js'], '.cts': ['.cjs'],
};
function classifyTs(name) {
  const lower = name.toLowerCase();
  for (const suf of TS_SUFFIXES) {
    if (lower.endsWith(suf)) return { ext: suf, stem: name.slice(0, name.length - suf.length), siblings: TS_SIBLINGS[suf] };
  }
  return null;
}

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

function fmt(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }

function main() {
  if (!fs.existsSync(DSH)) { console.error('✗ 找不到 ' + DSH); process.exit(1); }
  console.log((DRY ? '== 预演（不会改动文件）==' : '== 裁剪 runtime/dsh =='));

  const all = [];
  walk(DSH, all);
  const beforeBytes = all.reduce((s, p) => s + (fs.statSync(p).size || 0), 0);

  const del = [];
  const byExt = new Map();
  let keptLicense = 0;
  const tsNoSibling = [];

  for (const p of all) {
    const name = path.basename(p);
    if (KEEP_RE.test(name)) { keptLicense++; continue; }
    const ts = classifyTs(name);
    const ext = ts ? ts.ext : path.extname(name).toLowerCase();
    if (!ts && !PRUNE_EXT.has(ext)) continue;
    if (ts) {
      const dir = path.dirname(p);
      const hasSibling = ts.siblings.some((sfx) => fs.existsSync(path.join(dir, ts.stem + sfx)));
      if (!hasSibling) { tsNoSibling.push(path.relative(ROOT, p)); continue; }
    }
    let size = 0;
    try { size = fs.statSync(p).size; } catch (_) {}
    del.push(p);
    byExt.set(ext, (byExt.get(ext) || 0) + size);
  }

  const delBytes = del.reduce((s, p) => { try { return s + fs.statSync(p).size; } catch (_) { return s; } }, 0);
  console.log('\n将删除 ' + del.length.toLocaleString() + ' 个文件 / ' + fmt(delBytes));
  for (const [ext, bytes] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  ' + ext.padEnd(8) + fmt(bytes));
  }
  console.log('保留合规文件（LICENSE 等）：' + keptLicense + ' 个');
  console.log('.ts/.mts/.cts 无同名 JS 兄弟、已保留：' + tsNoSibling.length + ' 个');
  for (const r of tsNoSibling.slice(0, 15)) console.log('    · ' + r);
  if (tsNoSibling.length > 15) console.log('    · …（其余 ' + (tsNoSibling.length - 15) + ' 个省略）');

  // ---- Electron 未使用的界面语言包（缺的语言 Chromium 会回退到 en-US） ----
  const EL_KEEP = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
  const elDir = path.join(ROOT, 'runtime', 'electron', 'dist', 'locales');
  let elN = 0, elBytes = 0;
  if (fs.existsSync(elDir)) {
    for (const e of fs.readdirSync(elDir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.pak') || EL_KEEP.has(e.name)) continue;
      const p = path.join(elDir, e.name);
      let sz = 0;
      try { sz = fs.statSync(p).size; } catch (_) {}
      if (DRY) { elN++; elBytes += sz; continue; }
      try { fs.unlinkSync(p); elN++; elBytes += sz; } catch (_) {}
    }
    console.log('\nElectron locale：删除 ' + elN + ' 个未用语言包 / ' + fmt(elBytes) + '（保留 en-US / zh-CN / zh-TW）');
  }

  if (!DRY) {
    let failed = 0;
    for (const p of del) { try { fs.unlinkSync(p); } catch (_) { failed++; } }
    let now = 0;
    const rest = [];
    walk(DSH, rest);
    for (const p of rest) { try { now += fs.statSync(p).size; } catch (_) {} }
    console.log('\nDSH 完成：' + fmt(beforeBytes) + ' → ' + fmt(now) + '（省 ' + fmt(beforeBytes - now) + '）');
    if (failed) console.log('（' + failed + ' 个文件删除失败，通常是被占用，可关闭相关进程后重跑）');
  } else {
    console.log('\n预演结束。去掉 --dry 即执行。');
    console.log('预计：DSH ' + fmt(beforeBytes) + ' → ' + fmt(beforeBytes - delBytes));
  }
}

main();
