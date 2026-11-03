#!/usr/bin/env node
/* 老档案迁移 + 模型选择器交互 回归验证（真实渲染）。 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ROOT = process.argv[2];
const OUT = process.argv[3] || path.join(ROOT, '.build', 'verify-model-migration.json');
const PORT = process.env.PATROL_PORT || '8796';
const DATA = process.env.ACADEMY_DATA_DIR || path.join(ROOT, 'data');
app.setPath('userData', path.join(DATA, 'electron-user-data-verify-mig'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? '  OK  ' : '  FAIL') + ' ' + name + (detail ? ' · ' + detail : '')); };
  try {
    /* —— 1) 老档案（只有单个 model 字段，没有 models）—— */
    fs.writeFileSync(path.join(DATA, 'profiles.json'), JSON.stringify({
      activeId: 'cfg_old',
      profiles: [
        { id: 'cfg_old', name: '老的 DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-old-1111', created: 1 },
        { id: 'cfg_old2', name: '老的硅基', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', apiKey: 'sk-old-2222', created: 2 },
      ],
    }, null, 2), 'utf8');

    const list = await fetch('http://127.0.0.1:' + PORT + '/api/profiles').then((x) => x.json());
    const old = list.profiles.find((p) => p.id === 'cfg_old');
    check('★ 老档案（只有 model）迁移成 models 列表', !!old && Array.isArray(old.models) && old.models.length === 1 && old.models[0].id === 'deepseek-chat', JSON.stringify(old && old.models));
    check('★ 迁移后当前模型仍是原来那个', old && old.model === 'deepseek-chat', old && old.model);
    check('老档案的 Key 未被破坏', old && old.hasKey === true && old.keyMasked === 'sk-o****1111', old && old.keyMasked);
    check('两家老档案都在', list.profiles.length === 2 && list.activeId === 'cfg_old');

    /* —— 2) 新档案字段规范化：去重 / 非法条目丢弃 / 容量只在正数时保留 —— */
    const norm = await fetch('http://127.0.0.1:' + PORT + '/api/profiles/cfg_old', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: [
        { id: 'a', name: 'A 模型', contextWindow: 131072, maxTokens: 8192 },
        { id: 'a' },
        { id: '' },
        'plain-string',
        { id: 'b', contextWindow: -5, maxTokens: 'nope' },
      ], model: 'b' }),
    }).then((x) => x.json());
    check('★ 重复 id 去重、空/非法条目丢弃', norm.ok && norm.profile.models.map((m) => m.id).join(',') === 'a,plain-string,b', JSON.stringify(norm.profile.models));
    check('合法容量保留、非法容量不写入', norm.profile.models[0].contextWindow === 131072 && norm.profile.models[0].maxTokens === 8192 && norm.profile.models[2].contextWindow === undefined, JSON.stringify(norm.profile.models));

    /* 显示名与容量必须能穿过一次「读出来 → 原样写回」而不被抹掉
       （设置面板保存时若只发 {id}，这些字段会被静默清空） */
    const reread = await fetch('http://127.0.0.1:' + PORT + '/api/profiles/cfg_old', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: norm.profile.models, model: norm.profile.model }),
    }).then((x) => x.json());
    const keep = reread.profile.models.find((m) => m.id === 'a') || {};
    check('★ 显示名 / 容量穿过「读出来原样写回」不丢', keep.name === 'A 模型' && keep.contextWindow === 131072 && keep.maxTokens === 8192, JSON.stringify(keep));

    /* —— 3) 模型选择器交互（真实 DOM）—— */
    const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await win.loadURL('http://127.0.0.1:' + PORT + '/');
    await sleep(2200);
    const ex = (c) => win.webContents.executeJavaScript(c);
    await ex('document.getElementById("btnSettings").click();');
    await sleep(700);
    /* 直接把候选灌进选择器，断言的是交互而不是网络 */
    await ex('(function(){ openModelPicker([{id:"alpha-1",ownedBy:"acme"},{id:"alpha-2"},{id:"beta-1",ownedBy:"acme"}]); return 1; })()');
    await sleep(300);
    const p1 = await ex('(function(){ return { open: !document.getElementById("modelPicker").classList.contains("hidden"), n: document.querySelectorAll("#modelPickList .mp-item").length, checked: document.querySelectorAll("#modelPickList .mp-item input:checked").length }; })()');
    check('★ 「获取可用模型」打开选择器（默认全不勾）', p1.open && p1.n === 3 && p1.checked === 0, JSON.stringify(p1));

    /* 搜索过滤 */
    await ex('(function(){ var s=document.getElementById("modelPickSearch"); s.value="alpha"; s.dispatchEvent(new Event("input",{bubbles:true})); return 1; })()');
    await sleep(250);
    const p2 = await ex('(function(){ return { n: document.querySelectorAll("#modelPickList .mp-item").length }; })()');
    check('★ 搜索能过滤候选', p2.n === 2, 'n=' + p2.n);

    /* 勾一个可见项 → 全选 → 只影响可见项 */
    await ex('(function(){ document.querySelectorAll("#modelPickList .mp-item input")[0].click(); return 1; })()');
    await sleep(150);
    await ex('document.getElementById("btnPickAll").click();');
    await sleep(200);
    const p3 = await ex('(function(){ return { checkedVisible: document.querySelectorAll("#modelPickList .mp-item input:checked").length }; })()');
    check('★ 全选只作用于当前可见结果', p3.checkedVisible === 2, 'checked=' + p3.checkedVisible);

    /* 清空搜索 → 隐藏项不该被「全选」误勾 */
    await ex('(function(){ var s=document.getElementById("modelPickSearch"); s.value=""; s.dispatchEvent(new Event("input",{bubbles:true})); return 1; })()');
    await sleep(250);
    const p4 = await ex('(function(){ var c=document.querySelectorAll("#modelPickList .mp-item input"); return { total:c.length, checked: Array.prototype.filter.call(c,function(x){return x.checked;}).length }; })()');
    check('★ 隐藏项没有被「全选」勾上（不会误加）', p4.total === 3 && p4.checked === 2, JSON.stringify(p4));

    /* 取消全选 → 清空全部可见 */
    await ex('document.getElementById("btnPickNone").click();');
    await sleep(200);
    const p5 = await ex('(function(){ return Array.prototype.filter.call(document.querySelectorAll("#modelPickList .mp-item input"),function(x){return x.checked;}).length; })()');
    check('★ 取消全选清空勾选', p5 === 0, 'checked=' + p5);

    /* 只勾一个 → 添加所选 → 进模型列表 */
    await ex('(function(){ openModelPicker([{id:"alpha-1"},{id:"alpha-2"}]); return 1; })()');
    await sleep(250);
    await ex('(function(){ document.querySelectorAll("#modelPickList .mp-item input")[0].click(); return 1; })()');
    await sleep(150);
    const before = await ex('document.querySelectorAll("#modelRows .model-row-item").length');
    await ex('document.getElementById("btnPickAdd").click();');
    await sleep(300);
    const p6 = await ex('(function(){ return { n: document.querySelectorAll("#modelRows .model-row-item").length, pickerOpen: !document.getElementById("modelPicker").classList.contains("hidden") }; })()');
    check('★ 「添加所选」把勾选的模型并进列表', p6.n === before + 1, before + ' -> ' + p6.n);
    check('添加后选择器收起', p6.pickerOpen === false);

    /* 不勾就点添加：要有反馈，不能静默 */
    await ex('(function(){ openModelPicker([{id:"gamma"}]); return 1; })()');
    await sleep(250);
    await ex('document.getElementById("btnPickAdd").click();');
    await sleep(200);
    const p7 = await ex('(function(){ return { msg: (document.getElementById("modelPickStatus")||{}).textContent||"", open: !document.getElementById("modelPicker").classList.contains("hidden") }; })()');
    check('没勾选就点「添加所选」会提示且不关闭', p7.open === true && /勾选/.test(p7.msg), JSON.stringify(p7));
  } catch (e) {
    check('验证过程未抛错', false, e.message);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  const bad = results.filter((x) => !x.ok);
  console.log('---- ' + (results.length - bad.length) + '/' + results.length + ' 通过 ----');
  app.exit(bad.length ? 1 : 0);
});
