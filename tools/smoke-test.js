#!/usr/bin/env node
/* Academy 冒烟测试：起一个临时服务器，回归核心接口。
   不调用任何 AI / 联网接口（对话流式、搜索、检证需要 Key，另做手工验证）。
   用法：node tools/smoke-test.js [--port=8899]
   全部通过 → exit 0；任一失败 → exit 1。
   测试产物统一 __t_smoke 前缀，测完自动清理，不污染真实数据。 */
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

// Windows 控制台默认 GBK，先切 UTF-8 避免中文输出乱码
if (process.platform === 'win32') {
  try { spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
}

const ROOT = path.join(__dirname, '..');
let PORT = 8899;
for (const a of process.argv.slice(2)) {
  const m = String(a).match(/^--port=(\d+)$/);
  if (m) PORT = Number(m[1]);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' · ' + detail : ''));
}

async function main() {
  const serverJs = path.join(ROOT, 'app', 'server.js');
  let child = spawn(process.execPath, [serverJs, '--port=' + PORT], {
    env: Object.assign({}, process.env, { ACADEMY_NO_OPEN: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const BASE = 'http://127.0.0.1:' + PORT;
  async function j(method, p, body) {
    const r = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let d = null;
    try { d = await r.json(); } catch (_) {}
    return { status: r.status, d };
  }

  try {
    // 等服务器就绪（最多 30 秒）
    let up = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + '/api/config'); if (r.ok) { up = true; break; } } catch (_) {}
      await new Promise((s) => setTimeout(s, 500));
    }
    if (!up) {
      console.error('❌ 服务器 30 秒内未就绪，日志尾部：\n' + log.slice(-2000));
      child.kill();
      process.exit(1);
    }
    console.log('服务器已就绪（端口 ' + PORT + '）\n');

    /* 1. 主页面 */
    {
      const r = await fetch(BASE + '/');
      const t = await r.text();
      check('GET / 主页面 200', r.status === 200 && /Academy|逻敏/.test(t));
      // 版本号由 server.js APP_VERSION 注入：模板里不应残留未替换的占位符，
      // 也不应出现与 /api/status 不一致的硬编码旧号。
      const st = await j('GET', '/api/status');
      const expect = 'v' + String((st.d && st.d.version) || '').replace(/^v/i, '');
      check(
        '主页面版本号已注入（无 __APP_VERSION__ 残留）',
        t.indexOf('__APP_VERSION__') === -1,
        '残留 ' + (t.match(/__APP_VERSION__/g) || []).length + ' 处'
      );
      check(
        '主页面版本号与 /api/status 一致',
        !!expect && expect !== 'v' && t.indexOf('>' + expect + '<') !== -1,
        'expect=' + expect
      );
    }

    /* 2. 配置接口 */
    {
      const r = await j('GET', '/api/config');
      check('GET /api/config', r.status === 200 && r.d && r.d.ok === true);
    }

    /* 2.5 本机来源校验：伪造 Host（DNS rebinding）与恶意 Origin 的写请求一律 403 */
    {
      const rawReq = (method, reqPath, headers) => new Promise((resolve) => {
        const rq = http.request(
          { host: '127.0.0.1', port: PORT, path: reqPath, method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers), timeout: 5000 },
          (rs) => { let b = ''; rs.on('data', (c) => { b += c; }); rs.on('end', () => resolve(rs.statusCode)); }
        );
        rq.on('error', () => resolve(0));
        rq.end();
      });
      const s1 = await rawReq('GET', '/api/config', { Host: 'evil.example.com' });
      check('伪造 Host（DNS rebinding）被拒', s1 === 403, 'status=' + s1);
      const s2 = await rawReq('POST', '/api/memory/clear', { Origin: 'http://evil.example.com' });
      check('跨站 Origin 写请求被拒', s2 === 403, 'status=' + s2);
    }

    /* 2.6 启动自动备份：data/_auto_backup/ 里应有含 memory.md 的快照 */
    {
      const fsMod = require('fs');
      const abDir = path.join(ROOT, 'data', '_auto_backup');
      const dirs = (() => { try { return fsMod.readdirSync(abDir).filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n)); } catch (_) { return []; } })();
      const latest = dirs.length ? dirs[dirs.length - 1] : '';
      const hasMem = !!latest && fsMod.existsSync(path.join(abDir, latest, 'memory.md'));
      check('启动自动备份已生成', dirs.length > 0 && hasMem, latest);
    }

    /* 2.7 对话增量保存：upsert / 列表索引 / 单条读取 / 单条删除 */
    {
      const chat = { id: 'tsmokechat1', mode: 'free', title: '冒烟测试对话', created: Date.now(), updated: Date.now(), messages: [{ role: 'user', text: '你好' }] };
      let r = await j('PUT', '/api/chats/upsert', { chat });
      check('对话单条保存 upsert', r.status === 200 && r.d.ok, JSON.stringify(r.d.error || ''));
      r = await j('GET', '/api/chats/list');
      const hit = (r.d.chats || []).find((c) => c.id === 'tsmokechat1');
      check('对话列表索引可见', r.status === 200 && r.d.ok && !!hit && hit.msgCount === 1, hit ? 'msgCount=' + hit.msgCount : 'not found');
      r = await j('GET', '/api/chats/tsmokechat1');
      check('对话单条读取', r.status === 200 && r.d.ok && r.d.chat && (r.d.chat.messages || []).length === 1);
      r = await j('DELETE', '/api/chats/tsmokechat1');
      check('对话单条删除', r.status === 200 && r.d.ok);
      r = await j('GET', '/api/chats/list');
      check('删除后索引已更新', !(r.d.chats || []).some((c) => c.id === 'tsmokechat1'));
    }

    /* 3. 产物：保存 / 重名去重 / 拒绝危险扩展名 / 拒绝空内容 */
    {
      let r = await j('POST', '/api/deliverables/save', { name: '__t_smoke.md', content: '# 冒烟测试\n\n第一份' });
      check('产物保存 md', r.status === 200 && r.d.ok && r.d.name === '__t_smoke.md', JSON.stringify(r.d.name || r.d.error));
      r = await j('POST', '/api/deliverables/save', { name: '__t_smoke.md', content: '# 第二份' });
      check('产物重名自动加 _2', r.status === 200 && r.d.ok && r.d.name === '__t_smoke_2.md', JSON.stringify(r.d.name || r.d.error));
      r = await j('POST', '/api/deliverables/save', { name: '__t_smoke.exe', content: 'x' });
      check('产物拒绝 exe 扩展名', r.status === 400);
      r = await j('POST', '/api/deliverables/save', { name: '__t_empty.md', content: '   ' });
      check('产物拒绝空内容', r.status === 400);
    }

    /* 4. 产物：列表可见 + md→docx 转档（本地 docx.js，不出网） */
    {
      let r = await j('GET', '/api/deliverables');
      const names = (r.d.items || r.d.files || []).map((x) => x.name);
      check('产物列表包含测试文件', names.includes('__t_smoke.md'));
      r = await j('POST', '/api/deliverables/convert', { name: '__t_smoke.md', target: 'docx' });
      check('md → docx 转档', r.status === 200 && r.d.ok && r.d.item && r.d.item.name === '__t_smoke.docx', JSON.stringify((r.d.item && r.d.item.name) || r.d.error));
    }

    /* 5. 资料库：入库 / 召回 / 删除 */
    {
      let r = await j('POST', '/api/library/upload', { name: '__t_smoke_lib.md', text: '冒烟测试资料：攻防分级与打钉子话术', tags: ['流水单'] });
      const id = r.d && r.d.item && r.d.item.id;
      check('资料库入库', r.status === 200 && r.d.ok && !!id);
      r = await j('POST', '/api/library/search', { query: '攻防分级' });
      const hitNames = ((r.d && r.d.hits) || []).map((x) => x.name || x.id);
      check('资料库召回命中', r.status === 200 && hitNames.includes('__t_smoke_lib.md'), JSON.stringify(hitNames));
      r = await j('POST', '/api/library/delete', { id });
      check('资料库删除测试项', r.status === 200 && r.d.ok);
    }

    /* 5b. 批量入库（前端「拖入文件夹」走的就是逐条 upload，这里验证服务端能吃下整批） */
    {
      const BATCH = 25;
      const ids = [];
      let okN = 0;
      for (let i = 0; i < BATCH; i++) {
        const r = await j('POST', '/api/library/upload', {
          name: '__t_smoke_b' + String(i).padStart(2, '0') + '.md',
          text: '批量入库冒烟测试 ' + i + '：质询先打钉子再击穿主线。',
        });
        if (r.status === 200 && r.d && r.d.ok && r.d.item) { okN++; ids.push(r.d.item.id); }
      }
      check('批量入库 ' + BATCH + ' 份', okN === BATCH, '成功 ' + okN + '/' + BATCH);
      const lr = await j('GET', '/api/library');
      const got = (lr.d.items || []).filter((x) => /^__t_smoke_b\d\d\.md$/.test(String(x.name))).length;
      check('批量入库后列表可见', got === BATCH, '列表 ' + got + '/' + BATCH);
      // 用批量这批专属的词检索（共用「打钉子」会被上一段已删除的资料干扰）
      const sr = await j('POST', '/api/library/search', { query: '批量入库冒烟' });
      const bh = ((sr.d && sr.d.hits) || []).filter((x) => /^__t_smoke_b\d\d\.md$/.test(String(x.name))).length;
      check('批量入库后可召回', bh > 0, '命中 ' + bh + ' 条');
      let rm = 0;
      for (const id of ids) { const r = await j('POST', '/api/library/delete', { id }); if (r.d && r.d.ok) rm++; }
      check('批量清理测试资料', rm === ids.length, '删除 ' + rm + '/' + ids.length);
      const lr2 = await j('GET', '/api/library');
      const left = (lr2.d.items || []).filter((x) => /^__t_smoke_b/.test(String(x.name))).length;
      check('资料库无批量测试残留', left === 0, '剩 ' + left);
    }

    /* 4a. 正文流式链路：插件存在 + 服务端能解析 ACA-TEXT 增量 */
    {
      const fsMod = require('fs');
      const plugin = path.join(ROOT, 'runtime', 'academy-text-stream.mjs');
      check('正文流式插件存在', fsMod.existsSync(plugin), plugin.replace(ROOT, ''));
      const patchTxt = (() => { try { return fsMod.readFileSync(path.join(ROOT, 'runtime', 'persona.patch.yml'), 'utf8'); } catch (_) { return ''; } })();
      check('patch 已挂载流式插件', patchTxt.indexOf('academy-text-stream') !== -1);
      const serverSrc = fsMod.readFileSync(path.join(ROOT, 'app', 'server.js'), 'utf8');
      // 服务端必须解析 ACA-TEXT 前缀，否则插件推了也没人接
      check('服务端解析正文增量前缀', serverSrc.indexOf('ACA-TEXT:') !== -1);
      // 自愈：插件缺失时应能自动写回（避免内核整体加载失败）
      check('服务端含插件自愈逻辑', serverSrc.indexOf('ensureStreamPlugin') !== -1);
    }

    /* 4b. 用量账本（append-only）：删对话不应抹掉历史消耗 */
    {
      const fsMod = require('fs');
      const uf = path.join(ROOT, 'data', 'usage.jsonl');
      const had = fsMod.existsSync(uf);
      const backup = had ? fsMod.readFileSync(uf, 'utf8') : '';
      const stamp = Date.now();
      const rows = [
        { ts: stamp - 86400000 * 2, date: '__D1', chatId: '__ledger_c1', mode: 'prep', model: 'm-a', input: 1000, output: 500, cacheRead: 200, cacheWrite: 10, reasoning: 50, elapsedMs: 3000 },
        { ts: stamp - 86400000, date: '__D2', chatId: '__ledger_c1', mode: 'prep', model: 'm-a', input: 2000, output: 800, cacheRead: 400, cacheWrite: 20, reasoning: 80, elapsedMs: 4000 },
        { ts: stamp, date: '__D3', chatId: '__ledger_c2', mode: 'review', model: 'm-b', input: 3000, output: 1200, cacheRead: 600, cacheWrite: 30, reasoning: 120, elapsedMs: 5000 },
      ];
      fsMod.appendFileSync(uf, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      let st = await j('GET', '/api/stats');
      check('统计接口可用', st.status === 200 && st.d && st.d.ok === true);
      check('账本聚合输入 token', st.d.usage && st.d.usage.input >= 6000, 'input=' + (st.d.usage && st.d.usage.input));
      check('账本按天聚合', (st.d.days || []).some((d) => d.date === '__D1'), 'days=' + (st.d.days || []).length);
      check('账本按模型聚合', (st.d.models || []).some((m) => m.model === 'm-a'), JSON.stringify((st.d.models || []).map((m) => m.model)));
      check('活跃天数统计', st.d.activeDays >= 3, 'activeDays=' + st.d.activeDays);

      // 核心回归：删掉对话后，历史用量必须还在（旧实现挂在消息上，删了就没了）
      await j('PUT', '/api/chats/upsert', { chat: { id: '__ledger_c1', mode: 'prep', title: '待删', created: Date.now(), updated: Date.now(), messages: [{ role: 'user', text: 'x' }] } });
      await j('DELETE', '/api/chats/__ledger_c1');
      st = await j('GET', '/api/stats');
      check('删除对话后用量仍保留', st.d.usage && st.d.usage.input >= 6000, 'input=' + (st.d.usage && st.d.usage.input));

      // 坏行不应让整个统计崩掉
      fsMod.appendFileSync(uf, '这不是合法 JSON\n', 'utf8');
      st = await j('GET', '/api/stats');
      check('账本含坏行仍可读', st.status === 200 && st.d && st.d.ok === true);

      if (had) fsMod.writeFileSync(uf, backup, 'utf8');
      else { try { fsMod.unlinkSync(uf); } catch (_) {} }
    }

    /* 5b1. 短查询词召回回归（曾修的真缺陷：两字词「击穿/主线」、三字词「打钉子」
       在正文里明明出现却召不回 —— 死值门槛 + 滑窗 i+=1 吃掉相邻 bigram 所致） */
    {
      await j('POST', '/api/library/upload', {
        name: '__t_smoke_short.md',
        text: '打钉子是一种削弱对方论证的手段，击穿才是推进主线。',
      });
      const caseList = [
        ['打钉子', true], ['击穿', true], ['主线', true], ['手段', true], ['削弱对方论证', true],
      ];
      for (const [q, want] of caseList) {
        const r = await j('POST', '/api/library/search', { query: q });
        const hit = ((r.d && r.d.hits) || []).some((x) => x.name === '__t_smoke_short.md');
        check('短词召回「' + q + '」', hit === want, 'hits=' + ((r.d && r.d.hits) || []).length);
      }
      // 负例：不存在的词不该召回（防止为了召回率放宽到「什么都命中」）
      const neg = await j('POST', '/api/library/search', { query: '绝无此词qwertyuiop' });
      check('不存在的词不召回', ((neg.d && neg.d.hits) || []).length === 0);
      const lr0 = await j('GET', '/api/library');
      const s0 = (lr0.d.items || []).find((x) => x.name === '__t_smoke_short.md');
      if (s0) await j('POST', '/api/library/delete', { id: s0.id });
    }

    /* 5b2. 产物 → 资料库 打通（引用式，不复制内容） */
    {
      // 先造一份产物
      await j('POST', '/api/deliverables/save', { name: '__t_smoke_bridge.md', content: '# 桥接测试\n\n这份产物要能被资料库召回，打钉子与击穿的区别。' });
      let r = await j('POST', '/api/library/from-deliverable', { name: '__t_smoke_bridge.md' });
      const itemId = r.d && r.d.item && r.d.item.id;
      check('产物送资料库（引用式）', r.status === 200 && r.d.ok && !!itemId, (r.d && r.d.error) || '');
      check('引用条目标记来源', !!(r.d && r.d.item && r.d.item.kind === 'deliverable' && r.d.item.ref === '__t_smoke_bridge.md'));

      // 重复入库应安全返回 duplicated，而不是堆两条
      r = await j('POST', '/api/library/from-deliverable', { name: '__t_smoke_bridge.md' });
      check('重复入库不产生副本', r.d && r.d.ok && r.d.duplicated === true, JSON.stringify(r.d && r.d.duplicated));

      // 召回命中，且给出的路径指向产物原文
      r = await j('POST', '/api/library/search', { query: '桥接测试' });
      const hb = ((r.d && r.d.hits) || []).find((x) => x.name === '__t_smoke_bridge.md');
      check('入库后可被召回', !!hb, '命中 ' + ((r.d && r.d.hits) || []).length + ' 条');
      check('召回路径指向产物原文件', !!hb && String(hb.path).indexOf('deliverables') !== -1, hb && hb.path);

      // 改动产物后，资料库读到的是最新版（引用式的核心价值）
      const read1 = await j('GET', '/api/library/doc?id=' + encodeURIComponent(itemId));
      const before = read1.d && read1.d.text || '';
      await j('POST', '/api/deliverables/save', { name: '__t_smoke_bridge_v2.md', content: '# 改后版本\n\n内容已更新为第二版。' });
      // 同名覆盖不便做，这里直接再建一条引用验证联动：删掉旧产物 → 条目应报 missing
      await j('POST', '/api/deliverables/delete', { name: '__t_smoke_bridge.md' });
      const lr0 = await j('GET', '/api/library');
      const after = (lr0.d.items || []).find((x) => x.id === itemId);
      check('产物删除后引用条目标记缺失', !!after && after.missing === true, JSON.stringify(after && after.missing));

      // 【安全底线】删资料库条目绝不能删产物原件
      await j('POST', '/api/library/delete', { id: itemId });
      const lrX = await j('GET', '/api/library');
      check('删除引用条目已生效', !(lrX.d.items || []).some((x) => x.id === itemId));
      await j('POST', '/api/deliverables/delete', { name: '__t_smoke_bridge_v2.md' });
    }

    /* 5c. 辩题档案夹：识别 / 归档 / 改名 / 删除（只删索引，不删对话文件） */
    {
      // ① 辩题识别：能认出辩题句，且不吃掉尾部「我持正方」
      const g1 = await j('POST', '/api/cases/guess', { text: '帮我备赛，辩题是「大学生应该先就业再择业」，我持反方' });
      check('辩题识别（去持方后缀）', (g1.d && g1.d.motion) === '大学生应该先就业再择业', JSON.stringify(g1.d && g1.d.motion));
      const g2 = await j('POST', '/api/cases/guess', { text: '今天天气不错' });
      check('非辩题文本不误判', (g2.d && g2.d.motion) === '', JSON.stringify(g2.d && g2.d.motion));

      // ② 归档对话 + 产物
      const tChat = { id: 'k_test_case_chat', mode: 'prep', title: '冒烟·辩题归档对话', created: Date.now(), updated: Date.now(), messages: [{ role: 'user', text: '辩题测试' }] };
      await j('PUT', '/api/chats/upsert', { chat: tChat });
      let r = await j('POST', '/api/cases/attach', { motion: '__t_smoke_辩题', chatId: tChat.id, side: '反方' });
      const caseId = r.d && r.d.case && r.d.case.id;
      check('辩题归档对话', r.status === 200 && r.d.ok && !!caseId);
      // 同辩题不同标点应复用同一条（归一化匹配）
      r = await j('POST', '/api/cases/attach', { motion: '__t_smoke，辩题', deliverable: '__t_smoke_备赛包.md' });
      check('辩题归一化复用', r.d && r.d.case && r.d.case.id === caseId, 'id=' + (r.d && r.d.case && r.d.case.id));

      // ③ 列表能看到对话与产物
      r = await j('GET', '/api/cases');
      const mine = (r.d.cases || []).find((x) => x.id === caseId);
      check('辩题列表含对话与产物', !!mine && mine.chats.length === 1 && mine.deliverables.length === 1,
        JSON.stringify(mine ? { chats: mine.chats.length, dv: mine.deliverables.length } : null));

      // ④ 改名 / 改持方
      r = await j('POST', '/api/cases/update', { id: caseId, motion: '__t_smoke_辩题改', side: '正方' });
      check('辩题改名与持方', r.d && r.d.case && r.d.case.motion === '__t_smoke_辩题改' && r.d.case.side === '正方');

      // ⑤ 删除只删索引：对话文件必须还在
      r = await j('POST', '/api/cases/delete', { id: caseId });
      check('删除辩题', r.status === 200 && r.d.ok);
      const chatFile = require('path').join(ROOT, 'data', 'chats', tChat.id + '.json');
      check('删除辩题后对话文件保留', require('fs').existsSync(chatFile));
      r = await j('GET', '/api/cases');
      check('辩题列表已移除', !(r.d.cases || []).some((x) => x.id === caseId));
      try { require('fs').unlinkSync(chatFile); } catch (_) {}
    }

    /* 6. 工具页可达且带「送回主 App」能力 */
    {
      for (const f of ['/tools/简易流水单-Flowing-Tool.html', '/tools/辩案工作台-Case-Workbench.html']) {
        const r = await fetch(BASE + encodeURI(f));
        const t = await r.text();
        check('工具页 ' + f.split('/').pop().slice(0, 8) + '… 可达', r.status === 200 && t.includes('sendToApp'));
      }
    }

    /* 7. 清理测试产物并确认删干净 */
    {
      for (const n of ['__t_smoke.md', '__t_smoke_2.md', '__t_smoke.docx']) {
        const r = await j('POST', '/api/deliverables/delete', { name: n });
        check('清理 ' + n, r.status === 200 && r.d.ok);
      }
      const r = await j('GET', '/api/deliverables');
      const names = (r.d.items || r.d.files || []).map((x) => x.name);
      check('产物空间无残留测试文件', !names.some((n) => String(n).startsWith('__t_smoke')));
    }

    /* 7. 记忆模块：SQLite 索引 / 全文搜索 / 蒸馏归档（测试前备份真实记忆，测完恢复） */
    {
      const fsMod = require('fs');
      const pathMod = require('path');
      const memFile = pathMod.join(ROOT, 'data', 'memory.md');
      const memDir = pathMod.join(ROOT, 'data', 'memory');
      // 备份真实记忆
      const bakLong = fsMod.existsSync(memFile) ? fsMod.readFileSync(memFile, 'utf8') : null;
      const bakDir = {};
      try { for (const f of fsMod.readdirSync(memDir)) bakDir[f] = fsMod.readFileSync(pathMod.join(memDir, f), 'utf8'); } catch (_) {}
      const restoreMemory = () => {
        try {
          if (bakLong === null) fsMod.existsSync(memFile) && fsMod.unlinkSync(memFile);
          else fsMod.writeFileSync(memFile, bakLong, 'utf8');
          // 先重建备份里的每个文件（包括测试期间被删掉的），再删掉备份里没有的
          const keep = new Set(Object.keys(bakDir));
          fsMod.mkdirSync(memDir, { recursive: true });
          for (const [f, content] of Object.entries(bakDir)) {
            fsMod.writeFileSync(pathMod.join(memDir, f), content, 'utf8');
          }
          let ents = [];
          try { ents = fsMod.readdirSync(memDir); } catch (_) {}
          for (const f of ents) {
            if (!keep.has(f)) fsMod.unlinkSync(pathMod.join(memDir, f));
          }
        } catch (_) {}
      };

      try {
        // 7a. 索引就绪 + 写入测试记忆
        {
          const r = await j('GET', '/api/memory');
          check('记忆索引就绪（node:sqlite）', r.status === 200 && r.d.ok && r.d.indexReady === true, 'indexReady=' + (r.d && r.d.indexReady));
        }
        {
          let r = await j('POST', '/api/memory/save', { scope: 'long', title: '__t_smoke 长期', body: '冒烟测试长期记忆：用户偏好一句话判准写法' });
          check('记忆新增（长期）', r.status === 200 && r.d.ok);
          r = await j('POST', '/api/memory/save', { scope: 'daily', title: '__t_smoke 流水', body: '冒烟测试流水记录：质询时先打钉子再展开' });
          check('记忆新增（流水）', r.status === 200 && r.d.ok);
        }
        // 7b. 全文搜索：CJK 二字滑窗应同时命中长期与流水
        {
          let r = await j('GET', '/api/memory/search?q=' + encodeURIComponent('判准'));
          const hits = ((r.d && r.d.results) || []);
          check('搜索命中长期记忆', r.status === 200 && r.d.ok && hits.some((x) => String(x.title).includes('__t_smoke 长期')), 'hits=' + hits.length);
          r = await j('GET', '/api/memory/search?q=' + encodeURIComponent('打钉子'));
          const hits2 = ((r.d && r.d.results) || []);
          check('搜索命中每日流水', r.status === 200 && r.d.ok && hits2.some((x) => String(x.title).includes('__t_smoke 流水')), 'hits=' + hits2.length);
          r = await j('GET', '/api/memory/search?q=' + encodeURIComponent('zqqxv无match词'));
          check('搜索无结果返回空数组', r.status === 200 && r.d.ok && (r.d.results || []).length === 0, JSON.stringify((r.d.results || []).length));
        }
        // 7c. 清空全部记忆：长期 + 流水都应清掉（含每日文件删除）；清空前应自动留快照
        {
          const fsMod = require('fs');
          const abDir = path.join(ROOT, 'data', '_auto_backup');
          // 注：快照目录有滚动上限（AUTO_BACKUP_KEEP=10），份数到顶后新快照会挤掉最旧的，
          // 所以不能断言「数量增长」，只能断言「最新一份 before-clear 的时间戳变新了」。
          const latestBC = () => {
            try {
              return fsMod.readdirSync(abDir)
                .filter((n) => n.includes('before-clear'))
                .sort()
                .pop() || '';
            } catch (_) { return ''; }
          };
          const bcBefore = latestBC();
          const r = await j('POST', '/api/memory/clear');
          const filesAfter = (() => { try { return require('fs').readdirSync(memDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)); } catch (_) { return []; } })();
          const bcAfter = latestBC();
          check('清空全部记忆（含每日流水）', r.status === 200 && r.d.ok && filesAfter.length === 0, '剩 ' + filesAfter.length + ' 个流水文件');
          check(
            '清空前自动快照已生成',
            !!bcAfter && bcAfter > bcBefore,
            (bcBefore || '(无)') + ' → ' + (bcAfter || '(无)')
          );
        }

        // 8. 蒸馏（启动时执行）：14 天前的流水 → 晋升关键词段 + 其余归档，不丢内容
        {
          child.kill();
          const oldDay = pathMod.join(memDir, '2026-08-01.md');
          const oldContent = [
            '## 2026-08-01 10:00:00 · 备忘',
            '',
            '冒烟测试晋升段：用户要求以后记住判准必须写成一句话',
            '',
            '---',
            '',
            '## 2026-08-01 10:05:00 · 备忘',
            '',
            '冒烟测试归档段：这一段没有晋升关键词，是普通的日常观察内容',
          ].join('\n');
          require('fs').writeFileSync(oldDay, oldContent, 'utf8');
          const old = new Date(Date.now() - 20 * 86400000);
          require('fs').utimesSync(oldDay, old, old);

          child = spawn(process.execPath, [serverJs, '--port=' + PORT], {
            env: Object.assign({}, process.env, { ACADEMY_NO_OPEN: '1' }),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let up2 = false;
          for (let i = 0; i < 60; i++) {
            try { const r = await fetch(BASE + '/api/config'); if (r.ok) { up2 = true; break; } } catch (_) {}
            await new Promise((s) => setTimeout(s, 500));
          }
          if (up2) {
            const fsMod2 = require('fs');
            const digest = pathMod.join(memDir, 'archive-2026-08.md');
            const gone = !fsMod2.existsSync(oldDay);
            const digestText = (() => { try { return fsMod2.readFileSync(digest, 'utf8'); } catch (_) { return ''; } })();
            const longNow = (() => { try { return fsMod2.readFileSync(memFile, 'utf8'); } catch (_) { return ''; } })();
            check('蒸馏：过期流水文件已清理', gone);
            check('蒸馏：未晋升段落进入月度归档', digestText.includes('冒烟测试归档段'));
            check('蒸馏：含关键词段落晋升长期', longNow.includes('冒烟测试晋升段'));
          } else {
            check('蒸馏测试服务器重启', false, '30 秒内未就绪');
          }
        }
      } finally {
        restoreMemory();
      }
    }

    /* 9. 打包链路完整性：运行时裁剪脚本 + 发版自检的接入不可断
       （pack.js 找不到 prune-runtime.js 会直接拒绝打包，这几项断了就是发版断链） */
    {
      const fsMod = require('fs');
      const pruneJs = path.join(ROOT, 'tools', 'prune-runtime.js');
      const packJs = path.join(ROOT, 'tools', 'pack.js');
      check('运行时裁剪脚本存在', fsMod.existsSync(pruneJs), 'tools/prune-runtime.js');

      const packSrc = fsMod.existsSync(packJs) ? fsMod.readFileSync(packJs, 'utf8') : '';
      check('pack.js 已接入运行时裁剪', packSrc.indexOf('prune-runtime') !== -1);
      check('pack.js 含发版版本一致性自检', packSrc.indexOf('checkVersionConsistency') !== -1);

      const pruneSrc = fsMod.existsSync(pruneJs) ? fsMod.readFileSync(pruneJs, 'utf8') : '';
      check('裁剪脚本保留合规文件护栏', /KEEP_RE/.test(pruneSrc) && /license/i.test(pruneSrc));
      check('裁剪脚本含 TS 兄弟文件护栏', pruneSrc.indexOf('siblings') !== -1 && pruneSrc.indexOf('hasSibling') !== -1);

      // 真实跑一次 --dry：脚本能走完（不删任何文件），证明护栏逻辑没被打坏
      if (fsMod.existsSync(path.join(ROOT, 'runtime', 'dsh'))) {
        const dry = spawnSync(process.execPath, [pruneJs, '--dry'], { cwd: ROOT, encoding: 'utf8' });
        const out = (dry.stdout || '') + (dry.stderr || '');
        check('裁剪脚本 --dry 可正常预演', dry.status === 0 && out.indexOf('预演') !== -1, 'exit=' + dry.status);
      } else {
        check('裁剪脚本 --dry 可正常预演（无 runtime/dsh，跳过）', true, 'skipped');
      }
    }

    /* 不在本次范围（需要 API Key / 联网）：对话流式、搜索、证据检证、OCR */
  } finally {
    child.kill();
  }

  const fail = results.filter((r) => !r.ok);
  console.log('\n冒烟测试：' + (results.length - fail.length) + '/' + results.length + ' 通过' + (fail.length ? '（有失败项）' : '，全部通过'));
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('冒烟测试异常：', e); process.exit(1); });
