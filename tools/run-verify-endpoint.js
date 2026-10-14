#!/usr/bin/env node
/* 一键跑 F3 服务商地址护栏验证（需要真渲染进程，所以必须用 electron.exe）。
 * 用法：node tools/run-verify-endpoint.js
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const electronExe = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) { console.log('✗ 找不到 Electron：' + electronExe); process.exit(1); }
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(electronExe, [path.join(__dirname, 'verify-endpoint-guard.js'), ROOT], { cwd: ROOT, env, stdio: 'inherit', timeout: 300000 });
if (r.error) console.log('✗ 执行失败: ' + r.error.message);
console.log('退出码 ' + r.status);
process.exit(r.status === 0 ? 0 : 1);
