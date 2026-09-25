'use strict';
/* C 档影子快照内核的测试驱动器。
   用法：node tools/shadow-driver.js <snapshot|list|restore> [快照id]
   数据目录由环境变量 ACADEMY_DATA_DIR 指定（隔离，不碰真实产物）。
   注意：server.js 的 [shadow] 日志也走 stdout，结果取最后一行 JSON。 */
const api = require('../app/server.js').deliverShadow;
const op = process.argv[2] || 'list';
let r;
if (op === 'snapshot') r = api.snapshot(process.argv[3] || 'snap-' + Date.now().toString(36));
else if (op === 'restore') r = api.restore(process.argv[3] || '');
else r = { ok: true, items: api.list() };
process.stdout.write(JSON.stringify(r));
process.exit(0);   // server.js 被连带 require 会开始 listen，抢在之前退场
