/*
 * setup-runtime.js
 * 把已验证可用的 DSH 扁平内核 + node.exe 复制进 App（一次性，存在则跳过）。
 * 用法：
 *   node tools/setup-runtime.js
 *   ACADEMY_DSH_SOURCE=D:\other\runtime node tools/setup-runtime.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = process.env.ACADEMY_DSH_SOURCE || 'D:\\AI\\H\\ai-forum\\runtime';
/* DSH 内核两种布局都要认：新版扁平 runtime/dsh/@deepseek-ai/...，旧版嵌套 runtime/dsh/node_modules/@deepseek-ai/... */
const DSH_BIN_CANDIDATES = [
  path.join(ROOT, 'runtime', 'dsh', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  path.join(ROOT, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
];
const DSH_BIN = DSH_BIN_CANDIDATES.find((p) => fs.existsSync(p)) || DSH_BIN_CANDIDATES[1];
const NODE_EXE = path.join(ROOT, 'runtime', 'node', 'node.exe');

/* 大目录复制优先用 robocopy（已验证；Node cpSync 在某些受限环境会失败） */
function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  if (process.platform === 'win32') {
    const r = spawnSync('robocopy', [src, dst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NP'], { stdio: 'inherit', windowsHide: true });
    if (r.error) throw r.error;
    if (r.status > 7) throw new Error('robocopy exit ' + r.status);
    return;
  }
  fs.cpSync(src, dst, { recursive: true, force: true });
}

function sizeOf(dir) {
  let total = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += sizeOf(p);
    else if (ent.isFile()) total += ent.size || 0;
  }
  return total;
}

console.log('== Academy 辩论教练 · 准备运行内核 ==');
console.log('来源:', SOURCE);

if (!fs.existsSync(DSH_BIN)) {
  const srcDsh = path.join(SOURCE, 'dsh');
  const srcOk = [
    path.join(srcDsh, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(srcDsh, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].some((p) => fs.existsSync(p));
  if (!srcOk) {
    console.error('✗ 源 DSH 内核不完整:', srcDsh);
    process.exit(1);
  }
  const t = Date.now();
  console.log('复制 DSH 内核（约 245MB，需要几分钟）…');
  copyDir(srcDsh, path.join(ROOT, 'runtime', 'dsh'));
  console.log('  ✓ DSH 内核复制完成，用时', ((Date.now() - t) / 1000).toFixed(1), '秒');
} else {
  console.log('  ✓ DSH 内核已存在，跳过');
}

if (!fs.existsSync(NODE_EXE)) {
  const srcNode = path.join(SOURCE, 'node', 'node.exe');
  if (!fs.existsSync(srcNode)) { console.error('✗ 找不到 node.exe:', srcNode); process.exit(1); }
  fs.copyFileSync(srcNode, NODE_EXE);
  console.log('  ✓ node.exe 复制完成');
} else {
  console.log('  ✓ node.exe 已存在，跳过');
}

if (!fs.existsSync(DSH_BIN) || !fs.existsSync(NODE_EXE)) {
  console.error('✗ 校验失败');
  process.exit(1);
}
console.log('运行内核: ' + (sizeOf(path.join(ROOT, 'runtime')) / 1024 / 1024).toFixed(1) + ' MB');
console.log('== 完成 ==');
