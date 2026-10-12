#!/usr/bin/env node
/* 增强检索（ModSearch）回归验证 —— 引擎级，隔离数据目录直调（phase4/5-driver 同模式）。
 *
 * 为什么必须有它（2026-10-12 立的纪律）：
 *   冒烟里对这条链只有静态断言 + 接口读写，**真发网络请求的那一段没有覆盖** ——
 *   正是 10-10「用量账本每行记 0」那类缺陷藏身的缝：A 写 B 读，读端有断言、写端没有。
 *   这里把「起子进程 → 解析 stdout → 归一 sources → 相关性打分 → 额度记账」整条写端跑真数据。
 *
 * 用例（--suite 一次跑完；单跑：node tools/verify-modsearch.js <case>）：
 *   engine-real        ★ 真发一次搜索（消耗免注册额度约 2 credits），验结果结构与账本增量
 *   prefer-modsearch   正向对照：CLI 可用且结果相关 → 端侧检索走 modsearch
 *   fallback-broken    CLI 输出不是 JSON → 自动退回基础检索（不抛错、不卡任务）
 *   fallback-irrelevant CLI 返回合法但无关 → 相关性打分拦下，退回基础检索
 *   fallback-missing   CLI 文件不存在 → 直接走基础检索
 *   switch-off         开关关掉 → 连 CLI 进程都不该起（stub 落标记文件证明）
 *   quota-shape        额度账本结构自洽、落在 DATA_DIR 下（ACADEMY_DATA_DIR 隔离生效）
 *
 * 用法：runtime\\node\\node.exe tools/verify-modsearch.js --suite
 * 说明：--suite 会为每个用例 spawn 一个子进程（ACADEMY_MODSEARCH_CLI 在 require 时就定死，
 *       不同用例要注入不同的 CLI 路径，只能分进程）。engine-real 需要外网。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE = process.argv[2] === '--suite';
const kase = SUITE ? '' : (process.argv[2] || '');
const STUB = (n) => path.join(ROOT, '.build', 'modsearch-stubs', n);   // suite 分支要用，必须在它之前定义

/* ---------- suite：编排子进程 + 汇总 ---------- */
if (SUITE) {
  const DATA = path.join(ROOT, '.build', 'modsearch-data');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const STUBS = path.join(ROOT, '.build', 'modsearch-stubs');
  fs.mkdirSync(STUBS, { recursive: true });
  // 好结果：合法 JSON + 与查询相关（含「辩论」字样）
  fs.writeFileSync(path.join(STUBS, 'good.js'),
    "console.log(JSON.stringify({mode:'search',results:[{source:'web',engine:'stub',status:'ok',warnings:[],attempts:[{engine:'stub',ok:true,durationSeconds:0.1,credits:2}],items:[{title:'新加坡辩论教育政策',url:'https://example.com/debate',snippet:'关于辩论与教育的政策讨论',published_at:''}]}]}));\n");
  // 垃圾输出
  fs.writeFileSync(path.join(STUBS, 'broken.js'), "console.log('this is not json at all');\n");
  // 合法但无关
  fs.writeFileSync(path.join(STUBS, 'irrelevant.js'),
    "console.log(JSON.stringify({mode:'search',results:[{source:'web',engine:'stub',status:'ok',warnings:[],attempts:[{engine:'stub',ok:true,durationSeconds:0.1,credits:2}],items:[{title:'今日菜谱红烧肉',url:'https://example.com/food',snippet:'糖色与火候的做法'}]}]}));\n");
  // 上游按 IP 拒绝免注册通道时的真实报错（英文堆栈）：界面必须翻成人话
  fs.writeFileSync(path.join(STUBS, 'ipblock.js'),
    "process.stderr.write('Error: Every engine for the web source failed.\\n  - firecrawl: firecrawl rejected the keyless request (403). Unfortunately, your IP address looks suspicious, so Firecrawl can\\'t be used without an API key from here.\\n');process.exit(1);\\n");
  // 会起进程就落标记（验「关掉开关就别起进程」）
  fs.writeFileSync(path.join(STUBS, 'marker.js'),
    "require('fs').writeFileSync(process.env.MS_MARKER_FILE || 'x','ran');\n" +
    "console.log(JSON.stringify({mode:'search',results:[{source:'web',engine:'stub',status:'ok',warnings:[],attempts:[{engine:'stub',ok:true,durationSeconds:0.1,credits:2}],items:[{title:'新加坡辩论教育政策',url:'https://example.com/debate',snippet:'关于辩论与教育的政策讨论'}]}]}));\n");

  /* ★ ACADEMY_MODSEARCH_CLI 必须在子进程**加载 server.js 之前**进环境：
     server.js 里 MODSEARCH_CLI 是模块级常量，require 之后再改 process.env 是不生效的
     （第一版就犯了这个错——所有用例都拿真 vendor CLI 跑，负向对照全部空转）。
     所以 CLI 路径只能由 suite 通过 env 注入，engine-real 不注入 = 用随包真 CLI。 */
  const CASES = [
    ['prefer-modsearch', STUB('good.js')],
    ['fallback-broken', STUB('broken.js')],
    ['fallback-irrelevant', STUB('irrelevant.js')],
    ['fallback-missing', STUB('nope-does-not-exist.js')],
    ['switch-off', STUB('marker.js')],
    ['friendly-error', STUB('ipblock.js')],
    ['quota-shape', null],
    ['engine-real', null],
  ];
  const results = [];
  let failed = 0;
  let skippedN = 0;
  for (const [c, cli] of CASES) {
    const env = Object.assign({}, process.env, { ACADEMY_DATA_DIR: DATA, ACADEMY_NO_OPEN: '1' });
    if (cli) env.ACADEMY_MODSEARCH_CLI = cli;
    if (c === 'switch-off') env.MS_MARKER_FILE = path.join(STUBS, 'marker.flag');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-modsearch.js'), c], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 120000,
    });
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch (_) {}
    const ok = !!j && j.ok === true;
    const skipped = ok && j.skipped === true;
    if (!ok) failed++;
    if (skipped) skippedN++;
    results.push({ c, ok, skipped, detail: j ? (j.detail || '') : ('no json; exit=' + r.status + ' out=' + String(r.stdout || '').slice(0, 120) + ' err=' + String(r.stderr || '').slice(-200)) });
    // 同步写：console.log 到 pipe 是异步的，最后的 process.exit 会把没 flush 的行吃掉（踩过一次）
    fs.writeSync(1, (skipped ? '  ⏭ ' : ok ? '  ✅ ' : '  ❌ ') + c + (results[results.length - 1].detail ? ' · ' + results[results.length - 1].detail : '') + '\n');
  }
  fs.writeSync(1, '\n增强检索回归：' + (results.length - failed) + '/' + results.length + ' 通过'
    + (skippedN ? '（其中 ' + skippedN + ' 项因外部条件跳过，见上）' : '')
    + (failed ? '（有失败项）' : '，全部通过') + '\n');
  process.exit(failed ? 1 : 0);
}

/* ---------- 单用例：本进程 require server（会起 listen，用完即 exit） ---------- */
const srv = require('../app/server.js');
const MS = srv.academyModsearch, C = srv.academyConfig;
const out = (v) => { fs.writeSync(1, JSON.stringify(Object.assign({ ok: false }, v))); process.exit(0); };
const DATA_DIR = process.env.ACADEMY_DATA_DIR;

(async () => {
  if (kase === 'engine-real') {
    const before = MS.usage();
    const q = '新加坡 高中 辩论 教育 政策';
    const r = await MS.search(q, { maxResults: 5 });
    /* 免注册通道由上游按 IP 计量，可能因限流 / 额度 / 地区此刻不可用（403/429/额度类报错）。
       那是外部条件，不该把回归判红 —— 但必须**大声标成跳过**，不能伪装成通过。
       （降级链本身由 fallback-* 用例确定性地证明，不依赖外网。） */
    if (!r.ok) {
      /* raw = 上游原文（友好化前）。免注册通道的失败全是外部条件，判红没有意义。
         中文那半支是 no-results 路径没有 raw 时的兜底：认得出是友好化后的上游拒绝就行。 */
      const upstream = /\b40[13]\b|\b429\b|rejected the keyless|rate.?limit|too many requests|out of credits|insufficient|not (?:currently )?available in your|eligibility check failed|本机网络被免注册通道拒绝|免注册通道在你所在的网络地区不可用|本月免注册额度已用完|免注册通道被限流/i.test(String(r.raw || '') + ' ' + String(r.error || ''));
      return out(upstream
        ? { ok: true, skipped: true, detail: '⚠️ 跳过（上游免注册通道此刻不可用）：' + String(r.error).slice(0, 120) }
        : { detail: '真实搜索失败（非上游限额类，按坏处理）：' + r.error });
    }
    const after = MS.usage();
    const shapeOk = r.sources.length > 0 && r.sources.every((s) =>
      /^https?:\/\//i.test(s.url) && s.title && Array.isArray(s.tags) && s.tags.length > 0 && /^modsearch$|^[a-z-]+$/.test(String(s.engine)));
    const ledger = JSON.parse(fs.readFileSync(MS.ledgerFile(), 'utf8'));
    const monthRow = ledger.months[after.month];
    return out({
      ok: shapeOk && after.searches === before.searches + 1 && after.creditsUsed >= before.creditsUsed + 1
        && !!monthRow && Number(monthRow.searches) >= 1 && r.credits >= 1,
      detail: r.sources.length + ' 条 / 引擎 ' + r.engine + ' / 本次 ' + r.credits + ' credits / 账本 ' + before.creditsUsed + '→' + after.creditsUsed
        + ' / 样例：' + String(r.sources[0].title).slice(0, 24),
    });
  }

  if (kase === 'prefer-modsearch') {
    C.saveConfig({ modsearch: { enabled: true } });
    const r = await MS.searchResults('新加坡 高中 辩论 教育 政策');
    return out({ ok: r.provider === 'modsearch' && r.sources.length === 1 && !!r.sources[0].tags, detail: 'provider=' + r.provider });
  }

  if (kase === 'fallback-broken') {
    C.saveConfig({ modsearch: { enabled: true } });
    const one = await MS.search('新加坡 高中 辩论 教育 政策');
    const r = await MS.searchResults('新加坡 高中 辩论 教育 政策');
    return out({ ok: !one.ok && /无法解析/.test(one.error || '') && r.provider === 'free', detail: 'err=' + String(one.error || '').slice(0, 40) + ' / provider=' + r.provider });
  }

  if (kase === 'fallback-irrelevant') {
    C.saveConfig({ modsearch: { enabled: true } });
    const one = await MS.search('新加坡 高中 辩论 教育 政策');
    const r = await MS.searchResults('新加坡 高中 辩论 教育 政策');
    return out({ ok: !one.ok && /相关性不足/.test(one.error || '') && r.provider === 'free', detail: 'err=' + String(one.error || '').slice(0, 40) + ' / provider=' + r.provider });
  }

  if (kase === 'fallback-missing') {
    C.saveConfig({ modsearch: { enabled: true } });
    const one = await MS.search('新加坡 高中 辩论 教育 政策');
    const r = await MS.searchResults('新加坡 高中 辩论 教育 政策');
    return out({ ok: !one.ok && /未随包安装/.test(one.error || '') && r.provider === 'free', detail: 'err=' + String(one.error || '').slice(0, 40) + ' / provider=' + r.provider });
  }

  if (kase === 'switch-off') {
    const marker = process.env.MS_MARKER_FILE || path.join(ROOT, '.build', 'modsearch-stubs', 'marker.flag');
    try { fs.unlinkSync(marker); } catch (_) {}
    C.saveConfig({ modsearch: { enabled: false } });
    const r = await MS.searchResults('新加坡 高中 辩论 教育 政策');
    const ran = fs.existsSync(marker);
    C.saveConfig({ modsearch: { enabled: true } });
    return out({ ok: !ran && r.provider === 'free', detail: '进程被起了=' + ran + ' / provider=' + r.provider });
  }

  if (kase === 'friendly-error') {
    C.saveConfig({ modsearch: { enabled: true } });
    const one = await MS.search('新加坡 高中 辩论 教育 政策');
    // 必须是中文人话，且不能把英文堆栈甩给用户
    const ok = !one.ok && /本机网络被免注册通道拒绝/.test(one.error || '') && !/looks suspicious/.test(one.error || '');
    const r = await MS.searchResults('新加坡 高中 辩论 教育 政策');
    return out({ ok: ok && r.provider === 'free', detail: 'error=' + String(one.error || '').slice(0, 40) + ' / provider=' + r.provider });
  }

  if (kase === 'quota-shape') {
    const u = MS.usage();
    const ledgerPath = MS.ledgerFile();
    return out({
      ok: /^\d{4}-\d{2}$/.test(u.month) && u.monthlyCap === 1000
        && u.remainingEst === Math.max(0, u.monthlyCap - u.creditsUsed)
        && ledgerPath.startsWith(DATA_DIR) && MS.ready() && /^\d+\.\d+\.\d+$/.test(MS.version()),
      detail: 'month=' + u.month + ' 已用=' + u.creditsUsed + ' 剩=' + u.remainingEst + ' 随包 v' + MS.version(),
    });
  }

  out({ detail: 'unknown case: ' + kase });
})().catch((e) => out({ detail: 'EXCEPTION ' + (e && e.stack || e) }));
