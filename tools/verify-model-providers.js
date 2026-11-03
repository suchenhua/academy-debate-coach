#!/usr/bin/env node
/* 设置→模型「服务商 + 模型列表」回归验证 —— Electron 真实渲染。
   跑法：electron.exe tools/verify-model-providers.js <项目根> <输出json>
   前置：隔离数据目录的服务已在 PATROL_PORT（默认 8795）上跑。 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-model-providers.json');
const PORT = process.env.PATROL_PORT || '8795';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify-models'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/');
  await sleep(2200);
  const ex = (code) => win.webContents.executeJavaScript(code);
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? '  OK  ' : '  FAIL') + ' ' + name + (detail ? ' · ' + detail : '')); };
  /* 等条件成立再断言：切换模型要串两次服务端往返 + 一次目录重载，
     固定 sleep 会随机器快慢时好时坏（会假红，也会掩盖真的没生效）。 */
  const waitFor = async (probe, ms) => {
    const deadline = Date.now() + (ms || 6000);
    let last;
    while (Date.now() < deadline) {
      last = await probe();
      if (last) return last;
      await sleep(200);
    }
    return last;
  };

  try {
    /* 直接给隔离数据目录写一份「两家服务商、各带多个模型」的档案，
       这样断言的是“渲染与交互”，不需要真的连网。 */
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], model: 'deepseek-flash', apiKey: 'sk-test-aaaa' }),
    }).then((x) => x.json());
    check('POST /api/profiles 接受 models 数组', r.ok && r.profile && Array.isArray(r.profile.models) && r.profile.models.length === 2, JSON.stringify(r.profile && r.profile.models));

    const r2 = await fetch('http://127.0.0.1:' + PORT + '/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', models: [{ id: 'Qwen/Qwen2.5-72B-Instruct' }], model: 'Qwen/Qwen2.5-72B-Instruct', apiKey: 'sk-test-bbbb' }),
    }).then((x) => x.json());
    check('第二家服务商可独立保存', r2.ok && r2.profile.model === 'Qwen/Qwen2.5-72B-Instruct');

    /* 编辑：把第一家的模型列表整体替换（删掉一个）+ 切换当前模型 */
    const list = await fetch('http://127.0.0.1:' + PORT + '/api/profiles').then((x) => x.json());
    const deep = list.profiles.find((p) => p.name === 'DeepSeek 官方');
    const r3 = await fetch('http://127.0.0.1:' + PORT + '/api/profiles/' + encodeURIComponent(deep.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: [{ id: 'deepseek-v4-pro' }], model: 'deepseek-v4-pro' }),
    }).then((x) => x.json());
    check('★ 模型列表按值整体替换（能真的删掉）', r3.ok && r3.profile.models.length === 1 && r3.profile.models[0].id === 'deepseek-v4-pro', JSON.stringify(r3.profile && r3.profile.models));
    check('★ 当前模型可切换到列表里的另一个', r3.profile.model === 'deepseek-v4-pro');

    /* 传一个「选中的模型不在列表里」→ 服务端把它并进列表（不留下“选中的不属于这家”） */
    const r4 = await fetch('http://127.0.0.1:' + PORT + '/api/profiles/' + encodeURIComponent(deep.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: [{ id: 'a' }, { id: 'b' }], model: 'not-in-list' }),
    }).then((x) => x.json());
    check('★ 选中的模型不在列表里时并进列表，绝不留悬挂选中',
      r4.ok && r4.profile.model === 'not-in-list' && r4.profile.models.some((m) => m.id === 'not-in-list'),
      'model=' + (r4.profile && r4.profile.model) + ' models=' + JSON.stringify(r4.profile && r4.profile.models.map((m) => m.id)));

    /* ★ 一致性：新建配置必须**同时**改 activeId。
       否则 config.json（真的生效的那份）与 profiles.json 的 activeId 会分叉 ——
       表现为顶栏徽标显示新模型、对话框模型席显示老模型（2026-10-15 实际观察到过）。 */
    const beforeNew = await fetch('http://127.0.0.1:' + PORT + '/api/profiles').then((x) => x.json());
    const rNew = await fetch('http://127.0.0.1:' + PORT + '/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '新建的第三家', baseUrl: 'https://api.moonshot.cn/v1', models: [{ id: 'moonshot-v1-8k' }], model: 'moonshot-v1-8k', apiKey: 'sk-new-3333' }),
    }).then((x) => x.json());
    const afterNew = await fetch('http://127.0.0.1:' + PORT + '/api/profiles').then((x) => x.json());
    const cfgAfter = await fetch('http://127.0.0.1:' + PORT + '/api/config').then((x) => x.json());
    check('★ 新建配置后 activeId 指向新配置（不再和 config.json 分叉）',
      rNew.ok && afterNew.activeId === rNew.id && cfgAfter.config.model === 'moonshot-v1-8k',
      'activeId=' + afterNew.activeId + ' newId=' + rNew.id + ' cfg.model=' + cfgAfter.config.model + ' before=' + beforeNew.activeId);

    /* 删掉它，别影响后面的 UI 断言 */
    await fetch('http://127.0.0.1:' + PORT + '/api/profiles/' + encodeURIComponent(rNew.id), { method: 'DELETE' });

    /* 收窄成干净的两模型档案，后面 UI 断言就基于这个已知状态 */
    const r5 = await fetch('http://127.0.0.1:' + PORT + '/api/profiles/' + encodeURIComponent(deep.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }], model: 'deepseek-flash' }),
    }).then((x) => x.json());
    check('收窄回两个模型的已知状态', r5.ok && r5.profile.models.length === 2);

    await win.webContents.reload();
    await sleep(2200);
    await ex('document.getElementById("btnSettings").click();');
    await sleep(900);

    const rows = await ex('(function(){ return Array.from(document.querySelectorAll("#providerRows .provider-row")).map(function(el){ return el.innerText.replace(/\\s+/g," ").trim(); }); })()');
    check('★ 一家服务商 = 一行（两家 → 两行）', rows.length === 2, JSON.stringify(rows));
    check('行里有「几个模型」和「当前：模型」', /2 个模型/.test(rows.join(' ')) && /当前：deepseek-flash/.test(rows.join(' ')), JSON.stringify(rows));
    check('当前生效的那家被标成「对话中」', rows.some((t) => /对话中/.test(t)), JSON.stringify(rows));

    const oldUi = await ex('(function(){ return { list: !!document.getElementById("profilesListBody"), newBtn: !!document.getElementById("btnNewProfile"), sel: !!document.getElementById("modelSelect") }; })()');
    check('旧的左侧配置列表 / 模型下拉已移除', oldUi.list === false && oldUi.newBtn === false && oldUi.sel === false, JSON.stringify(oldUi));

    /* 打开编辑卡：断言模型列表行 + 选择圆点 */
    await ex('(function(){ var b=document.querySelectorAll("#providerRows .provider-row .pr-actions button"); b[0].click(); return 1; })()');
    await sleep(500);
    const ed = await ex('(function(){ var box=document.getElementById("providerEditor"); var rows=Array.from(document.querySelectorAll("#modelRows .model-row-item")); return { open: box && !box.classList.contains("hidden"), n: rows.length, active: rows.filter(function(x){return x.classList.contains("active");}).length, count: (document.getElementById("modelListCount")||{}).textContent||"" }; })()');
    check('点「编辑」打开行内编辑卡', ed.open === true);
    check('★ 编辑卡里列出这家全部模型', ed.n === 2, 'rows=' + ed.n);
    check('★ 有且仅有一个「对话时用哪个」被选中', ed.active === 1, 'active=' + ed.active);
    check('★ 编辑卡只列这一家的模型（不是全部服务商的）', ed.n === 2, 'rows=' + ed.n);
    check('标题上标出模型总数', /共 2 个/.test(ed.count), ed.count);

    /* 手动加一个模型 */
    await ex('(function(){ var i=document.getElementById("modelInput"); i.value="deepseek-reasoner"; document.getElementById("btnAddModel").click(); return 1; })()');
    await sleep(300);
    const added = await ex('document.querySelectorAll("#modelRows .model-row-item").length');
    check('★ 手动添加模型进入列表', added === 3, 'rows=' + added);

    /* 保存后：编辑卡收起、行上出现新计数（证明草稿真的写回了服务端） */
    await ex('document.getElementById("btnSaveProfile").click();');
    await sleep(900);
    const afterSave = await ex('(function(){ return { rows: Array.from(document.querySelectorAll("#providerRows .provider-row")).map(function(el){return el.innerText.replace(/\\s+/g," ").trim();}) }; })()');
    check('★ 保存后行上的模型数变成 3（草稿写回服务端）', /3 个模型/.test(afterSave.rows.join(' ')), JSON.stringify(afterSave.rows));

    /* 对话席：点开模型菜单，断言按服务商分组（数据是设置里刚存的那份） */
    await ex('(function(){ document.getElementById("settingsModal").classList.add("hidden"); return loadProfilesUI({ keepEditor: true }); })()');
    await sleep(400);
    await ex('(function(){ var s=document.getElementById("gearSeat"); if(s) s.click(); return 1; })()');
    await sleep(500);
    const menu = await ex('(function(){ var l=document.getElementById("gearModelList"); var groups=Array.from(document.querySelectorAll("#gearModelList .gear-model-group")); var opts=Array.from(document.querySelectorAll("#gearModelList .gear-model-option")); return { groups: groups.length, opts: opts.length, titles: groups.map(function(g){return (g.querySelector(".gear-model-group-title")||{}).textContent||"";}), selected: opts.filter(function(o){return o.classList.contains("selected");}).length, value: (document.getElementById("gearModelValue")||{}).textContent||"", profilesN: (state.profiles||[]).length, inner: l ? l.innerHTML.slice(0,180) : "(no list)" }; })()');
    const diag = 'groups=' + menu.groups + ' opts=' + menu.opts + ' profilesN=' + menu.profilesN + ' inner=' + menu.inner;
    check('★ 对话框模型席按服务商分组', menu.groups === 2, diag);
    check('★ 分组里列出各家的模型', menu.opts >= 2, diag);
    check('★ 当前模型高亮唯一', menu.selected === 1, diag);
    check('模型席显示当前模型名', !!menu.value, menu.value);

    /* ★ 真正的用户动作：在对话框里点另一个模型 → 必须真的切过去。
       这一条是整件事的目的（「一家服务商多个模型，随时换」），必须端到端断言到服务端。 */
    const target = await ex('(function(){ var o=Array.from(document.querySelectorAll("#gearModelList .gear-model-option")); var t=o.filter(function(x){return x.querySelector(".gmo-name").textContent==="deepseek-v4-pro";})[0]; if(!t) return null; t.click(); return "deepseek-v4-pro"; })()');
    check('对话框模型席里点得到「另一个模型」', target === 'deepseek-v4-pro', String(target));
    const cfgSw = await waitFor(async () => {
      const c = await fetch('http://127.0.0.1:' + PORT + '/api/config').then((x) => x.json());
      return c.config.model === 'deepseek-v4-pro' ? c : null;
    }) || await fetch('http://127.0.0.1:' + PORT + '/api/config').then((x) => x.json());
    const sw = await ex('(function(){ return { seat: (document.getElementById("gearModel")||{}).textContent||"", value: (document.getElementById("gearModelValue")||{}).textContent||"", selected: Array.from(document.querySelectorAll("#gearModelList .gear-model-option.selected")).map(function(x){return x.querySelector(".gmo-name").textContent;}) }; })()');
    check('★ 点一下就真的切了模型（服务端 config.model 已更新）', cfgSw.config.model === 'deepseek-v4-pro', 'cfg.model=' + cfgSw.config.model);
    check('★ 切换后模型席 / 收起态都显示新模型', sw.value === 'deepseek-v4-pro' && /deepseek-v4-pro/.test(sw.seat), JSON.stringify(sw));
    check('★ 切换后高亮跟着走（仍唯一）', sw.selected.length === 1 && sw.selected[0] === 'deepseek-v4-pro', JSON.stringify(sw.selected));

    /* 换到另一家服务商的模型：服务商也要跟着切 */
    const target2 = await ex('(function(){ var o=Array.from(document.querySelectorAll("#gearModelList .gear-model-option")); var t=o.filter(function(x){return x.querySelector(".gmo-name").textContent==="Qwen/Qwen2.5-72B-Instruct";})[0]; if(!t) return null; t.click(); return "Qwen/Qwen2.5-72B-Instruct"; })()');
    check('对话框模型席里点得到「另一家的模型」', target2 === 'Qwen/Qwen2.5-72B-Instruct', String(target2));
    await waitFor(async () => {
      const c = await fetch('http://127.0.0.1:' + PORT + '/api/config').then((x) => x.json());
      return c.config.model === 'Qwen/Qwen2.5-72B-Instruct' ? c : null;
    });
    const cfgSw2 = await fetch('http://127.0.0.1:' + PORT + '/api/config').then((x) => x.json());
    const listSw2 = await fetch('http://127.0.0.1:' + PORT + '/api/profiles').then((x) => x.json());
    const activeNow = listSw2.profiles.find((p) => p.id === listSw2.activeId);
    check('★ 跨服务商换模型时服务商一起切（activeId 与 config 一致）',
      activeNow && activeNow.name === '硅基流动' && cfgSw2.config.model === 'Qwen/Qwen2.5-72B-Instruct' && cfgSw2.config.baseUrl.indexOf('siliconflow') >= 0,
      'active=' + (activeNow && activeNow.name) + ' model=' + cfgSw2.config.model + ' base=' + cfgSw2.config.baseUrl);
  } catch (e) {
    check('验证过程未抛错', false, e.message);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const bad = results.filter((x) => !x.ok);
  console.log('---- ' + (results.length - bad.length) + '/' + results.length + ' 通过 ----');
  app.exit(bad.length ? 1 : 0);
});
