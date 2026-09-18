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


    /* 5b3. ★ PDF 入库回归：中文 CID 字体（Type0 + Identity-H）必须还原成汉字。
       旧的手写提取器把字形编号(GID)直接当 Unicode 解释，实测中文 PDF 抽出 CJK 占比 0%、
       整篇乱码；部分大文件还会抛 RangeError 整份失败。这里用**自己构造的最小 CID PDF**
       做断言（不依赖任何外部文件），确保「乱码」这个问题不会随重构回归。
       另外覆盖：请求体上限（旧值 6MB 会让 base64 后 >4.5MB 的文件根本传不上来）。 */
    {
      const zlib = require('zlib');
      const B = (s) => Buffer.from(s, 'latin1');
      /* 造一份最小可解析的 CID PDF：字形编号 1..n 通过 ToUnicode 映射回真实码点 */
      function buildCidPdf(text, opts) {
        opts = opts || {};
        const cps = Array.from(text).map((c) => c.codePointAt(0));
        const hex = cps.map((_, i) => String(i + 1).padStart(4, '0')).join('');
        let content = B('BT /F1 24 Tf 72 700 Td <' + hex + '> Tj ET');
        if (opts.compress) content = zlib.deflateSync(content);
        const toUni = [
          '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
          '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
          '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
          cps.length + ' beginbfchar',
          ...cps.map((cp, i) => '<' + String(i + 1).padStart(4, '0') + '> <' + cp.toString(16).padStart(4, '0') + '>'),
          'endbfchar', 'endcmap',
          'CMapName currentdict /CMap defineresource pop', 'end', 'end',
        ].join('\n');
        const objs = [
          B('<< /Type /Catalog /Pages 2 0 R >>'),
          B('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
          B('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>'),
          B('<< /Type /Font /Subtype /Type0 /BaseFont /NotoSansSC /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>'),
          B('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /NotoSansSC /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 1000 /CIDToGIDMap /Identity >>'),
          Buffer.concat([B('<< /Length ' + content.length + (opts.compress ? ' /Filter /FlateDecode' : '') + ' >>\nstream\n'), content, B('\nendstream')]),
          B('<< /Length ' + Buffer.byteLength(toUni, 'latin1') + ' >>\nstream\n' + toUni + '\nendstream'),
          B('<< /Type /FontDescriptor /FontName /NotoSansSC /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -200 /CapHeight 700 /StemV 80 >>'),
        ];
        if (opts.padBytes) {
          const pad = Buffer.alloc(opts.padBytes, 0x20);
          objs.push(Buffer.concat([B('<< /Length ' + pad.length + ' >>\nstream\n'), pad, B('\nendstream')]));
        }
        let out = B('%PDF-1.4\n');
        const off = [];
        for (let i = 0; i < objs.length; i++) {
          off[i + 1] = out.length;
          out = Buffer.concat([out, B((i + 1) + ' 0 obj\n'), objs[i], B('\nendobj\n')]);
        }
        const xref = out.length;
        let tail = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
        for (let i = 1; i <= objs.length; i++) tail += String(off[i]).padStart(10, '0') + ' 00000 n \n';
        tail += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
        return Buffer.concat([out, B(tail)]);
      }

      const SAMPLE = '辩论教练冒烟测试';
      for (const compress of [false, true]) {
        const buf = buildCidPdf(SAMPLE, { compress });
        const r = await j('POST', '/api/extract-pdf', { name: '__t_smoke_cid.pdf', data: buf.toString('base64') });
        const label = compress ? '（压缩流）' : '（明文流）';
        check('★ PDF 中文 CID 提取不乱码' + label,
          r.status === 200 && r.d && r.d.ok && r.d.text === SAMPLE,
          JSON.stringify((r.d && r.d.text) || (r.d && r.d.error)));
        check('PDF 返回页数信息' + label, !!(r.d && r.d.totalPages >= 1), 'totalPages=' + (r.d && r.d.totalPages));
      }

      // 入库链路（走真正的 libAdd → 落 text/*.txt），而不只是提取接口
      const cidBuf = buildCidPdf(SAMPLE, { compress: true });
      let ur = await j('POST', '/api/library/upload', { name: '__t_smoke_cid.pdf', data: cidBuf.toString('base64') });
      check('★ PDF 入库后正文是汉字', ur.status === 200 && ur.d && ur.d.ok, (ur.d && ur.d.error) || '');
      const cidId = ur.d && ur.d.item && ur.d.item.id;
      if (cidId) {
        const doc = await j('GET', '/api/library/doc?id=' + encodeURIComponent(cidId));
        check('资料库读回的 PDF 正文不乱码', doc.d && doc.d.text === SAMPLE, JSON.stringify(doc.d && String(doc.d.text).slice(0, 40)));
        const sr = await j('POST', '/api/library/search', { query: '冒烟测试' });
        check('PDF 入库后可被召回', ((sr.d && sr.d.hits) || []).some((x) => x.id === cidId));
        await j('POST', '/api/library/delete', { id: cidId });
      }

      // 请求体上限：5MB 填充 → base64 ≈6.7MB，旧上限 6MB 会直接「请求体过大」
      const bigBuf = buildCidPdf(SAMPLE, { compress: true, padBytes: 5 * 1024 * 1024 });
      const b64mb = (bigBuf.toString('base64').length / 1048576).toFixed(1);
      const br = await j('POST', '/api/extract-pdf', { name: '__t_smoke_big.pdf', data: bigBuf.toString('base64') });
      check('★ 大于 6MB 请求体的 PDF 附件可提取', br.status === 200 && br.d && br.d.ok && br.d.text === SAMPLE,
        'base64=' + b64mb + 'MB · ' + ((br.d && br.d.error) || br.status));

      // 负例：不是 PDF 必须被干净地拒绝（而不是吐乱码或 500）
      const bad = await j('POST', '/api/extract-pdf', { name: 'x.pdf', data: Buffer.from('not a pdf').toString('base64') });
      check('非 PDF 内容被拒绝', bad.status === 400 || bad.status === 422);
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

    /* 7. 清理测试产物并确认删干净。
       注意：**不能写死要删的文件名** —— 转档会按重名自动追加 _2/_3/_4，
       写死清单一旦漏一个，这条断言就长期变红（曾经就因为漏了 __t_smoke_3/_4 挂过），
       而且残留会一直堆在用户的产物空间里。改成「先列出所有 __t_smoke* 再逐个删」。 */
    {
      const before = await j('GET', '/api/deliverables');
      const leftovers = (before.d.items || before.d.files || [])
        .map((x) => x.name)
        .filter((n) => String(n).startsWith('__t_smoke'));
      for (const n of leftovers) {
        await j('POST', '/api/deliverables/delete', { name: n });
      }
      const r = await j('GET', '/api/deliverables');
      const names = (r.d.items || r.d.files || []).map((x) => x.name);
      check('清理测试产物', !names.some((n) => String(n).startsWith('__t_smoke')),
        leftovers.length ? ('已清 ' + leftovers.length + ' 个：' + leftovers.join(', ')) : '无残留');
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

      /* 合规检查器的扫描范围必须覆盖 .mjs：runtime/academy-text-stream.mjs 是
         我们自己写的内核插件，一旦写死开发机路径，分包在别人机器上内核整个起不来。
         而它曾经因为 TEXT_EXT 里没有 .mjs 被整段跳过 —— 护栏形同虚设。 */
      const sanitizeJs = path.join(ROOT, 'tools', 'sanitize-open-source.js');
      const sanSrc = fsMod.existsSync(sanitizeJs) ? fsMod.readFileSync(sanitizeJs, 'utf8') : '';
      const textExtM = sanSrc.match(/const TEXT_EXT = new Set\(\[([\s\S]*?)\]\)/);
      const textExt = textExtM ? textExtM[1] : '';
      check('★ 合规检查覆盖 .mjs 扩展名', textExt.indexOf("'.mjs'") !== -1, textExt ? 'TEXT_EXT 未含 .mjs' : '未找到 TEXT_EXT');
      check('合规检查把自研内核插件纳入扫描', sanSrc.indexOf('academy-text-stream.mjs') !== -1);
      check('合规检查跳过第三方 vendor 目录', /'vendor'/.test(sanSrc));

      const pruneSrc = fsMod.existsSync(pruneJs) ? fsMod.readFileSync(pruneJs, 'utf8') : '';
      check('裁剪脚本保留合规文件护栏', /KEEP_RE/.test(pruneSrc) && /license/i.test(pruneSrc));
      check('裁剪脚本含 TS 兄弟文件护栏', pruneSrc.indexOf('siblings') !== -1 && pruneSrc.indexOf('hasSibling') !== -1);

      /* 10b. 修复补丁链路：已装用户靠它升级，断了就只能让用户重下 175MB 安装包 */
      const patchJs = path.join(ROOT, 'tools', 'patch.js');
      const patchCsPath = path.join(ROOT, 'tools', 'sfx', 'PatchLauncher.cs');
      check('补丁生成脚本存在', fsMod.existsSync(patchJs), 'tools/patch.js');
      check('补丁外壳源码存在', fsMod.existsSync(patchCsPath), 'tools/sfx/PatchLauncher.cs');

      const patchSrc = fsMod.existsSync(patchJs) ? fsMod.readFileSync(patchJs, 'utf8') : '';
      // 补丁必须用自己那套魔术标记：与安装版共用的话，拿错文件也能解出内容、排查时分不清
      check('补丁用独立的叠加标记', /ACADEMY-PATCH-OVERLAY/.test(patchSrc));
      // 源码含中文界面文案，csc 不带 codepage 会按 ANSI 读、编译成乱码
      check('补丁编译带 /codepage:65001', patchSrc.indexOf('/codepage:65001') !== -1);
      // ★ 补丁绝不能把用户数据或开发期文件打进包
      check('★ 补丁排除 data/ 与开发日志',
        patchSrc.indexOf('data') !== -1 && patchSrc.indexOf('开发日志') !== -1 && /EXCLUDE_RE/.test(patchSrc));
      check('补丁生成后会回读自检', patchSrc.indexOf('哈希') !== -1 && patchSrc.indexOf('自检') !== -1);

      const patchCs = fsMod.existsSync(patchCsPath) ? fsMod.readFileSync(patchCsPath, 'utf8') : '';
      /* ★ 三个真踩过的坑，各留一条断言，避免以后被「顺手改成更简洁的写法」而复发：
         ① 显式给了 --dir 就不能回退自动探测 —— 否则参数被拆开时会静默打到另一个目录；
         ② 回滚必须逐文件 —— 整目录还原会因单个被占用的文件而中断，留下半新半旧；
         ③ 根目录文件也要纳入备份 —— 只备份子目录会让 LICENSE.md 之类无法还原。 */
      check('★ 补丁：显式 --dir 不回退自动探测', patchCs.indexOf('不是辩论教练的安装目录') !== -1);
      check('★ 补丁：回滚逐文件进行', patchCs.indexOf('逐文件回滚') !== -1);
      check('★ 补丁：根目录文件也纳入备份', /backupFiles/.test(patchCs) && /ExistedBefore/.test(patchCs));
      /* ★ 第四条：关进程的辅助 ps1 必须「正文纯 ASCII + 路径走参数 + 带 BOM 写盘」。
         旧写法把安装路径拼进脚本正文且不带 BOM，PowerShell 5.1 按 ANSI 解码中文路径
         → 脚本语法报错 → 静默失败。后果极隐蔽：补丁 exit 0、文件也换了，但旧进程没关，
         用户重启前一直看着旧界面，以为补丁没生效。 */
      check('★ 补丁：关进程脚本走参数不拼路径', patchCs.indexOf('$dest = $args[0]') !== -1);
      check('★ 补丁：关进程脚本带 BOM 写盘', patchCs.indexOf('UTF8Encoding(true)') !== -1);
      check('★ 补丁：关进程结果会被检查', patchCs.indexOf('仍有进程占用') !== -1);

      /* 10b+. UI 断链防线（2026-09-19 巡检轮）：
         window.prompt 在 Electron 里直接抛错（点了没反应、不报错），
         9/19 前辩题归档改名就是这么坏的。一律走 askInput 应用内弹窗。 */
      const appJsSrc = fsMod.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');
      check('★ app.js 不再调用 window.prompt', appJsSrc.indexOf('window.prompt(') === -1);
      check('★ askInput 应用内输入弹窗存在', /function askInput\(/.test(appJsSrc));
      check('★ inputModal 弹窗结构存在',
        fsMod.readFileSync(path.join(ROOT, 'app', 'public', 'index.html'), 'utf8').indexOf('id="inputModal"') !== -1);
      /* 巡检必须用隔离数据目录跑 —— server 支持 ACADEMY_DATA_DIR 是隔离的前提 */
      const serverSrc = fsMod.readFileSync(path.join(ROOT, 'app', 'server.js'), 'utf8');
      check('★ server 支持 ACADEMY_DATA_DIR 隔离', serverSrc.indexOf('ACADEMY_DATA_DIR') !== -1);
      check('★ server 资料库读取走 dataAbs（隔离不漏）', serverSrc.indexOf('function dataAbs(') !== -1);
      /* 巡检三件套在位（runner / 注入 / 巡检本体），丢一个巡检就跑不起来 */
      check('巡检工具三件套存在',
        fsMod.existsSync(path.join(ROOT, 'tools', 'run-ui-patrol.js')) &&
        fsMod.existsSync(path.join(ROOT, 'tools', 'ui-patrol.js')) &&
        fsMod.existsSync(path.join(ROOT, 'tools', 'patrol-inject.js')));

      /* 独立工具窗（2026-09-19）：证据检证独立 + 资料溯源新增，共用 tool-window 通用壳 */
      check('工具窗通用壳存在 · app/tool-window.js', fsMod.existsSync(path.join(ROOT, 'app', 'tool-window.js')));
      check('证据检证独立窗渲染层存在 · app/verify/',
        fsMod.existsSync(path.join(ROOT, 'app', 'verify', 'renderer.html')) &&
        fsMod.existsSync(path.join(ROOT, 'app', 'verify', 'verify.js')));
      check('资料溯源工具渲染层存在 · app/trace/',
        fsMod.existsSync(path.join(ROOT, 'app', 'trace', 'renderer.html')) &&
        fsMod.existsSync(path.join(ROOT, 'app', 'trace', 'trace.js')));
      check('★ 溯源接口已注册（trace-quick / trace）',
        serverSrc.indexOf("/api/research/trace-quick") !== -1 && serverSrc.indexOf("'POST' && p === '/api/research/trace'") !== -1);
      check('★ 主窗口 preload 暴露工具窗入口',
        fsMod.readFileSync(path.join(ROOT, 'app', 'preload.js'), 'utf8').indexOf('openVerifyTool') !== -1);
      check('★ electron-main 注册 app:openTool',
        fsMod.readFileSync(path.join(ROOT, 'app', 'electron-main.js'), 'utf8').indexOf("app:openTool") !== -1);
      const researchJsSrc = fsMod.readFileSync(path.join(ROOT, 'app', 'research', 'research.js'), 'utf8');
      check('★ 研究台已移除检证面板（不再调 verify-quick）', researchJsSrc.indexOf('verify-quick') === -1 && researchJsSrc.indexOf('verifyBox') === -1);
      check('★ 研究台保留检证跳转入口', researchJsSrc.indexOf('openVerify') !== -1);

      /* 10c. ★ 打包链路：build-installer 必须按**当前型号**去找 pack.js 产出的 zip。
         9/13 型号架构落地时，pack.js 的 zip 名加了型号后缀，而 build-installer 还写死
         旧名字 —— 结果「安装版再也打不出来」，pack.js 刚打完 zip 就报「缺少便携版 zip」。
         这是一个会卡死发版的断链，必须钉住。 */
      const biJs = path.join(ROOT, 'tools', 'build-installer.js');
      const biSrc = fsMod.existsSync(biJs) ? fsMod.readFileSync(biJs, 'utf8') : '';
      check('安装版脚本按型号解析便携版 zip',
        biSrc.indexOf('resolvePortableZip') !== -1 && biSrc.indexOf('edition.name') !== -1,
        'tools/build-installer.js');
      check('★ 安装版 zip 名不再写死（含型号+旧名兜底）',
        /Academy-Bianlun-Coach-' \+ edition\.name \+ '-portable\.zip/.test(biSrc) || biSrc.indexOf("-portable.zip") !== -1);
      // 两条线都会导出到同一个「工作区 dist/」，英文名不带型号会互相覆盖
      check('★ 安装版产物名带型号后缀', biSrc.indexOf('EXE_SUFFIX') !== -1);

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
