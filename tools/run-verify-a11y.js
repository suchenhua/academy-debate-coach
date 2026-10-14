#!/usr/bin/env node
/* 一键跑 F2/F4/F5/F6 渲染验证：verify-a11y-hardening.js 必须用 electron.exe 跑
 * （要真渲染进程），而 node_modules 里没有 electron 包，直接 node 会 Cannot find module。
 * 用法：node tools/run-verify-a11y.js
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const electronExe = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) { console.log('✗ 找不到 Electron：' + electronExe); process.exit(1); }
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;   // 留着它，electron.exe 就当 node 用，开不了窗口
const r = spawnSync(electronExe, [path.join(__dirname, 'verify-a11y-hardening.js'), ROOT], {
  cwd: ROOT, env, stdio: 'inherit', timeout: 300000
});
if (r.error) console.log('✗ 执行失败: ' + r.error.message);
console.log('退出码 ' + r.status);
process.exit(r.status === 0 ? 0 : 1);
