#!/usr/bin/env node
/* Academy 冒烟测试：起一个临时服务器，回归核心接口。
   不调用任何 AI / 联网接口（对话流式、搜索、检证需要 Key，另做手工验证）。
   用法：node tools/smoke-test.js [--port=8899]
   全部通过 → exit 0；任一失败 → exit 1。
   测试产物统一 __t_smoke 前缀，测完自动清理，不污染真实数据。 */
const path = require('path');
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
  const child = spawn(process.execPath, [serverJs, '--port=' + PORT], {
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
    }

    /* 2. 配置接口 */
    {
      const r = await j('GET', '/api/config');
      check('GET /api/config', r.status === 200 && r.d && r.d.ok === true);
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

    /* 不在本次范围（需要 API Key / 联网）：对话流式、搜索、证据检证、OCR */
  } finally {
    child.kill();
  }

  const fail = results.filter((r) => !r.ok);
  console.log('\n冒烟测试：' + (results.length - fail.length) + '/' + results.length + ' 通过' + (fail.length ? '（有失败项）' : '，全部通过'));
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('冒烟测试异常：', e); process.exit(1); });
