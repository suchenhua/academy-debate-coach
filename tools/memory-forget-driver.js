'use strict';
/* FORGET 撤回内核的测试驱动器。
   用法：node tools/memory-forget-driver.js <关键词>
   数据目录由环境变量 ACADEMY_DATA_DIR 指定（隔离，不碰真实记忆）。 */
const forget = require('../app/server.js').memoryForget;
const r = forget(process.argv[2] || '');
process.stdout.write(JSON.stringify(r));
process.exit(0);   // server.js 被连带 require 会开始 listen，抢在之前退场
