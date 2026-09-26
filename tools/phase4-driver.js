'use strict';
/* Phase 4 内核驱动器：记忆治理 + 受管队列，隔离数据目录直调（tools/memory-forget-driver.js 同模式）。
   用法：node tools/phase4-driver.js <case> [args...]
   数据目录由 ACADEMY_DATA_DIR 指定（冒烟里隔离到 data/_smoke_phase4，测后即删）。 */
const srv = require('../app/server.js');
const G = srv.academyGovernance, Q = srv.academyQueue;
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const kase = process.argv[2] || '';
const arg = (i) => process.argv[3 + i];

function cfgPatch(p) {
  // 通过 HTTP 打不进来的内部开关：直接改隔离目录里的 config.json 再热读
  const fs = require('fs'), path = require('path');
  const f = path.join(process.env.ACADEMY_DATA_DIR, 'config.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  Object.assign(c, p);
  fs.writeFileSync(f, JSON.stringify(c));
}

(async () => {
  if (kase === 'govern-basic') {
    const tag = '__p4_' + Date.now();
    cfgPatch({ memoryAutoLearn: true, memoryReview: false });
    const r1 = G.archiveMemoryFromOutput('正文 ' + tag + ' <!-- MEMORY: 长期候选' + tag + ' --><!-- NOTE: 流水候选' + tag + ' -->');
    const cleanNoBlock = r1.cleaned.indexOf('<!--') === -1;
    cfgPatch({ memoryReview: true });
    const tag2 = '__p4r_' + Date.now();
    const r2 = G.archiveMemoryFromOutput('x <!-- MEMORY: 审阅候选' + tag2 + ' -->');
    const pend = G.readJsonSafe(process.env.ACADEMY_DATA_DIR + '/memory-pending.json', []);
    const inPending = pend.some((p) => String(p.text).includes(tag2));
    const longTxt = require('fs').readFileSync(process.env.ACADEMY_DATA_DIR + '/memory.md', 'utf8');
    const notInLong = longTxt.indexOf(tag2) === -1;
    cfgPatch({ memoryAutoLearn: false });
    const tag3 = '__p4off_' + Date.now();
    G.archiveMemoryFromOutput('x <!-- MEMORY: 关闭学习' + tag3 + ' -->');
    const pend2 = G.readJsonSafe(process.env.ACADEMY_DATA_DIR + '/memory-pending.json', []);
    const offSkip = !pend2.some((p) => String(p.text).includes(tag3))
      && require('fs').readFileSync(process.env.ACADEMY_DATA_DIR + '/memory.md', 'utf8').indexOf(tag3) === -1;
    out({ cleanNoBlock, inPending, notInLong, offSkip, archived1: r1.archived > 0 });
  }

  if (kase === 'reject-e2e') {
    const tag = '__p4rej_' + Date.now();
    cfgPatch({ memoryAutoLearn: true, memoryReview: false });
    G.appendMemory('否决试验' + tag, { long: true });
    const before = G.selectLongMemory('否决试验' + tag);
    const injectedBefore = before.text.indexOf(tag) !== -1;
    G.rejectMemoryFingerprint('否决试验' + tag, 'test');
    const hit = !!G.memRejectedHit('否决试验' + tag);
    const after = G.selectLongMemory('否决试验' + tag);
    const injectedAfter = after.text.indexOf(tag) !== -1;
    // 同文候选不再进 pending / 不入库
    const tag2 = G.memFingerprint('否决试验' + tag);
    G.rejectMemoryFingerprint('  否决试验 ' + tag + '  ', 'test');  // 归一化判重
    const list = G.readJsonSafe(process.env.ACADEMY_DATA_DIR + '/memory-rejected.json', []);
    const dedup = list.filter((x) => G.memFingerprint(x.text) === tag2).length === 1;
    const ok2 = G.unrejectMemory(tag2);
    // 撤销否决后应重新可见
    const after2 = G.selectLongMemory('否决试验' + tag);
    out({ injectedBefore, hit, notInjectedAfter: !injectedAfter, dedup, unrejectOk: ok2, reinjected: after2.text.indexOf(tag) !== -1 });
  }

  if (kase === 'pending-lifecycle') {
    const tag = '__p4pl_' + Date.now();
    G.pushMemoryPending({ kind: 'long', text: '候选' + tag, time: 'now' });
    G.pushMemoryPending({ kind: 'long', text: '候选' + tag, time: 'now2' });   // 同指纹只留一条
    const f = process.env.ACADEMY_DATA_DIR + '/memory-pending.json';
    let list = G.readJsonSafe(f, []);
    const oneCopy = list.filter((p) => String(p.text).includes(tag)).length === 1;
    const fp = list.find((p) => String(p.text).includes(tag)).fp;
    const removed = G.removeMemoryPending(fp);
    list = G.readJsonSafe(f, []);
    out({ oneCopy, removed: removed === 1, gone: !list.some((p) => p.fp === fp) });
  }

  if (kase === 'queue-dup') {
    const key = 't:' + Q.sha16('同一内容');
    const cfg = { apiKey: 'sk-test', model: 'm' };
    const p1 = Q.runPrecheck(cfg, '同一内容', { dedupKey: key, engineReady: true });
    const p2 = Q.runPrecheck(cfg, '同一内容', { dedupKey: key, engineReady: true });
    out({ firstClean: p1.length === 0, dupBlocked: p2.some((s) => s.startsWith('DUP')) });
  }

  if (kase === 'queue-cap') {
    const noop = () => {};
    // 假运行占位：currentRun 存在时 pumpQueue 不消费，注册项留在队列里
    Q.beginFakeRunForTest('fake-run');
    let threw = '';
    try {
      for (let i = 0; i < 4; i++) Q.queueRegister('chat', 'q-test-' + i, 't', noop);
    } catch (e) { threw = e.code || 'ERR'; }
    const len = Q.runQueue().length;
    for (const it of Q.runQueue().slice()) Q.queueWithdraw(it.runId);
    Q.endFakeRunForTest();
    out({ threwAt4: threw === 'QUEUE_FULL', len, cleared: Q.runQueue().length === 0 });
  }

  if (kase === 'queue-withdraw') {
    const noop = () => {};
    Q.beginFakeRunForTest('fake-run');
    Q.queueRegister('chat', 'w-1', 't', noop);
    Q.queueRegister('chat', 'w-2', 't2', noop);
    const was = Q.queueWithdraw('w-1');
    const posBefore = Q.queuePositionOf('w-2');
    const was2 = Q.queueWithdraw('w-2');
    Q.queueWithdraw('w-2');   // 重复撤回：幂等，返回 null
    Q.endFakeRunForTest();
    out({ was: was === 'queued', pos1: posBefore === 0, was2: was2 === 'queued', goneAfter: Q.queuePositionOf('w-2') === -1, emptyAfter: Q.runQueue().length === 0 });
  }

  if (kase === 'ledger') {
    const tok = '__p4led_' + Date.now();
    const rec = { runId: tok, source: 'chat', model: 'm', time: 'now', startedAt: Date.now() - 500, status: 'running', inputChars: 10 };
    Q.ledgerAppendRec(rec);
    const fin = Object.assign({}, rec, { status: 'ok', elapsedMs: 500, code: 0, finishedAt: Date.now() });
    Q.ledgerAppendRec(fin);
    const recent = Q.runsLedgerRecent(10);
    const mine = recent.filter((x) => x.runId === tok);
    out({ appended: mine.length === 2, latestFirst: recent[0] && recent[0].runId === tok, statuses: mine.map((x) => x.status) });
  }

  out({ unknownCase: kase });
})().catch((e) => { process.stdout.write(JSON.stringify({ driverError: e.message })); process.exit(0); });
