'use strict';
/* Phase 5 内核驱动器：工作步骤展示 × 繁忙时的发送行为（DSH 移植），隔离数据目录直调（phase4-driver 同模式）。
   用法：node tools/phase5-driver.js <case> */
const srv = require('../app/server.js');
const C = srv.academyConfig, Q = srv.academyQueue, EFF = srv.academyEffort;
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const kase = process.argv[2] || '';

(async () => {
  if (kase === 'cfg-roundtrip') {
    C.saveConfig({ stepsDisplay: 'detailed', busyBehavior: 'interrupt' });
    const c = C.loadConfig();
    out({ detailedOk: c.stepsDisplay === 'detailed', interruptOk: c.busyBehavior === 'interrupt' });
  }

  if (kase === 'normalize') {
    C.saveConfig({ stepsDisplay: 'bogus', busyBehavior: 'weird' });
    const c = C.loadConfig();
    out({ stepsStandard: c.stepsDisplay === 'standard', busyQueue: c.busyBehavior === 'queue' });
  }

  if (kase === 'status-echo') {
    const s = C.statusPayload();
    out({ hasSteps: typeof s.stepsDisplay === 'string', hasBusy: typeof s.busyBehavior === 'string' });
  }

  if (kase === 'interrupt-preempt') {
    Q.beginFakeRunForTest('p5-fake-run');
    Q.queueRegister('chat', 'p5-q1', 't1', () => {});
    Q.queueRegister('chat', 'p5-q2', 't2', () => {});
    const killed = Q.preemptCurrentRun('interrupted');
    const moved = Q.queueWithdrawAll('preempted');
    const recs = Q.runsLedgerRecent(10);
    out({
      killed: killed === 'p5-fake-run',
      queueEmpty: Q.runQueue().length === 0,
      withdrawn: ['p5-q1', 'p5-q2'].every((id) => recs.some((r) => r.runId === id && r.status === 'withdrawn'))
        && moved.length === 2,
    });
  }

  if (kase === 'effort') {
    C.saveConfig({ reasoningEffort: 'low' });
    const a = C.loadConfig();
    const yaml = require('fs').readFileSync(EFF.settingsFile, 'utf8');
    C.saveConfig({ reasoningEffort: 'bogus' });
    const b = C.loadConfig();
    const yaml2 = require('fs').readFileSync(EFF.settingsFile, 'utf8');
    const st = C.statusPayload();
    // 第三方端点：llm-pi-ai 路由也要声明 reasoningEfforts + 写 effort
    C.saveConfig({ baseUrl: 'https://api.siliconflow.cn/v1', reasoningEffort: 'max' });
    const yaml3 = require('fs').readFileSync(EFF.settingsFile, 'utf8');
    C.saveConfig({ baseUrl: 'https://api.deepseek.com', reasoningEffort: 'high' });
    out({ lowOk: a.reasoningEffort === 'low', yamlLow: yaml.includes('reasoningEffort: "low"'),
          normHigh: b.reasoningEffort === 'high', yamlHigh: yaml2.includes('reasoningEffort: "high"'),
          echoOk: st.reasoningEffort === 'high',
          piDeclared: yaml3.includes('reasoningEfforts:') && yaml3.includes('max: high'),
          piEffort: yaml3.includes('reasoningEffort: "max"') });
  }

  if (kase === 'send-hotkey') {
    C.saveConfig({ sendHotkey: 'enter' });
    const a = C.loadConfig();
    C.saveConfig({ sendHotkey: 'bogus' });
    const b = C.loadConfig();
    const s = C.statusPayload();
    out({ enterOk: a.sendHotkey === 'enter', normOk: b.sendHotkey === 'ctrlEnter', echoOk: typeof s.sendHotkey === 'string' });
  }

  out({ error: 'unknown case: ' + kase });
})().catch((e) => { process.stdout.write(JSON.stringify({ error: e.message })); process.exit(0); });
