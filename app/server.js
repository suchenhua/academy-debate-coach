#!/usr/bin/env node
/*
 * Academy 辩论教练 · 本地桌面版服务
 *
 * 职责：
 *   1. 提供一个纯本地的 HTTP 服务（默认 127.0.0.1:8787）
 *   2. 把「DSH 极简内核」（dsh --profile headless）封装成可调用的 Agent：
 *      - 任务写入工作区 data/tasks/*.md（避免 Windows 命令行长度限制）
 *      - 用内置 node.exe 启动 dsh，工作区 cwd = 应用根目录
 *      - DSH_HOME 隔离在 data/.dsh，API Key 只通过子进程环境变量透传
 *   3. 通过 SSE 把运行状态推给 HTML 前端
 *
 * 调用契约（来自 DSH 内核的 headless 用法）：
 *   - 入口：runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
 *   - stdout = 最终回复文本；exit 0 = 完成，非 0 = 出错
 *   - 凭证：DEEPSEEK_API_KEY 环境变量
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec, spawnSync } = require('child_process');
const { markdownToDocx } = require('./docx');
const { extractPdfText } = require('./pdf-text');
const { extractDocxText } = require('./docx-text');
const { ocrImageBuffer, ocrStatus, IMAGE_EXT: OCR_IMAGE_EXT } = require('./ocr-win');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const TASK_DIR = path.join(DATA_DIR, 'tasks');
const DSH_HOME = path.join(DATA_DIR, '.dsh');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.md');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SETTINGS_FILE = path.join(DSH_HOME, 'settings.yaml');
const PERSONA_PATCH = path.join(ROOT, 'runtime', 'persona.patch.yml');
/* 正文流式插件（见 runtime/persona.patch.yml 的 academy-text-stream 行）。
   它是逐字显示的关键：headless 内核会丢弃 text-delta，正文只在结束时整段输出。
   文件若缺失（漏打包 / 被杀软误删），内核会整个加载失败、用户只看到「Agent 运行失败」，
   所以启动时做一次自愈：缺失即从内置副本写回。 */
const STREAM_PLUGIN = path.join(ROOT, 'runtime', 'academy-text-stream.mjs');
const STREAM_PLUGIN_SRC = `/**
 * academy-text-stream — 把 assistant 正文的实时增量写到 stderr，供桌面 App 边生成边显示。
 *
 * 背景：dsh-headless 内嵌的 streamReasoning 只把 reasoning-delta 写 stderr，
 * text-delta 被直接丢弃，正文只在结束时整段写到 stdout —— 表现为「卡很久 + 一段一段蹦」。
 * 解法：不改内核文件，用 --patch 的 insert 挂上本插件，订阅 agent/assistant-stream，
 * 把 text-delta 按行推给 App。通道选 stderr（App 已在读它），无需新增端口或协议；
 * stdout 的最终全文仍是权威结果，二者不冲突。
 */
export const name = 'academy-text-stream'

export function apply(ctx) {
  ctx.on('agent/assistant-stream', (payload) => {
    const frame = payload && payload.frame
    if (!frame || frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!chunk || chunk.type !== 'text-delta') return
    if (!chunk.text) return
    try { process.stderr.write('ACA-TEXT:' + JSON.stringify(chunk.text) + '\\n') } catch (_) {}
  })
}
`;
function ensureStreamPlugin() {
  try {
    if (fs.existsSync(STREAM_PLUGIN)) return;
    fs.writeFileSync(STREAM_PLUGIN, STREAM_PLUGIN_SRC, 'utf8');
    console.log('[stream] 已恢复正文流式插件（原文件缺失）');
  } catch (e) {
    console.log('[stream] 插件恢复失败：' + e.message);
  }
}

/* 把补丁模板实例化成本机可用的补丁。
   为什么需要：patch loader 只认**绝对路径**（相对路径会按 profile 目录解析，内核起不来），
   但分发包里绝不能带开发机路径（既是隐私泄露，换台机器也必然失效）。
   所以模板里存相对占位，运行时把补丁生成到 data/ 下使用 ——
   runtime/ 里的模板保持原样：开发目录同时就是打包目录，一旦就地改写，
   跑一次 App 就会把模板写脏、下次打包又把开发机路径带进去。 */
function materializePatch() {
  try {
    if (!fs.existsSync(PERSONA_PATCH)) return PERSONA_PATCH;
    const src = fs.readFileSync(PERSONA_PATCH, 'utf8');
    const abs = STREAM_PLUGIN.replace(/\\/g, '/');
    const next = src.replace(/^(\s*name:\s*).*academy-text-stream\.mjs\s*$/m, '$1' + abs);
    if (next === src) return PERSONA_PATCH;   // 模板里已是绝对路径（手工改过）→ 直接用
    ensureDir(DATA_DIR);
    const out = path.join(DATA_DIR, 'persona.patch.yml');
    let cur = '';
    try { cur = fs.readFileSync(out, 'utf8'); } catch (_) {}
    if (cur !== next) fs.writeFileSync(out, next, 'utf8');
    return out;
  } catch (e) {
    console.log('[stream] 补丁实例化失败（回退用模板）：' + e.message);
    return PERSONA_PATCH;
  }
}
/* 用量账本（append-only）：每次对话跑完追加一行 jsonl。
   为什么要独立账本：原先用量挂在「每条消息」上，删掉对话 = 那段消耗凭空消失，
   统计变成幸存者偏差。账本只增不改，删对话不影响历史消耗。 */
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');

// 发行版本号与版本线：单一来源是 app/edition.js（按 ACADEMY_EDITION 环境变量 /
// pack.js --edition 选择版本线；不指定时默认 flash）。改版本号去 app/edition.js，不在这里改。
// pack.js 会按当前版本线自检 README 与 tools/sfx/SfxLauncher.cs 的一致性。
const edition = require('./edition');
const APP_VERSION = edition.version;   // 必须保持 X.Y.Z 三段式
const APP_EDITION = edition.name;      // 展示用版本线名（Flash / Pro）
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_PORT = 8787;
const MAX_BODY = 6 * 1024 * 1024; // 允许粘贴很长的比赛文字稿
const HISTORY_ROUNDS = 6;         // 带进任务单的最近对话轮数
const HISTORY_ITEM_LIMIT = 2400;  // 单条历史消息截断长度
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/* 模型上下文窗口表（与 writeDshSettings 的 presetModels 保持一致，供流式 usage 下发用） */
const MODEL_CTX = {
  'deepseek-flash': 1048576,      // DeepSeek-V4.1-Flash（现行主力，1M）
  'deepseek-v4-pro': 1048576,     // DeepSeek-V4-Pro-0813（1M）
  'deepseek-v4-flash': 1048576,
  'deepseek-chat': 131072,        // 旧版 V3，保留兼容
  'deepseek-reasoner': 131072,    // 旧版 R1，保留兼容
};
function ctxWindowOf(mid) { return MODEL_CTX[String(mid || '')] || 131072; }

/* ---------------- 个人资料库 ---------------- */
const LIB_DIR = path.join(DATA_DIR, 'library');
const LIB_FILES_DIR = path.join(LIB_DIR, 'files');
const LIB_TEXT_DIR = path.join(LIB_DIR, 'text');
const LIB_INDEX = path.join(LIB_DIR, 'index.json');
const LIB_MAX_FILE = 16 * 1024 * 1024;   // 单份原件上限 16MB
const LIB_MAX_TEXT = 600000;             // 单份提取文本上限（字符）
const LIB_RECALL_DOCS = 4;               // 每次任务最多召回几份
const LIB_DOC_SNIPPET = 600;             // 每份最多摘多少字进任务单
const LIB_TOTAL_SNIPPET = 3200;          // 资料库片段总字数上限（防止任务单膨胀）
const INLINE_TASK_LIMIT = 20000;         // 任务单内联到命令行的字数上限（超过则先自动裁剪）
const SKILL_USER_DIR = path.join(DSH_HOME, 'skills');   // 用户技能：内核会自动扫描 DSH_HOME/skills
const SKILL_BUNDLED_DIR = path.join(ROOT, '.dsh', 'skills'); // 内置技能（随安装包分发，只读）
const SKILL_MAX_FILE = 512 * 1024; // 单份技能上限
const DELIVER_DIR = path.join(DATA_DIR, 'deliverables');   // 产物空间：Agent 输出的文件都在这里
/* 辩题档案夹：按辩题归集对话与产物（caseIndex 只是一个轻量索引 json，
   真实文件仍在 chats/ 与 deliverables/ 原处，删索引不会删数据） */
const CASE_INDEX = path.join(DATA_DIR, 'cases.json');
const DELIVER_MAX_FILE = 30 * 1024 * 1024;                 // 单份产物读取上限

/* ---------------- 工具函数 ---------------- */
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
}

function now() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try { fs.renameSync(tmp, file); } catch (_) {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '********';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    // 故意不带 Access-Control-Allow-Origin：主窗口与本服务的工具页都是同源 HTTP 加载，
    // 不需要 CORS；本机 file:// 轻量窗（研究台/阅读窗）走 IPC→主进程 http 转发，也不需要。
    // 对浏览器放开 * 等于允许任意网页读取本机记忆/对话/配置，属于真实数据泄露面。
  });
  res.end(body);
}

/* 本机接口来源校验：
   1) Host 必须是 127.0.0.1 / localhost / [::1]——防 DNS rebinding（恶意域名解析到 127.0.0.1，
      但浏览器请求头里的 Host 仍是攻击者域名，直接拒绝）。
   2) 浏览器跨源请求会带 Origin 头：不是本机来源（含 'null'，即 file:// 页面或沙箱 iframe
      发起的跨源调用）一律拒绝。恶意网页既读不到响应（无 CORS），也打不进写接口（Origin 拒绝）。
   本机的 file:// 轻量窗都经 IPC → 主进程 http.request 转发，不带 Origin，不受影响。 */
function localOriginOk(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(o.hostname);
  } catch (_) { return false; }
}

/* ---------------- 配置 ---------------- */
const DEFAULT_BASE_URL = 'https://api.deepseek.com';

function normalizeBaseUrl(url) {
  let u = String(url || DEFAULT_BASE_URL).trim();
  if (!u) u = DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

function chatCompletionsUrl(baseUrl) {
  const u = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(u)) return u;
  return u + '/chat/completions';
}

function defaultConfig() {
  return {
    apiKey: '', model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL,
    searchProvider: 'server', searchApiKey: '', timeoutMs: DEFAULT_TIMEOUT_MS,
    libraryEnabled: true, extendedTools: false,
    // 自定义搜索服务（学习 RikkaHub 的插件式思路）：
    // 内置的免费抓取（Bing/DDG）在部分网络下会被反爬返回无关结果，
    // 与其塞一个必然失败的免费通道，不如让用户接入自己可用的搜索服务。
    customSearch: defaultCustomSearch(),
  };
}

/* 自定义搜索服务配置。
   设计成「开放适配器」而不是硬编码十几家 API：
   用户填请求地址模板 + 字段路径，任何返回 JSON 的搜索服务都能接。
   urlTemplate 里的 {query} 会被替换为 URL 编码后的关键词。 */
function defaultCustomSearch() {
  return {
    enabled: false,
    name: '',
    urlTemplate: '',        // 例：https://api.tavily.com/search?q={query}
    method: 'GET',          // GET / POST
    headers: '',            // 每行一个「名称: 值」，值里可用 {apiKey}
    bodyTemplate: '',       // POST 时的请求体模板（JSON 字符串），可用 {query} {apiKey}
    apiKey: '',
    // 结果字段路径：从响应 JSON 里取数组、数组里取字段
    resultsPath: 'results', // 结果数组的路径，如 data / results / web.results
    titlePath: 'title',
    urlPath: 'url',
    snippetPath: 'content', // 摘要字段，可为空
  };
}

function loadConfig() {
  const cfg = Object.assign(defaultConfig(), readJson(CONFIG_FILE, {}));
  cfg.baseUrl = normalizeBaseUrl(cfg.baseUrl);
  return cfg;
}

/* 搜索 Key 只用设置里明确填写的；绝不自动读取本机 DSH 凭证，避免误扣用户 DeepSeek 余额 */

function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch);
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl);
  next.model = String(next.model || DEFAULT_MODEL).trim();
  if (patch.searchApiKey !== undefined) next.searchApiKey = String(next.searchApiKey || '').trim();
  if (patch.searchProvider !== undefined) next.searchProvider = ['server', 'free'].includes(patch.searchProvider) ? patch.searchProvider : 'server';
  writeJsonAtomic(CONFIG_FILE, next);
  writeDshSettings(next.model, next.baseUrl, effectiveSearchKey(next), resolveSearchProvider(next));
  return next;
}

function isDeepSeekBase(cfg) {
  return normalizeBaseUrl((cfg || loadConfig()).baseUrl).includes('api.deepseek.com');
}

/* 服务侧搜索复用当前模型的主 Key（同一家服务商）；端侧免费不需要 */
function effectiveSearchKey(cfg) {
  const c = cfg || loadConfig();
  if (c.apiKey && c.apiKey.trim()) return c.apiKey.trim();
  return '';
}

/* server = 走当前模型提供方的服务侧搜索；free = 本地免费端侧（Bing/DuckDuckGo） */
function resolveSearchProvider(cfg) {
  const c = cfg || loadConfig();
  return c.searchProvider === 'free' ? 'free' : 'server';
}

/* 把模型/API 地址/搜索服务写进 DSH 的 settings.yaml
   searchProvider 已解析：server（服务侧）/ free（端侧） */
function writeDshSettings(model, baseUrl, searchApiKey, searchProvider) {
  const modelId = String(model || DEFAULT_MODEL).trim();
  const base = normalizeBaseUrl(baseUrl);
  const esc = (s) => JSON.stringify(String(s)); // YAML 双引号字符串
  const provider = searchProvider || 'free';
  const effectiveSearch = searchApiKey && searchApiKey.trim();
  const presetModels = [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', ctx: 1048576, max: 393216 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', ctx: 1048576, max: 393216 },
    { id: 'deepseek-chat', name: 'DeepSeek-V3 (deepseek-chat)', ctx: 131072, max: 65536 },
    { id: 'deepseek-reasoner', name: 'DeepSeek-R1 (deepseek-reasoner)', ctx: 131072, max: 65536 },
    { id: modelId, name: modelId, ctx: 131072, max: 393216 },
  ];
  function modelContextWindow(mid) {
    const id = String(mid || '');
    const hit = presetModels.find((m) => m.id === id);
    return hit ? hit.ctx : 131072;
  }
  const seen = new Set();
  const models = [];
  for (const m of presetModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    models.push('    - id: ' + esc(m.id),
      '      name: ' + esc(m.name),
      '      contextWindow: ' + m.ctx,
      '      maxTokens: ' + m.max);
  }
  // 搜索服务：server=走当前模型提供方的服务侧搜索（Anthropic /messages 兼容）；
  // free=App 本地搜索代理（免费 Bing/DuckDuckGo）
  const isOfficialDeepSeek = normalizeBaseUrl(base).includes('api.deepseek.com');
  const searchSection = (provider === 'server' && effectiveSearch) ? [
    '# 服务侧搜索：走当前模型提供方（当前模型 baseURL + Key 直连）',
    'web-search-deepseek:',
    '  apiKey: ' + esc(effectiveSearch),
    isOfficialDeepSeek
      ? '  baseURL: ' + esc('https://api.deepseek.com/anthropic/v1')
      : '  baseURL: ' + esc(base),
    '  model: ' + esc(modelId),
    '  maxUses: 8',
  ] : [
    '# 端侧搜索：App 本地搜索代理（免费 Bing/DuckDuckGo，0 扣费）',
    'web-search-deepseek:',
    '  apiKey: local-search',
    '  baseURL: ' + esc('http://127.0.0.1:' + (actualPort || DEFAULT_PORT) + '/internal/web-search'),
    '  model: local-search',
    '  apiVersion: 2023-06-01',
    '  maxTokens: 1024',
    '  maxUses: 8',
  ];
  const yaml = [
    '# 由 Academy 辩论教练 App 自动生成，请勿手改',
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: ' + esc(modelId),
    'llm-deepseek:',
    '  baseURL: ' + esc(base),
    '  models:',
    ...models,
    ...searchSection,
    '',
  ].join('\n');
  ensureDir(DSH_HOME);
  fs.writeFileSync(SETTINGS_FILE, yaml, 'utf8');
}

/* ---------------- 多配置模型档案（profiles） ---------------- */
/* 每个 profile = 一套「服务商 + Key + 模型」组合，可新增/编辑/删除，随时切换生效。
   config.json 保持为「当前生效」的展开形式（兼容旧版本 + 启动同步 settings.yaml）。 */
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

function loadProfiles() {
  const data = readJson(PROFILES_FILE, {});
  let profiles = Array.isArray(data.profiles) ? data.profiles : [];
  // 旧数据迁移：config.json 里有 Key 且 profiles 为空时，把它作为一个档案
  if (!profiles.length) {
    const cfg = loadConfig();
    if (cfg.apiKey && cfg.apiKey.trim()) {
      profiles.push({
        id: 'cfg_default',
        name: '默认配置',
        baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
        model: cfg.model || DEFAULT_MODEL,
        apiKey: cfg.apiKey,
        created: Date.now(),
      });
      data.activeId = 'cfg_default';
      saveProfiles({ activeId: data.activeId, profiles });
    }
  }
  return { activeId: data.activeId || (profiles.length ? profiles[0].id : null), profiles };
}

function saveProfiles(data) {
  writeJsonAtomic(PROFILES_FILE, {
    activeId: data.activeId || null,
    profiles: Array.isArray(data.profiles) ? data.profiles : [],
  });
}

function maskKeyShow(key) {
  return maskKey(key || '');
}

function profilePublic(p) {
  return {
    id: p.id,
    name: p.name || p.baseUrl,
    baseUrl: p.baseUrl || DEFAULT_BASE_URL,
    model: p.model || DEFAULT_MODEL,
    keyMasked: maskKeyShow(p.apiKey),
    hasKey: !!(p.apiKey && String(p.apiKey).trim()),
    provider: p.provider || '',
    created: p.created || 0,
  };
}

/* 把选定的 profile 写进 config.json（当前生效）+ settings.yaml（DSH 内核用） */
function activateProfile(profile) {
  if (!profile) return null;
  const cfg = saveConfig({
    apiKey: profile.apiKey || '',
    model: profile.model || DEFAULT_MODEL,
    baseUrl: profile.baseUrl || DEFAULT_BASE_URL,
    searchApiKey: loadConfig().searchApiKey,
    searchProvider: loadConfig().searchProvider,
  });
  return { cfg, profile: profilePublic(profile) };
}

/* 生成一个新 profile id */
function newProfileId() {
  return 'cfg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------------- 引擎探测 ---------------- */
function bundledNode() {
  const cands = [
    path.join(ROOT, 'runtime', 'node', 'node.exe'),
    path.join(ROOT, 'runtime', 'node', 'node'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return process.env.DSH_NODE_BIN || 'node';
}

/* 内核一律用 App 自带的标准布局 runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js。
   历史版本曾把内核镜像解压到 %LOCALAPPDATA% 绕开中文路径，该方案已废弃——
   它绕的是症状：扁平布局会破坏 Node 的 ESM 包解析（找不到 @deepseek-ai/dsh-app-boot），
   镜像只是换了个目录层级。根因修好后不再需要镜像，也省掉首次启动的 65MB 解压。 */
function dshBin() {
  const explicit = (process.env.DSH_BIN || '').trim();
  if (explicit) return explicit;
  const cands = [
    path.join(ROOT, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(ROOT, 'runtime', 'dsh', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(ROOT, 'runtime', 'dsh-npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(ROOT, 'runtime', 'dsh', 'lib', 'bin.js'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return '';
}

function engineReady() {
  return !!(bundledNode() && dshBin());
}

function statusPayload() {
  const cfg = loadConfig();
  return {
    ok: true,
    version: APP_VERSION,
    edition: APP_EDITION,
    engine: 'dsh-headless',
    dsh: !!dshBin(),
    node: !!bundledNode(),
    hasKey: !!(cfg.apiKey && cfg.apiKey.trim()),
    keyMasked: maskKey(cfg.apiKey || ''),
    model: cfg.model || DEFAULT_MODEL,
    baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
    isDeepSeek: isDeepSeekBase(cfg),
    hasSearchKey: !!effectiveSearchKey(cfg),
    searchEnabled: true,
    searchProvider: cfg.searchProvider || 'auto',
    searchMode: resolveSearchProvider(cfg), // server | free
    busy: currentRun ? true : false,
    port: actualPort || DEFAULT_PORT,
    memorySize: (() => { try { return fs.existsSync(MEMORY_FILE) ? fs.statSync(MEMORY_FILE).size : 0; } catch (_) { return 0; } })(),
  };
}

/* ---------------- 任务单 ---------------- */
const MODE_META = {
  free: { label: '自由问答', extra: '' },
  prep: {
    label: '备赛',
    extra: [
      '## 本单任务类型：备赛（辩题分析 / 立论 / 质询 / 攻防 / 一辩稿等）',
      '',
      '动笔前必须依次阅读：',
      '1. `protocols/必读加载协议.md`（备赛类）',
      '2. `protocols/核心知识最小集.md`',
      '3. `modules/prep.md`',
      '4. `prep-coach/SKILL.md`（按任务选对应小节）',
      '5. 若写稿件，再读 `protocols/templates/` 下对应模板',
      '',
      '用户若未给全辩题/持方/赛制/字数，先在回复开头列出你采用的默认假设，再继续。',
    ].join('\n'),
  },
  review: {
    label: '复盘',
    extra: [
      '## 本单任务类型：比赛复盘（文字稿逐帧纠偏）',
      '',
      '动笔前必须依次阅读：',
      '1. `protocols/必读加载协议.md`（复盘类）',
      '2. `protocols/核心知识最小集.md`',
      '3. `modules/review.md`',
      '4. `review-coach/SKILL.md`',
      '5. `protocols/templates/复盘模板.md`',
      '',
      '按比赛时间线逐帧纠偏；关键攻防处暂停，给出可以原样替换的表述；',
      '结尾给出主线形态诊断（1/2/0 型）和不超过 3 条的改进优先级。',
    ].join('\n'),
  },
  judge: {
    label: '评判',
    extra: [
      '## 本单任务类型：独立评判（评分 + 述票）',
      '',
      '动笔前必须依次阅读：',
      '1. `protocols/必读加载协议.md`（评赛/评判类）',
      '2. `protocols/核心知识最小集.md`',
      '3. `modules/judge.md`',
      '4. `judge-assistant/SKILL.md`',
      '5. `protocols/templates/评判模板.md`',
      '',
      '先确认赛制与判准；输出三票制评分明细与九段式述票词；',
      '述票词必须是可以直接照着念的完整文字。',
    ].join('\n'),
  },
  research: {
    label: '资料研究',
    extra: [
      '## 本单任务类型：资料研究（独立研究台的小助手）',
      '',
      '你的角色是【研究助手】，不是备赛教练。用户此刻在「研究台」面板里查资料，',
      '你负责让这一轮检索变得高效、有据、可复用。备赛框架分析请让用户去主窗口的「备赛」模式。',
      '',
      '### 你的职责（按优先级）',
      '',
      '1. **解读搜索结果**：用户把搜到的来源贴给你时，逐条判断——',
      '   数据是否可信（官方/一手 > 媒体转述 > 自媒体）、口径是什么、能否直接引用；',
      '   引用前给一句「可以直接上场念的话」。',
      '2. **指出下一步该搜什么**：按以下 7 种触发条件对照当前辩题，缺哪个就提示补哪个：',
      '   ① 专业学术概念（定义/学术争议/经典文献）② 政策法规（现行条文/文件全文）',
      '   ③ 新闻事件与社会现象（事件原委/统计数据/多方报道）④ 国际比较（制度差异/数据对比）',
      '   ⑤ 对方论据引用的研究/数据（原始研究方法论/样本量/结论全文）',
      '   ⑥ 历史背景（事件来龙去脉）⑦ 陌生术语/人名（定义/背景/立场）',
      '3. **整理弹药**：把确认可用的素材整理成弹药条——每条不超过 40 字、上场直接念、',
      '   标注数据来源；成链不散装。',
      '4. **守住原则**：私有资料解决「怎么打」，搜索解决「打什么」，两者互补不互相替代；',
      '   不编造数据和事实，不确定就明说不确定。',
      '',
      '### 输出格式',
      '',
      '- 回答保持紧凑（这是边查边聊的伴随面板，不是写文章的地方）；',
      '- 给结论时附来源链接或「需要进一步核实」标注；',
      '- 建议下一步搜索时直接给出可复制的搜索词（用反引号包起来）。',
    ].join('\n'),
  },
};

/* ---------------- 多级记忆（长期 memory.md + 每日流水 memory/yyyy-mm-dd.md） ---------------- */
/* QClaw 启发：长期精炼 / 每日流水 / 主动召回（关键词）+ 自动蒸馏晋升。 */
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MEMORY_FILE_MAX = 256 * 1024; // 长期 memory.md 上限

/* ---- L2：每日流水 memory/YYYY-MM-DD.md ---- */
function dailyFileFor(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(MEMORY_DIR, y + '-' + m + '-' + day + '.md');
}

/* ---------------- 注入预算与按需挑选（记忆注入瘦身） ----------------
   原实现：长期记忆「无条件全量注入」（上限 14000 字）、最近流水无上限、
   且晋升过的流水在「长期记忆」和「最近流水」里各出现一次 —— 数据量上来后
   每轮固定成本过高，且 5 档裁剪从不触碰记忆段（地板被焊死）。
   现改为：长期记忆 = 最近 N 条常驻 + 与当前问题相关的 top-N（各有字符上限）；
   流水 = 只注入未晋升部分；跨段落按内容指纹判重。 */
const MEM_LONG_MAX = 4000;    // 长期记忆段落注入上限
const MEM_DAILY_MAX = 3000;   // 最近流水段落注入上限
const MEM_ENTRY_MAX = 1500;   // 单条记忆注入上限（防一条特别长的条目吃光预算）
const MEM_CORE_ENTRIES = 3;   // 无条件常驻的最近长期记忆条数
const MEM_RECALL_ENTRIES = 5; // 按当前问题召回的长期记忆条数

/** 单条超长时截断（预算与可读性都要） */
function memClamp(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '…（本条过长已截断）' : s;
}

/** 内容指纹：判重用（与蒸馏去重同一口径 —— 去空白后取前 40 字） */
function memFingerprint(s) {
  return String(s || '').replace(/\s+/g, '').slice(0, 40);
}

function readTextFile(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch (_) { return ''; }
}

/** 记忆条目 → 注入文本（保留原有小标题） */
function memoryEntryText(title, body) {
  const b = String(body || '').trim();
  if (!b) return '';
  return (title ? '## ' + title + '\n\n' : '') + b;
}

/**
 * 按需挑选长期记忆：最近 MEM_CORE_ENTRIES 条常驻 + 与当前问题相关的 top-N。
 * 返回 { text, shown, total, fps }；fps 是「本轮真正注入」条目的指纹，供下游判重。
 */
function selectLongMemory(text) {
  const entries = parseMemoryEntries(readTextFile(MEMORY_FILE));
  const total = entries.length;
  if (!total) return { text: '', shown: 0, total: 0, fps: new Set() };

  const picked = [];                 // {title, body}
  const pickedFps = new Set();
  for (let i = total - 1; i >= 0 && picked.length < MEM_CORE_ENTRIES; i--) {
    picked.push(entries[i]);
    pickedFps.add(memFingerprint(entries[i].body));
  }
  try {
    const cap = MEM_CORE_ENTRIES + MEM_RECALL_ENTRIES;
    for (const h of memorySearch(String(text || ''), cap, { onlyLong: true })) {
      if (picked.length >= cap) break;
      const fp = memFingerprint(h.body);
      if (pickedFps.has(fp)) continue;
      pickedFps.add(fp);
      picked.push({ title: h.title, body: h.body });
    }
  } catch (_) {}

  const kept = [];
  const fps = new Set();
  let used = 0;
  for (const it of picked) {
    const chunk = memClamp(memoryEntryText(it.title, it.body), MEM_ENTRY_MAX);
    if (!chunk) continue;
    // 超预算时跳过而不是 break：先入队的「最近常驻核心」已经放进去了，优先保住它们
    if (used + chunk.length > MEM_LONG_MAX && kept.length) continue;
    kept.push(chunk);
    fps.add(memFingerprint(it.body));
    used += chunk.length + 5;
  }
  return { text: kept.join('\n\n---\n\n'), shown: kept.length, total, fps };
}

/**
 * 最近流水：只注入尚未晋升进长期记忆的部分，且有字符上限。
 * longFps = 本轮已注入的长期记忆指纹（晋升后的副本不再重复占预算）。
 */
function selectRecentDaily(daysBack, longFps, maxChars) {
  const parts = [];
  let used = 0;
  let skipped = 0;
  for (let i = daysBack; i >= 0; i--) {
    const fp = dailyFileFor(new Date(Date.now() - i * 86400000));
    const raw = readTextFile(fp).trim();
    if (!raw) continue;
    const day = path.basename(fp);
    for (const e of parseMemoryEntries(raw)) {
      const body = String(e.body || '').trim();
      if (!body) continue;
      if (longFps && longFps.has(memFingerprint(body))) { skipped++; continue; }
      const chunk = memClamp('### ' + day + ' · ' + (e.title || '备忘') + '\n\n' + body, MEM_ENTRY_MAX);
      if (used + chunk.length > maxChars) return { text: parts.join('\n\n'), skipped };
      parts.push(chunk);
      used += chunk.length + 2;
    }
  }
  return { text: parts.join('\n\n'), skipped };
}

/* ---- 长期记忆写入：同类合并 + 条目上限 ----
   合并①：已有条目内容与新内容一致（同一件事又记一遍）→ 不重复写；
   合并②：新内容完整覆盖某条旧内容 → 用新内容替换旧条（合成更全的一条）；
   上限：条目数超过 MEM_LONG_MAX_ENTRIES 时，最旧的溢出条目移入
        memory/archive-long.md（内容不丢，仍参与召回，只是不再常驻注入）。 */
const MEM_LONG_MAX_ENTRIES = 40;

function archiveLongEntries(entries) {
  if (!entries.length) return;
  ensureDir(MEMORY_DIR);
  const digest = path.join(MEMORY_DIR, 'archive-long.md');
  const prev = readTextFile(digest);
  const blocks = entries.map((e) => memoryEntryText(e.title, e.body));
  let next = (prev ? prev.replace(/\s*$/, '') + '\n\n---\n\n' : '') + blocks.join('\n\n---\n\n') + '\n';
  if (next.length > MEMORY_FILE_MAX) next = next.slice(-MEMORY_FILE_MAX);
  try { fs.writeFileSync(digest, next, 'utf8'); } catch (_) {}
}

/** 写入一条长期记忆（含合并与上限）。返回是否真的写入了。 */
function appendLongMemory(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  const entries = parseMemoryEntries(readTextFile(MEMORY_FILE));
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const nb = norm(body);

  // 合并①：完全重复 → 不写（判重必须用全文，用前缀会把「更完整的新版本」误判成重复）
  if (entries.some((e) => norm(e.body) === nb)) return false;
  // 合并②：新内容完整覆盖某条旧内容 → 用新内容替换旧条
  let list = entries.filter((e) => !(e.body && norm(e.body).length >= 20 && nb.includes(norm(e.body))));
  const iso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  list.push({ title: iso + ' · 长期记忆', body });

  if (list.length > MEM_LONG_MAX_ENTRIES) {
    archiveLongEntries(list.slice(0, list.length - MEM_LONG_MAX_ENTRIES));
    list = list.slice(list.length - MEM_LONG_MAX_ENTRIES);
  }
  memoryWriteSegments(MEMORY_FILE, list.map((e) => memoryEntryText(e.title, e.body)));
  return true;
}

/* ---- 统一追加：long=true 进长期（走合并/上限），否则进当日流水 ---- */
function appendMemory(text, opts) {
  const t = String(text || '').trim();
  if (!t) return 0;
  const toLong = !!(opts && opts.long);
  try {
    // 长期记忆：合并 + 条目上限，写完由 appendLongMemory 内部重建索引
    if (toLong) return appendLongMemory(t) ? t.length : 0;

    ensureDir(MEMORY_DIR);
    const iso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const title = iso + ' · 备忘';
    const field = dailyFileFor();
    const fileKey = path.basename(field).replace(/\.md$/, '');
    const prev = fs.existsSync(field) ? fs.readFileSync(field, 'utf8') : '';
    let next = (prev.endsWith('\n') ? prev : prev + '\n')
      + '\n\n---\n\n## ' + title + '\n\n' + t + '\n';
    if (next.length > MEMORY_FILE_MAX) next = next.slice(-MEMORY_FILE_MAX);
    fs.writeFileSync(field, next, 'utf8');

    // 增量写索引：只插这一条，不再全量重建（批量编辑走 memoryWriteSegments 的全量重建）
    try {
      memoryIndexAppend({ scope: 'daily', file: fileKey, time: iso, title, body: t });
    } catch (_) {}
    return t.length;
  } catch (_) { return 0; }
}

/* ---- 把记忆 markdown 拆成条目数组（每个 ## 标题+内容 一条） ---- */
function parseMemoryEntries(md) {
  const out = [];
  if (!md || !md.trim()) return out;
  const segs = String(md).split(/\n?---\n?/);
  let i = 0;
  for (const seg of segs) {
    const t = seg.trim();
    if (!t) continue;
    const titleM = t.match(/##+\s*(.+)/);
    const title = titleM ? titleM[1].trim() : '（未命名条目）';
    const body = t.replace(/##+\s*.+/, '').trim();
    const tsM = t.match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
    // idx = 该条目在其所属文件里的原始下标，编辑/删除时靠它定位
    out.push({ idx: i, title, body, time: tsM ? tsM[1] : '' });
    i++;
  }
  return out;
}

/* ---- 记忆编辑：定位文件 + 分段序列化回写 ---- */
function memoryDailyPath(date) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  return path.join(MEMORY_DIR, d + '.md');
}
/* scope: long -> memory.md ; daily -> memory/<YYYY-MM-DD>.md（未指定日期则用今天） */
function memoryTargetPath(scope, date) {
  if (scope === 'long') return MEMORY_FILE;
  if (scope !== 'daily') return '';
  return memoryDailyPath(date) || dailyFileFor();
}
function memorySegments(md) {
  return String(md || '').split(/\n?---\n?/).map((s) => s.trim()).filter(Boolean);
}
function memoryWriteSegments(fp, segs) {
  ensureDir(path.dirname(fp));
  let next = segs.join('\n\n---\n\n');
  if (next) next += '\n';
  if (next.length > MEMORY_FILE_MAX) next = next.slice(-MEMORY_FILE_MAX);
  fs.writeFileSync(fp, next, 'utf8');
  try { rebuildMemoryIndex(); } catch (_) {}
  return next.length;
}
/* 标题留空时自动生成带时间戳的标题（与 Agent 自动归档的格式一致） */
function memoryMakeSegment(title, body, opts) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  const long = !(opts && opts.daily);
  const head = t
    ? (/^#/.test(t) ? t : '## ' + t)
    : ('## ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + (long ? ' · 长期记忆' : ' · 备忘'));
  return b ? head + '\n\n' + b : head;
}

/* ---- 归档：<!-- MEMORY: x --> 走长期；<!-- NOTE: x --> 走当日流水 ---- */
function archiveMemoryFromOutput(stdout) {
  const reMem = /<!--\s*MEMORY:\s*([\s\S]*?)-->/g;
  const reNote = /<!--\s*NOTE:\s*([\s\S]*?)-->/g;
  let m, total = 0, cleaned = String(stdout || '');
  while ((m = reMem.exec(stdout)) !== null) {
    total += appendMemory(m[1], { long: true });
    cleaned = cleaned.replace(m[0], '');
  }
  while ((m = reNote.exec(stdout)) !== null) {
    total += appendMemory(m[1], { long: false });
    cleaned = cleaned.replace(m[0], '');
  }
  return { archived: total, cleaned };
}

/* ---- 关键词提取：CJK 二字滑窗 + 英文 token（召回 / 全文搜索共用） ---- */
const MEM_STOP_BIGRAMS = /^(我们|你们|他们|这个|那个|什么|怎么|为什么|可以|但是|如果|还是|就是|因为|所以|然后|应该|需要|一个|一种|对于|关于|进行|问题|一下|已经|现在|还有|没有|不是|可能|觉得|知道|自己|这些|那些|每个|所有|之后|之前|时候|这样|那样|今天|明天|昨天|辩题|赛制|您好|你好|谢谢|请问)$/;
function memoryExtractKeywords(text) {
  const srcText = String(text || '');
  const words = new Set();
  const cjk = srcText.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const w of cjk) {
    // 每段最多取 16 字的滑窗，够命中且不拖慢长文本
    for (let i = 0; i + 2 <= Math.min(w.length, 16); i++) {
      const seg = w.slice(i, i + 2);
      if (MEM_STOP_BIGRAMS.test(seg)) continue;
      words.add(seg);
    }
  }
  const en = srcText.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [];
  for (const w of en) words.add(w.slice(0, 5));
  return Array.from(words);
}

/* ---- 主动召回：对用户消息做全文检索，带上相关历史记忆片段。
   语料 = 长期记忆 + 全部流水（QClaw 启发：混合评分 = FTS 相关度 + 新近度）。
   最近 2 天流水已在上下文里全量注入，召回时跳过，避免重复占上下文。
   excludeFps：本轮已注入的条目指纹 —— 同一段内容不再二次注入。 ---- */
function memoryScopeLabel(scope, file) {
  if (scope === 'long') return '长期记忆';
  if (scope === 'archive') return '归档 ' + String(file || '').replace(/\.md$/, '');
  return '流水 ' + file;
}

function memoryKeywordRecall(text, history, excludeFps) {
  try {
    const srcText = String(text || '') + ' ' + (Array.isArray(history) && history.length ? String(history[history.length - 1].text || '') : '');
    if (!srcText.trim()) return [];
    const hits = memorySearch(srcText, 6, { skipRecentDays: 2 });
    const out = [];
    for (const h of hits) {
      if (excludeFps && excludeFps.has(memFingerprint(h.body))) continue;
      const head = '（来自 ' + memoryScopeLabel(h.scope, h.file)
        + (h.time ? ' · ' + h.time.slice(0, 16) : '') + '）';
      const title = h.title && !/^##\s*\d{4}/.test(h.title) ? '【' + h.title.replace(/^#+\s*/, '') + '】' : '';
      out.push(head + (title ? '\n' + title : '') + '\n' + String(h.body || '').slice(0, 400));
    }
    return out;
  } catch (_) { return []; }
}

/* ---- 自动蒸馏（QClaw「dreaming」启发）：把 2 天前的流水里有价值段落晋升到长期记忆。
   流水保留 14 天供主动召回；到期文件先把未晋升的段落整体归档到
   memory/archive-YYYY-MM.md（月度消化摘要），再删除原文件——不丢任何内容。 ---- */
const MEM_KEEP_DAYS = 14;      // 流水保留天数（供召回）
const MEM_PROMOTE_BEFORE = 2;  // 早于 N 天的流水开始尝试蒸馏晋升
/* 收紧后的晋升词：只保留「可跨场次复用的事实/约定」信号词。
   原表含 辩题/备赛/复盘/质询/结论/方法/思路 等高频词，在这类 App 里几乎每段都命中
   —— 实测 24/24 段全部晋升，长期记忆退化成流水的副本，必然撞上注入上限。
   收紧只靠「词表 + 过程性叙述排除」两件事：
   长度门槛沿用原来的 12 字（实测过，真实流水里被挡下的段落没有一段是因为长度，
   最短的也有 52 字；把门槛抬到 40 只会误伤「用户要求记住判准要一句话」这类短小事实）。 */
const MEM_PROMOTE_KWS = ['判准', '基准', '记住', '始终', '下次', '偏好', '惯例', '阈值', '口径', '默认', '准则', '禁忌', '约定', '规范', '一律', '固定'];
const MEM_PROMOTE_MIN_CHARS = 12;
const MEM_PROMOTE_DENY = /连通性测试|链路自检|第\s*\d+\s*轮|待命|空转|本次测试|测试消息|联调/;
function distillRecentNotes() {
  try {
    ensureDir(MEMORY_DIR);
    const now = Date.now();
    const ents = fs.existsSync(MEMORY_DIR) ? fs.readdirSync(MEMORY_DIR, { withFileTypes: true }) : [];
    for (const e of ents) {
      if (!e.isFile() || !/^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) continue;
      const fp = path.join(MEMORY_DIR, e.name);
      try {
        const ageDays = (now - fs.statSync(fp).mtimeMs) / 86400000;
        if (ageDays <= MEM_PROMOTE_BEFORE) continue;
        const content = fs.readFileSync(fp, 'utf8');
        const segs = content.split(/\n\n----?\n\n|\n### /).map((s) => s.trim()).filter(Boolean);
        let promoted = 0;
        const leftovers = [];
        // 只读一次长期记忆（原先每段读一次，O(段落数 × 文件大小)）
        const longText = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, 'utf8') : '';
        const longFps = new Set(parseMemoryEntries(longText).map((x) => memFingerprint(x.body)));
        for (const s2 of segs) {
          // 去掉段首自带的小标题：归档会另加时间戳标题，留着会变成嵌套标题噪音
          const body = s2.replace(/^#{1,6}[^\n]*\n?/, '').trim() || s2;
          if (body.length < MEM_PROMOTE_MIN_CHARS) {
            if (ageDays > MEM_KEEP_DAYS) leftovers.push(s2);
            continue;
          }
          const bfp = memFingerprint(body);
          const worth = MEM_PROMOTE_KWS.some((k) => body.includes(k)) && !MEM_PROMOTE_DENY.test(body);
          if (worth && !longFps.has(bfp)) {
            if (appendMemory(body, { long: true })) { longFps.add(bfp); promoted++; }
          } else if (ageDays > MEM_KEEP_DAYS) {
            // 到期删除前，没晋升的段落进月度归档，不丢内容
            leftovers.push(s2);
          }
        }
        if (ageDays > MEM_KEEP_DAYS) {
          if (leftovers.length) {
            const month = e.name.slice(0, 7); // YYYY-MM
            const digest = path.join(MEMORY_DIR, 'archive-' + month + '.md');
            const head = '## 归档自 ' + e.name.replace('.md', '') + '\n\n' + leftovers.join('\n\n');
            try {
              const prev = fs.existsSync(digest) ? fs.readFileSync(digest, 'utf8') : '';
              let next = (prev ? prev.replace(/\s*$/, '') + '\n\n---\n\n' : '') + head + '\n';
              fs.writeFileSync(digest, next, 'utf8');
            } catch (_) {}
          }
          try { fs.unlinkSync(fp); } catch (_) {}
        }
        if (promoted) console.log('[memory] 蒸馏晋升 ' + promoted + ' 段来自 ' + e.name);
      } catch (_) {}
    }
  } catch (_) {}
}

/* ================= 应用检索索引（node:sqlite + FTS5，QClaw memory-core 启发） =================
   markdown/JSON 文件仍是唯一事实源（可读、可备份），SQLite 只做检索与列表加速镜像：
   - entries / entries_fts：长期记忆 + 每日流水（中文「二字滑窗」预分词）
   - lib_docs / lib_fts  ：资料库全文（libRecall 的候选预筛）
   - chat_index          ：对话元数据（列表不再解析全部对话 JSON）
   任何数据变更后按需重建对应分区（条目量级在几百，重建 <10ms）。 */
const APP_INDEX_FILE = path.join(DATA_DIR, 'app-index.db');
let memDb = null;

function openMemoryIndex() {
  if (memDb) return true;
  try {
    const { DatabaseSync } = require('node:sqlite');
    ensureDir(DATA_DIR);
    // 旧版记忆索引并入统一库（纯镜像，直接删除重建）
    try { fs.unlinkSync(path.join(DATA_DIR, 'memory-index.db')); } catch (_) {}
    try { fs.unlinkSync(path.join(DATA_DIR, 'memory-index.db-shm')); } catch (_) {}
    try { fs.unlinkSync(path.join(DATA_DIR, 'memory-index.db-wal')); } catch (_) {}
    memDb = new DatabaseSync(APP_INDEX_FILE);
    memDb.exec(`CREATE TABLE IF NOT EXISTS entries(
      id INTEGER PRIMARY KEY,
      scope TEXT, file TEXT, seg_idx INTEGER, time TEXT, title TEXT, body TEXT
    )`);
    memDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(body_bi, title_bi)`);
    memDb.exec(`CREATE TABLE IF NOT EXISTS lib_docs(
      rowid INTEGER PRIMARY KEY,
      doc_id TEXT UNIQUE, name TEXT, tags TEXT, char_count INTEGER, added_at INTEGER, enabled INTEGER
    )`);
    memDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS lib_fts USING fts5(body_bi, title_bi)`);
    memDb.exec(`CREATE TABLE IF NOT EXISTS chat_index(
      chat_id TEXT PRIMARY KEY, mode TEXT, title TEXT,
      created INTEGER, updated INTEGER, msg_count INTEGER
    )`);
    memDb.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`);
    return true;
  } catch (_) { memDb = null; return false; }
}

/* ---- 索引源指纹：源文件没变就跳过全量重建（启动不做无谓工作）。
   重建函数结束时写入指纹；索引的增量更新（appendMemory / chatIndexUpsert 等）不会更新它，
   于是「源变过」会自然导致下次启动重建 —— 而重建现在跑在后台，不挡窗口出现。 ---- */
function idxMetaGet(key) {
  if (!openMemoryIndex()) return '';
  try { const r = memDb.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? String(r.value || '') : ''; } catch (_) { return ''; }
}
function idxMetaSet(key, val) {
  if (!openMemoryIndex()) return;
  try { memDb.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)').run(key, String(val)); } catch (_) {}
}
function fileSig(fp) {
  try { const s = fs.statSync(fp); return s.size + ':' + Math.round(s.mtimeMs); } catch (_) { return '-'; }
}
function dirSig(dir, filter) {
  try {
    let n = 0, bytes = 0, maxM = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || (filter && !filter(e.name))) continue;
      let s; try { s = fs.statSync(path.join(dir, e.name)); } catch (_) { continue; }
      n++; bytes += s.size; if (s.mtimeMs > maxM) maxM = s.mtimeMs;
    }
    return n + ':' + bytes + ':' + Math.round(maxM);
  } catch (_) { return '-'; }
}
function fpMemory() {
  return fileSig(MEMORY_FILE) + '|' + dirSig(MEMORY_DIR, (n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n) || /^archive-.*\.md$/.test(n));
}
function fpChats() { return dirSig(CHATS_DIR, (n) => n.endsWith('.json') && n[0] !== '_'); }
/* 指纹要同时覆盖「资料库自己存的文本」和「产物空间」——
   引用式条目（kind=deliverable）的正文在 data/deliverables/，只监控 LIB_TEXT_DIR 的话，
   产物改了指纹不变、索引不重建，召回会一直停在入库那一刻的旧内容。 */
function fpLib() {
  return fileSig(LIB_INDEX) + '|' + dirSig(LIB_TEXT_DIR) + '|' + dirSig(DELIVER_DIR);
}

function rebuildMemoryIndexIfStale() {
  const fp = fpMemory();
  if (fp !== '-' && fp === idxMetaGet('fp:memory')) return 'skip';
  rebuildMemoryIndex();
  return 'rebuild';
}
function libIndexRebuildIfStale() {
  const fp = fpLib();
  if (fp !== '-' && fp === idxMetaGet('fp:lib')) return 'skip';
  libIndexRebuild();
  return 'rebuild';
}
function chatIndexRebuildIfStale() {
  const fp = fpChats();
  if (fp !== '-' && fp === idxMetaGet('fp:chats')) return 'skip';
  chatIndexRebuild();
  return 'rebuild';
}

/* CJK 二字滑窗分词（供 FTS 索引与查询两侧一致使用），英文按 token 保留 */
function bigramize(text) {
  const s = String(text || '');
  const out = [];
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of cjk) {
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    if (run.length === 1) out.push(run);
  }
  const lat = s.toLowerCase().match(/[a-z][a-z0-9]+/g) || [];
  return out.concat(lat).join(' ');
}

/* 从文件系统收集全部记忆条目（索引与降级扫描共用） */
function collectMemoryEntries() {
  const out = [];
  const longText = (() => { try { return fs.readFileSync(MEMORY_FILE, 'utf8'); } catch (_) { return ''; } })();
  for (const e of parseMemoryEntries(longText)) {
    out.push({ scope: 'long', file: 'memory.md', seg_idx: e.idx, time: e.time, title: e.title, body: e.body });
  }
  try {
    ensureDir(MEMORY_DIR);
    const ents = fs.readdirSync(MEMORY_DIR, { withFileTypes: true });
    const daily = [];
    const archives = [];
    for (const x of ents) {
      if (!x.isFile()) continue;
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(x.name)) daily.push(x.name);
      else if (/^archive-.*\.md$/.test(x.name)) archives.push(x.name);
    }
    daily.sort();
    archives.sort();
    // 归档也进索引：长期记忆溢出条目移出常驻后仍可被召回（内容不丢）
    for (const group of [{ names: daily, scope: 'daily' }, { names: archives, scope: 'archive' }]) {
      for (const name of group.names) {
        let c = '';
        try { c = fs.readFileSync(path.join(MEMORY_DIR, name), 'utf8'); } catch (_) { continue; }
        for (const e of parseMemoryEntries(c)) {
          out.push({
            scope: group.scope,
            file: name.replace('.md', ''),
            seg_idx: e.idx,
            time: e.time || name.replace('.md', ''),
            title: e.title,
            body: e.body,
          });
        }
      }
    }
  } catch (_) {}
  return out;
}

function rebuildMemoryIndex() {
  if (!openMemoryIndex()) return false;
  try {
    const entries = collectMemoryEntries();
    memDb.exec('BEGIN');
    try {
      memDb.exec('DELETE FROM entries');
      memDb.exec('DELETE FROM entries_fts');
      const ins = memDb.prepare('INSERT INTO entries(id, scope, file, seg_idx, time, title, body) VALUES (?,?,?,?,?,?,?)');
      const insFts = memDb.prepare('INSERT INTO entries_fts(rowid, body_bi, title_bi) VALUES (?,?,?)');
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const id = i + 1;
        ins.run(id, e.scope, e.file, e.seg_idx, e.time || '', e.title || '', e.body || '');
        insFts.run(id, bigramize(e.title + '\n' + e.body), bigramize(e.title || ''));
      }
      memDb.exec('COMMIT');
    } catch (err) { try { memDb.exec('ROLLBACK'); } catch (_) {} throw err; }
    idxMetaSet('fp:memory', fpMemory());
    return entries.length;
  } catch (_) { return false; }
}

/* 增量写一条记忆进索引（appendMemory 专用，避免每追加一条就全量重建） */
function memoryIndexAppend(entry) {
  if (!openMemoryIndex()) return false;
  try {
    const r = memDb.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM entries').get();
    const id = Number((r && r.m) || 0) + 1;
    memDb.exec('BEGIN');
    try {
      memDb.prepare('INSERT INTO entries(id, scope, file, seg_idx, time, title, body) VALUES (?,?,?,?,?,?,?)')
        .run(id, entry.scope || '', entry.file || '', null, entry.time || '', entry.title || '', entry.body || '');
      memDb.prepare('INSERT INTO entries_fts(rowid, body_bi, title_bi) VALUES (?,?,?)')
        .run(id, bigramize((entry.title || '') + '\n' + (entry.body || '')), bigramize(entry.title || ''));
      memDb.exec('COMMIT');
    } catch (err) { try { memDb.exec('ROLLBACK'); } catch (_) {} throw err; }
    return true;
  } catch (_) { return false; }
}

/* 记忆检索：FTS5 bm25 相关度 + 新近度加成。
   opts.skipRecentDays：跳过最近 N 天的流水条目（它们已全量注入上下文，召回重复无益）。
   opts.onlyLong：只要长期记忆条目（任务单挑「常驻核心 + 相关条目」时用）。 */
function memorySearch(query, limit, opts) {
  const kws = memoryExtractKeywords(query);
  const need = Math.max(1, Math.min(Number(limit) || 5, 30));
  if (!kws.length) return [];
  const skipRecentDays = (opts && opts.skipRecentDays) || 0;
  const onlyLong = !!(opts && opts.onlyLong);
  const cutoff = skipRecentDays > 0 ? Date.now() - skipRecentDays * 86400000 : 0;

  const recencyBonus = (timeStr) => {
    const t = Date.parse(String(timeStr || '').replace(' ', 'T'));
    if (!isFinite(t)) return 0.2;
    return 2 / (1 + Math.max(0, (Date.now() - t) / 86400000));
  };

  let rows = null;
  if (openMemoryIndex()) {
    try {
      const q = kws.map((k) => '"' + k + '"').join(' OR ');
      rows = memDb.prepare('SELECT e.scope, e.file, e.time, e.title, e.body, bm25(entries_fts) AS rank FROM entries_fts JOIN entries e ON e.id = entries_fts.rowid WHERE entries_fts MATCH ?').all(q);
    } catch (_) { rows = null; }
  }
  if (!rows) {
    // 降级：无 SQLite 时线性扫描（小数据量足够用）
    const entries = collectMemoryEntries();
    rows = [];
    for (const e of entries) {
      let rank = 0;
      for (const k of kws) {
        const n = (e.title + '\n' + e.body).split(k).length - 1;
        if (n > 0) rank -= n;
      }
      if (rank < 0) rows.push({ scope: e.scope, file: e.file, time: e.time, title: e.title, body: e.body, rank });
    }
  }
  const scored = [];
  for (const r of rows) {
    if (onlyLong && r.scope !== 'long') continue;
    if (cutoff && r.scope === 'daily') {
      const t = Date.parse(String(r.file || '') + 'T00:00:00');
      if (isFinite(t) && t >= cutoff) continue;
    }
    scored.push({ scope: r.scope, file: r.file, time: r.time || '', title: r.title || '', body: r.body || '', score: -r.rank + recencyBonus(r.time) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, need);
}

/* ---------------- 对话历史（文件存储，替代 localStorage） ---------------- */
/* 每个对话一个 JSON 文件，无容量上限；小白升级时自动从 localStorage 迁移。 */
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const CHATS_BODY_LIMIT = 64 * 1024 * 1024; // 全量对话可达数十 MB

function safeChatId(id) {
  const t = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return t || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
}

function readAllChats() {
  ensureDir(CHATS_DIR);
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(CHATS_DIR, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('_')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, e.name), 'utf8'));
      if (c && typeof c === 'object' && c.id) out.push(c);
    } catch (_) {}
  }
  out.sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
  return out;
}

/* 全量写入：新增/更新各对话文件，并清理已删除的对话文件 */
function writeAllChats(chats) {
  ensureDir(CHATS_DIR);
  const keep = new Set();
  let n = 0;
  for (const c of Array.isArray(chats) ? chats : []) {
    if (!c || typeof c !== 'object' || !c.id) continue;
    const id = safeChatId(c.id);
    const rec = Object.assign({}, c, { id });
    if (!Array.isArray(rec.messages)) rec.messages = [];
    keep.add(id + '.json');
    try { writeJsonAtomic(path.join(CHATS_DIR, id + '.json'), rec); n++; } catch (_) {}
  }
  try {
    for (const name of fs.readdirSync(CHATS_DIR)) {
      if (!name.endsWith('.json') || name.startsWith('_')) continue;
      if (!keep.has(name)) { try { fs.unlinkSync(path.join(CHATS_DIR, name)); } catch (_) {} }
    }
  } catch (_) {}
  try { chatIndexRebuild(); } catch (_) {}
  return n;
}

/* ---- 对话元数据索引：列表不再全量解析对话 JSON（对话文件本身仍是事实源） ---- */
function chatIndexRebuild() {
  if (!openMemoryIndex()) return false;
  try {
    const rows = [];
    let ents = [];
    try { ents = fs.readdirSync(CHATS_DIR, { withFileTypes: true }); } catch (_) {}
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('_')) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, e.name), 'utf8'));
        if (c && typeof c === 'object' && c.id) {
          rows.push({ id: c.id, mode: c.mode || 'free', title: c.title || '', created: c.created || 0, updated: c.updated || 0, msg: (c.messages || []).length });
        }
      } catch (_) {}
    }
    memDb.exec('BEGIN');
    try {
      memDb.exec('DELETE FROM chat_index');
      const ins = memDb.prepare('INSERT OR REPLACE INTO chat_index(chat_id, mode, title, created, updated, msg_count) VALUES (?,?,?,?,?,?)');
      for (const r of rows) ins.run(r.id, r.mode, r.title, r.created, r.updated, r.msg);
      memDb.exec('COMMIT');
    } catch (err) { try { memDb.exec('ROLLBACK'); } catch (_) {} throw err; }
    idxMetaSet('fp:chats', fpChats());
    return rows.length;
  } catch (_) { return false; }
}
function chatIndexUpsert(c) {
  try {
    if (!openMemoryIndex()) return;
    memDb.prepare('INSERT OR REPLACE INTO chat_index(chat_id, mode, title, created, updated, msg_count) VALUES (?,?,?,?,?,?)')
      .run(String(c.id), c.mode || 'free', c.title || '', c.created || 0, c.updated || 0, (c.messages || []).length);
  } catch (_) {}
}
function chatIndexDelete(id) {
  try {
    if (!openMemoryIndex()) return;
    memDb.prepare('DELETE FROM chat_index WHERE chat_id = ?').run(String(id));
  } catch (_) {}
}
function chatIndexList() {
  if (!openMemoryIndex()) return null;
  try {
    return memDb.prepare('SELECT chat_id AS id, mode, title, created, updated, msg_count AS msgCount FROM chat_index ORDER BY updated DESC').all();
  } catch (_) { return null; }
}

/* 安全递归复制目录（避免 fs.cpSync 在中文路径下的崩溃问题） */
function copyDirSafe(src, dst) {
  try {
    if (!fs.existsSync(src)) return 0;
    fs.mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const sp = path.join(src, e.name);
      const dp = path.join(dst, e.name);
      if (e.isDirectory()) n += copyDirSafe(sp, dp);
      else if (e.isFile()) { try { fs.copyFileSync(sp, dp); n++; } catch (_) {} }
    }
    return n;
  } catch (_) { return 0; }
}

/* ---------------- 数据自动备份（滚动快照） ----------------
   教训（2026-09-12 记忆误删事故）：用户数据绝不能只有一份。
   触发点：每次服务启动（reason=startup）、破坏性操作前（reason=before-clear 等）。
   备份位置 data/_auto_backup/<时间戳>-<原因>/，恢复 = 把内容拷回 data/ 对应位置。 */
const AUTO_BACKUP_DIR = path.join(DATA_DIR, '_auto_backup');
const AUTO_BACKUP_KEEP = 10;                       // 最多保留的快照份数
const AUTO_BACKUP_LIB_FILES_LIMIT = 256 * 1024 * 1024; // 资料库原始文件超限时跳过（提取文本已备份，价值仍在）
function dirSizeDeep(p) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const sp = path.join(p, e.name);
      if (e.isDirectory()) n += dirSizeDeep(sp);
      else if (e.isFile()) { try { n += fs.statSync(sp).size; } catch (_) {} }
    }
  } catch (_) {}
  return n;
}
function autoBackupData(reason, opts) {
  try {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    const safe = String(reason || 'manual').replace(/[^a-zA-Z0-9_-]/g, '') || 'manual';
    // 同一天的同类快照已存在就跳过（启动快照用；「清空记忆」等仍强制留新份）
    if (opts && opts.oncePerDay) {
      const day = stamp.slice(0, 10);
      let dup = false;
      try { dup = fs.readdirSync(AUTO_BACKUP_DIR).some((n) => n.startsWith(day + '_') && n.endsWith('-' + safe)); } catch (_) {}
      if (dup) return '';
    }
    const dest = path.join(AUTO_BACKUP_DIR, stamp + '-' + safe);
    ensureDir(dest);
    // usage.jsonl 是 append-only 用量账本：不备份的话，误删一次就永久丢了历史消耗
    for (const f of ['memory.md', 'config.json', 'profiles.json', 'usage.jsonl']) {
      const src = path.join(DATA_DIR, f);
      if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(dest, f)); } catch (_) {} }
    }
    copyDirSafe(MEMORY_DIR, path.join(dest, 'memory'));
    copyDirSafe(CHATS_DIR, path.join(dest, 'chats'));
    const libDir = path.join(DATA_DIR, 'library');
    if (fs.existsSync(libDir)) {
      for (const f of ['index.json', 'synonyms.json']) {
        const src = path.join(libDir, f);
        if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(dest, f)); } catch (_) {} }
      }
      copyDirSafe(path.join(libDir, 'text'), path.join(dest, 'library-text'));
      if (dirSizeDeep(path.join(libDir, 'files')) <= AUTO_BACKUP_LIB_FILES_LIMIT) {
        copyDirSafe(path.join(libDir, 'files'), path.join(dest, 'library-files'));
      } else {
        console.log('[backup] 资料库原始文件超过限额，本快照跳过该目录（提取出的全文文本已备份）');
      }
    }
    // 滚动清理：只保留最近 AUTO_BACKUP_KEEP 份
    let ents = [];
    try { ents = fs.readdirSync(AUTO_BACKUP_DIR).filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n)).sort(); } catch (_) {}
    while (ents.length > AUTO_BACKUP_KEEP) {
      const rm = ents.shift();
      try { fs.rmSync(path.join(AUTO_BACKUP_DIR, rm), { recursive: true, force: true }); } catch (_) {}
    }
    return dest;
  } catch (_) { return ''; }
}

/* ---------------- 个人资料库：存储与检索 ----------------
   用户自己的备赛包 / 文字稿 / 期刊 / 笔记，存在 data/library/，
   备赛与复盘时按关键词召回片段，注入任务单供 Agent 直接引用。 */
const LIB_TEXT_EXT = new Set(['txt', 'md', 'markdown', 'srt', 'text', 'log', 'csv', 'json', 'yml', 'yaml']);
const LIB_STOP = /^(我们|你们|他们|这个|那个|什么|怎么|为什么|可以|但是|如果|还是|就是|因为|所以|然后|应该|需要|一个|一种|对于|关于|进行|问题|一下|已经|现在|还有|没有|不是|可能|觉得|知道|自己|这些|那些|每个|所有|之后|之前|时候|这样|那样|今天|明天|昨天|您好|你好|谢谢|请问|帮我|我想|大家|一下|有点|以及|并且|而且|不过|于是|接着|另外|比如|例如|第一|第二|第三|方面|部分|情况|内容|时候)$/;


/* 同义词表：一行一组，检索时同组互扩，解决「AI / 人工智能」这类同义不同词召回不到的情况。
   用户可在资料库弹窗里自行编辑，保存在 data/library/synonyms.json */
const LIB_DEFAULT_SYNONYMS = [
  ['人工智能', 'AI', 'AIGC', '大模型', '生成式', '机器学习'],
  ['版权', '著作权', '知识产权'],
  ['安乐死', '尊严死', '医助自杀', '临终关怀', '姑息治疗'],
  ['死刑', '极刑', '生命刑'],
  ['教育公平', '教育均衡', '择校', '学区房'],
  ['双减', '减负', '课外培训', '校外培训'],
  ['碳中和', '碳达峰', '双碳', '碳排放'],
  ['房价', '房地产', '楼市', '住房'],
  ['就业', '失业率', '劳动力市场', '招工难'],
  ['医保', '医疗保险', '医疗保障', '看病贵'],
  ['乡村振兴', '三农', '农村发展', '农民增收'],
  ['生育政策', '计划生育', '人口政策', '鼓励生育'],
  ['网络暴力', '网暴', '网络欺凌', '人肉搜索'],
  ['社交媒体', '短视频平台', '自媒体', '算法推荐'],
  ['信息茧房', '过滤气泡', '算法偏见'],
  ['隐私', '个人信息', '数据保护', '人脸识别'],
  ['基因编辑', 'CRISPR', '胚胎编辑', '转基因'],
  ['电动车', '新能源车', '电动汽车', '锂电池'],
  ['应试教育', '高考', '升学率', '素质教育'],
  ['内卷', '过度竞争', '躺平', '996'],
  ['消费主义', '消费降级', '消费升级', '超前消费'],
  ['城市化', '城镇化', '进城务工', '农民工'],
  ['老龄化', '养老', '退休金', '延迟退休'],
  ['言论自由', '表达自由', '内容审核', 'censorship'],
];

function libSynonymsFile() { return path.join(LIB_DIR, 'synonyms.json'); }

function libLoadSynonyms() {
  const file = libSynonymsFile();
  const j = readJson(file, null);
  if (j && Array.isArray(j.groups)) return j.groups;
  libEnsure();
  try { writeJsonAtomic(file, { groups: LIB_DEFAULT_SYNONYMS }); } catch (_) {}
  return LIB_DEFAULT_SYNONYMS;
}

function libSaveSynonyms(groups) {
  libEnsure();
  writeJsonAtomic(libSynonymsFile(), { groups });
}

/* 查询词扩展：原词权重 1，同义词扩展词权重 0.6 */
function libQueryTerms(query) {
  const terms = libTokenize(query);
  const text = String(query || '');
  const groups = libLoadSynonyms();
  for (const g of groups) {
    if (!Array.isArray(g) || g.length < 2) continue;
    const hit = g.some((w) => w && text.indexOf(String(w)) >= 0);
    if (!hit) continue;
    for (const w of g) {
      const sub = libTokenize(w);
      for (const [k] of sub) {
        if (!terms.has(k)) terms.set(k, 0.6);
      }
    }
  }
  return terms;
}

function libEnsure() {
  ensureDir(LIB_DIR);
  ensureDir(LIB_FILES_DIR);
  ensureDir(LIB_TEXT_DIR);
}

function libLoadIndex() {
  const idx = readJson(LIB_INDEX, null);
  const items = idx && Array.isArray(idx.items) ? idx.items : [];
  return { items: items.filter((it) => it && it.id) };
}

function libSafeName(name, fallback) {
  let n = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
  n = n.replace(/^\.+/, '').slice(0, 80).trim();
  return n || (fallback || '未命名资料');
}

function libExtOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

function libRel(p) {
  return String(p || '').replace(/\\/g, '/');
}

function libExtractText(ext, buf) {
  if (LIB_TEXT_EXT.has(ext)) {
    let s = buf.toString('utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return { text: s };
  }
  if (ext === 'pdf') {
    const t = extractPdfText(buf);
    if (!t) return { error: '没能从这份 PDF 里提取到文字，多半是扫描件 / 图片版。两个办法：① 用 WPS 或 Word 打开它，另存为 .docx 再传；② 把页面截图成图片直接传，系统会自动 OCR 识别文字。' };
    return { text: t };
  }
  if (ext === 'docx') {
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      return { error: '不是有效的 .docx（旧版 .doc 请先用 Word 另存为 .docx）' };
    }
    const t = extractDocxText(buf);
    if (!t) return { error: '未能从 Word 文档提取文字' };
    return { text: t };
  }
  return { error: '暂不支持的类型：.' + (ext || '未知') + '（支持 txt / md / srt / pdf / docx）' };
}

function libNewId() {
  return 'L' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

/* 入库：{ name, tags, buf } 文件或 { name, tags, text } 纯文本 */
function libAdd(opts = {}) {
  libEnsure();
  const name = libSafeName(opts.name, '未命名资料');
  let rawText;
  if (typeof opts.text === 'string') {
    rawText = opts.text;
  } else {
    const buf = opts.buf;
    if (!Buffer.isBuffer(buf) || !buf.length) return { error: '没有收到文件内容' };
    const r = libExtractText(libExtOf(name), buf);
    if (r.error) return { error: r.error };
    rawText = r.text;
  }
  rawText = String(rawText || '').replace(/\r\n?/g, '\n').trim();
  if (!rawText) return { error: '这份资料里没有提取到任何文字' };
  if (rawText.length > LIB_MAX_TEXT) rawText = rawText.slice(0, LIB_MAX_TEXT);

  const idx = libLoadIndex();
  const id = libNewId();
  const ext = libExtOf(name);
  const storeName = id + (ext ? '.' + ext : (typeof opts.text === 'string' ? '.txt' : ''));
  const item = {
    id,
    name,
    ext: ext || (typeof opts.text === 'string' ? 'txt' : ''),
    kind: opts.kind || (typeof opts.text === 'string' ? 'paste' : 'file'),
    note: typeof opts.note === 'string' ? opts.note.slice(0, 120) : '',
    size: Buffer.isBuffer(opts.buf) ? opts.buf.length : Buffer.byteLength(rawText, 'utf8'),
    charCount: rawText.length,
    tags: Array.isArray(opts.tags) ? opts.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    addedAt: Date.now(),
    enabled: true,
    file: Buffer.isBuffer(opts.buf) ? libRel(path.join('data', 'library', 'files', storeName)) : '',
    textFile: libRel(path.join('data', 'library', 'text', id + '.txt')),
    preview: rawText.replace(/\s+/g, ' ').slice(0, 100),
  };
  if (Buffer.isBuffer(opts.buf)) {
    try { fs.writeFileSync(path.join(LIB_FILES_DIR, storeName), opts.buf); } catch (_) {}
  }
  fs.writeFileSync(path.join(LIB_TEXT_DIR, id + '.txt'), rawText, 'utf8');
  idx.items.push(item);
  libSaveIndex(idx);
  return { item };
}

/* 产物 → 资料库（引用式，不复制内容）。
   存的是「指向 data/deliverables/<name> 的指针」，全文仍只有一份：
   - 产物改了 → 资料库自动读到最新版（复制式会永远停在旧版）
   - 不占双份空间
   - 但产物文件被删时这条会读到空 → 下面 libRemove / 索引重建都做了防护 */
function libAddFromDeliverable(name, opts = {}) {
  libEnsure();
  const safe = path.basename(String(name || '').trim());
  if (!safe) return { error: '缺少产物文件名' };
  const fp = path.join(DELIVER_DIR, safe);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return { error: '产物不存在：' + safe };
  const ext = libExtOf(safe);
  if (!['md', 'markdown', 'txt', 'csv', 'srt', 'log', 'json', 'html'].includes(ext)) {
    return { error: '只有文本类产物能进资料库（当前是 .' + (ext || '?') + '）' };
  }
  let rawText = '';
  try { rawText = fs.readFileSync(fp, 'utf8'); } catch (e) { return { error: '读取失败：' + e.message }; }
  rawText = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!rawText) return { error: '这份产物里没有文字内容' };
  if (rawText.length > LIB_MAX_TEXT) rawText = rawText.slice(0, LIB_MAX_TEXT);

  const idx = libLoadIndex();
  // 同一产物只入库一次：重名改成「产物名（资料）」而不是堆两条
  const dup = idx.items.find((x) => x.kind === 'deliverable' && x.ref === safe);
  if (dup) return { error: '这份产物已经在资料库里了', item: dup };

  const id = libNewId();
  const item = {
    id,
    name: libSafeName(opts.name || safe, safe),
    ext,
    kind: 'deliverable',                 // 标记来源，UI 可显示「来自产物」
    ref: safe,                            // 指向产物空间的文件名
    note: '来自产物空间（跟随原件更新）',
    size: Buffer.byteLength(rawText, 'utf8'),
    charCount: rawText.length,
    tags: Array.isArray(opts.tags) ? opts.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
    addedAt: Date.now(),
    enabled: true,
    file: '',                             // 引用式：资料库自己不存原件
    // 注意：textFile 必须是「相对 ROOT」的路径（与其他条目一致，读取处统一 path.join(ROOT, textFile)）。
    // 这里若写成绝对路径，会和 ROOT 再拼一次导致读不到 —— 曾因此出现「入库成功但召不回」。
    textFile: libRel(path.join('data', 'deliverables', safe)),
    preview: rawText.replace(/\s+/g, ' ').slice(0, 100),
  };
  idx.items.push(item);
  libSaveIndex(idx);
  return { item };
}

function libRemove(id) {
  const idx = libLoadIndex();
  const before = idx.items.length;
  const target = idx.items.find((x) => x.id === id);
  idx.items = idx.items.filter((x) => x.id !== id);
  if (idx.items.length !== before) {
    libSaveIndex(idx);
    if (target) {
      for (const rel of [target.file, target.textFile]) {
        if (!rel) continue;
        // 引用式条目（kind=deliverable）的 textFile 指向产物原件，删资料绝不能删原件
        if (target.kind === 'deliverable') continue;
        try { fs.unlinkSync(path.join(ROOT, rel)); } catch (_) {}
      }
    }
    return true;
  }
  return false;
}

function libPublic(it) {
  // 引用式条目（来自产物空间）：报告原件是否还在，前端据此提示「原件已删除」
  let missing = false;
  if (it.kind === 'deliverable') {
    // textFile 是相对 ROOT 的路径，与读取处保持一致
    const rel = String(it.textFile || '').split('/').join(path.sep);
    missing = !!it.missing || !fs.existsSync(path.join(ROOT, rel));
  }
  return {
    id: it.id, name: it.name, ext: it.ext, kind: it.kind,
    size: it.size, charCount: it.charCount, tags: it.tags || [],
    addedAt: it.addedAt, enabled: it.enabled !== false, preview: it.preview || '',
    hasFile: !!it.file, note: it.note || '',
    ref: it.ref || '', missing,
  };
}

/* 分词：中文二元滑窗 + 英文 token，返回 Map(token -> 权重) */
function libTokenize(src) {
  const s = String(src || '');
  const words = new Map();
  const bump = (k, w) => words.set(k, (words.get(k) || 0) + w);
  const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const w of cjk) {
    const len = Math.min(w.length, 12);
    for (let i = 0; i + 2 <= len; i++) {
      const seg = w.slice(i, i + 2);
      if (LIB_STOP.test(seg)) continue;
      bump(seg, 1);
    }
  }
  const en = s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [];
  for (const w of en) bump(w.slice(0, 8), 2);
  return words;
}

/* 一次扫描正文：统计命中次数与命中位置（中文 O(n) 滑窗，英文 indexOf） */
function libScoreText(text, terms) {
  // terms: Map(token -> 权重)；中文二元组命中计权重，英文 token 同样计权重
  const cjkKeys = new Map();
  const enKeys = [];
  for (const [k, w] of terms) {
    if (/^[\u4e00-\u9fa5]{2}$/.test(k)) cjkKeys.set(k, w);
    else enKeys.push([k, w]);
  }
  const scan = text.length > 200000 ? text.slice(0, 200000) : text;
  let score = 0;
  const hits = [];
  /* 原有写法命中后 i += 1（跳 1 字），会把紧邻的下一个 bigram 一起吃掉：
     正文「打钉子」命中「打钉」后跳到「子」开头，于是「钉子」再也匹配不上 →
     查询「打钉子」（切出 打钉/钉子 两个 bigram）在正文里明明完整出现，却只得 1 分。
     这里改为「仅在两个 bigram 重叠（相邻 1 字）时才跳过」，既不重复计数也不漏计。 */
  let prevHitEnd = -1;
  for (let i = 0; i + 2 <= scan.length; i++) {
    const w = cjkKeys.get(scan.slice(i, i + 2));
    if (!w) continue;
    if (i === prevHitEnd) { prevHitEnd = i + 2; continue; }  // 与上一命中重叠，跳过
    score += w;
    if (hits.length < 400) hits.push(i);
    prevHitEnd = i + 2;
  }
  for (const [k, w] of enKeys) {
    let from = 0, guard = 0;
    while (guard++ < 30) {
      const p = scan.toLowerCase().indexOf(k, from);
      if (p < 0) break;
      score += w;
      if (hits.length < 400) hits.push(p);
      from = p + k.length;
    }
  }
  return { score, hits };
}

/* 按命中位置取摘录窗口（最多 2 段） */
function libSnippets(text, hits, maxChars) {
  if (!hits || !hits.length) return text.replace(/\s+/g, ' ').slice(0, maxChars);
  const win = Math.max(160, Math.floor(maxChars / 2));
  const picked = [];
  for (const p of hits) {
    if (picked.some((s) => p >= s - 40 && p <= s + win)) continue;
    picked.push(Math.max(0, p - Math.floor(win / 3)));
    if (picked.length >= 2) break;
  }
  const parts = picked.map((s) => {
    const seg = text.slice(s, s + win).trim();
    return (s > 0 ? '…' : '') + seg + (s + win < text.length ? '…' : '');
  });
  return parts.join('\n…（中间省略）…\n').slice(0, maxChars);
}

/* 召回：按查询词给每份资料打分，返回 top N 片段 */
function libSaveIndex(idx) {
  libEnsure();
  writeJsonAtomic(LIB_INDEX, { version: 1, updatedAt: now(), items: idx.items });
  try { libIndexRebuild(); } catch (_) {}
}

/* 资料库全文进 FTS（libRecall 的候选预筛）；提取文本文件仍为事实源 */
function libIndexRebuild() {
  if (!openMemoryIndex()) return false;
  try {
    const idx = libLoadIndex();
    memDb.exec('BEGIN');
    try {
      memDb.exec('DELETE FROM lib_docs');
      memDb.exec('DELETE FROM lib_fts');
      const ins = memDb.prepare('INSERT INTO lib_docs(rowid, doc_id, name, tags, char_count, added_at, enabled) VALUES (?,?,?,?,?,?,?)');
      const insFts = memDb.prepare('INSERT INTO lib_fts(rowid, body_bi, title_bi) VALUES (?,?,?)');
      let rid = 0;
      for (const it of idx.items) {
        let text = '';
        try { text = fs.readFileSync(path.join(ROOT, it.textFile), 'utf8'); } catch (_) {}
        // 引用式条目指向的产物已被删除 → 跳过索引这次巡检会让检索出现「命中但读不到」，
        // 所以这里标记缺失，让 UI 能提示用户「原件已不存在」
        if (!text && it.kind === 'deliverable') { it.missing = true; }
        else if (it.missing) { delete it.missing; }
        if (!text) continue;
        rid++;
        ins.run(rid, it.id, it.name || '', (it.tags || []).join(' '), it.charCount || 0, it.addedAt || 0, it.enabled !== false ? 1 : 0);
        insFts.run(rid, bigramize(text), bigramize(it.name || ''));
      }
      memDb.exec('COMMIT');
    } catch (err) { try { memDb.exec('ROLLBACK'); } catch (_) {} throw err; }
    idxMetaSet('fp:lib', fpLib());
    return true;
  } catch (_) { return false; }
}

/* FTS 预筛：返回与检索词至少命中一词的 doc_id 集合（上限 120 篇）。
   分词与索引同用 bigramize，是旧全文扫描命中集的超集，保证不漏召回。 */
function libFtsCandidates(keys) {
  if (!openMemoryIndex()) return null;
  try {
    const q = keys.map(([k]) => '"' + k + '"').join(' OR ');
    const rows = memDb.prepare(
      'SELECT d.doc_id FROM lib_fts JOIN lib_docs d ON d.rowid = lib_fts.rowid WHERE lib_fts MATCH ? ORDER BY rank LIMIT 120'
    ).all(q);
    return new Set(rows.map((r) => r.doc_id));
  } catch (_) { return null; }
}

function libRecall(query, opts = {}) {
  const cfg = loadConfig();
  if (cfg.libraryEnabled === false) return [];
  const idx = libLoadIndex();
  let items = idx.items.filter((it) => it.enabled !== false);
  if (Array.isArray(opts.ids) && opts.ids.length) {
    const set = new Set(opts.ids.map(String));
    items = items.filter((it) => set.has(it.id));
  }
  if (!items.length) return [];
  const terms = libQueryTerms(String(query || '') + ' ' + String(opts.extra || ''));
  if (!terms.size) return [];
  const keys = Array.from(terms.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 80);
  const termsMap = new Map(keys);
  // 性能：先用 FTS 缩小候选集（不读任何正文），再对候选做精确打分；
  // 索引不可用或候选全灭时回落全量扫描，保证召回质量不低于旧版。
  const cand = libFtsCandidates(keys);
  const pool = (cand && cand.size) ? items.filter((it) => cand.has(it.id)) : items;
  const out = libScoreAndCollect(pool, keys, termsMap);
  if (out.length || pool === items) return out;
  return libScoreAndCollect(items, keys, termsMap);
}

/* 精确打分 + 摘要组装（旧版 libRecall 的核心逻辑，语义保持不变） */
function libScoreAndCollect(pool, keys, termsMap) {
  const scored = [];
  for (const it of pool) {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, it.textFile), 'utf8'); } catch (_) { continue; }
    if (!text) continue;
    const { score, hits } = libScoreText(text, termsMap);
    // 标题 / 标签命中加权：资料名与标签直接对应辩题时，优先级更高
    const meta = String(it.name || '') + ' ' + (Array.isArray(it.tags) ? it.tags.join(' ') : '');
    let bonus = 0;
    for (const [k, w] of keys) if (meta.indexOf(k) >= 0) bonus += w;
    const total = score + bonus * 4;
    /* 命中门槛：原来是死值 2，导致「击中」「主线」这类两字词（只产生 1 个 bigram）
       在正文里明明出现却永远召不回——用户搜「打钉子」搜不到自己的备赛包。
       改为按「查询词能切出几个 bigram」定下限：命中全部查询片段即可，
       长查询仍要求多点命中，避免一个常见字就把全库捞出来。 */
    const minScore = Math.max(1, Math.min(2, termsMap.size));
    if (total < minScore) continue;
    const norm = total / Math.sqrt(Math.max(1, text.length / 1000));
    scored.push({ item: it, score: norm, raw: total, hits: (hits.length ? hits : [0]), text });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);
  let budget = LIB_TOTAL_SNIPPET;
  const out = [];
  for (const s of scored.slice(0, LIB_RECALL_DOCS)) {
    if (budget <= 120) break;
    const snippet = libSnippets(s.text, s.hits, Math.min(LIB_DOC_SNIPPET, budget));
    budget -= snippet.length;
    out.push({
      id: s.item.id,
      name: s.item.name,
      charCount: s.item.charCount,
      score: Math.round(s.score * 10) / 10,
      path: s.item.textFile,
      snippet,
    });
  }
  return out;
}

/* ---------------- 技能 / 插件（用户自装技能） ----------------
   用户技能放 data/.dsh/skills/*.md，DSH 内核 filesystem provider 会自动扫描该目录。
   启停：启用 = <name>.md；停用 = <name>.md.disabled（内核只收 .md，后缀带 .disabled 即被忽略）。
   校验：文件须带 YAML frontmatter（--- 开头），且至少含 name 与 description。 */
function skillParseMd(content) {
  const text = String(content || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const raw of m[1].split(/\r?\n/)) {
      const mm = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (mm) meta[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const name = String(meta.name || '').trim();
  const description = String(meta.description || '').trim();
  const whenToUse = String(meta.whenToUse || '').trim();
  return { name, description, whenToUse, bodyStart: m ? m[0].length : 0 };
}
function skillValidName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(String(name || ''));
}
function skillScan(dir) {
  const out = [];
  try {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower === '.md') continue;
      const enabled = /.md$/i.test(e.name);
      const baseName = enabled ? e.name.replace(/\.md$/i, '') : e.name.replace(/\.md\.disabled$/i, '');
      if (!baseName) continue;
      const fp = path.join(dir, e.name);
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        const meta = skillParseMd(raw);
        const st = fs.statSync(fp);
        out.push({
          name: meta.name || baseName,
          description: meta.description || '（无描述：缺 frontmatter 的 description）',
          whenToUse: meta.whenToUse || '',
          fileName: e.name,
          filePath: libRel(path.join('data', '.dsh', 'skills', e.name)),
          enabled,
          size: st.size,
          mtime: st.mtimeMs,
          valid: !!meta.name && !!meta.description,
          bundled: false,
        });
      } catch (_) {}
    }
  } catch (_) {}
  return out.sort((a, b) => (a.enabled === b.enabled ? a.name.localeCompare(b.name, 'zh') : (a.enabled ? -1 : 1)));
}
function skillScanUser() {
  ensureDir(SKILL_USER_DIR);
  return skillScan(SKILL_USER_DIR);
}
function skillScanBundled() {
  return skillScan(SKILL_BUNDLED_DIR).map((s) => Object.assign(s, { bundled: true }));
}
/* 写入一份用户技能：content 完整 .md 文本；返回 {ok,error,item} */
function skillWriteUser(name, content, { overwrite = false } = {}) {
  ensureDir(SKILL_USER_DIR);
  if (!content || !String(content).trim()) return { error: '技能内容为空' };
  const meta = skillParseMd(content);
  if (!meta.name || !meta.description) return { error: '缺少 YAML frontmatter：必须在文件开头用 --- 包裹，且包含 name 与 description（详见面板说明）' };
  if (!skillValidName(meta.name)) return { error: 'frontmatter 的 name 只能是字母/数字/-/_/.，且以字母或数字开头' };
  if (name && meta.name !== name) return { error: 'frontmatter 里的 name 与要保存的文件名不一致' };
  if (String(content).length > SKILL_MAX_FILE) return { error: '技能文件超过 512KB 上限' };
  const enabledPath = path.join(SKILL_USER_DIR, meta.name + '.md');
  const disabledPath = path.join(SKILL_USER_DIR, meta.name + '.md.disabled');
  // 同名冲突：允许显式覆盖；否则报错
  if (!overwrite && (fs.existsSync(enabledPath) || fs.existsSync(disabledPath))) {
    return { error: '已存在同名技能「' + meta.name + '」。如需覆盖，勾选"覆盖同名"再导入。' };
  }
  try {
    fs.writeFileSync(enabledPath, content, 'utf8');
    if (fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath);
    const st = fs.statSync(enabledPath);
    return { ok: true, item: { name: meta.name, description: meta.description, whenToUse: meta.whenToUse, fileName: meta.name + '.md', enabled: true, size: st.size, mtime: st.mtimeMs, valid: true, bundled: false } };
  } catch (e) { return { error: '写入失败：' + e.message }; }
}
function skillToggleUser(skillName, enabled) {
  ensureDir(SKILL_USER_DIR);
  const on = path.join(SKILL_USER_DIR, skillName + '.md');
  const off = path.join(SKILL_USER_DIR, skillName + '.md.disabled');
  try {
    if (enabled) {
      if (fs.existsSync(off)) { fs.renameSync(off, on); return { ok: true, enabled: true }; }
      if (fs.existsSync(on)) return { ok: true, enabled: true };
      return { error: '未找到技能：' + skillName };
    }
    if (fs.existsSync(on)) { fs.renameSync(on, off); return { ok: true, enabled: false }; }
    if (fs.existsSync(off)) return { ok: true, enabled: false };
    return { error: '未找到技能：' + skillName };
  } catch (e) { return { error: '切换失败：' + e.message }; }
}
function skillRemoveUser(skillName) {
  ensureDir(SKILL_USER_DIR);
  let hit = null;
  for (const suffix of ['.md', '.md.disabled']) {
    const p = path.join(SKILL_USER_DIR, skillName + suffix);
    if (fs.existsSync(p)) { hit = p; break; }
  }
  if (!hit) return { error: '未找到技能：' + skillName };
  try { fs.unlinkSync(hit); return { ok: true }; } catch (e) { return { error: '删除失败：' + e.message }; }
}
function skillReadUser(skillName) {
  for (const suffix of ['.md', '.md.disabled']) {
    const p = path.join(SKILL_USER_DIR, skillName + suffix);
    if (fs.existsSync(p)) {
      try { return { ok: true, name: skillName, content: fs.readFileSync(p, 'utf8'), fileName: skillName + suffix, enabled: suffix === '.md' }; } catch (e) { return { error: e.message }; }
    }
  }
  return { error: '未找到技能：' + skillName };
}

/* ---------------- 个人资料库：存储与检索 ----------------
/* ---------------- 用量账本（append-only，删对话不影响历史） ----------------
    每行一条：{ ts, date, chatId, mode, model, input, output, cacheRead, cacheWrite, reasoning, elapsedMs }
    只追加不改写。统计从这里重放得出，而不是从「还活着的对话」里现算。 */
function usageAppend(rec) {
  try {
    ensureDir(DATA_DIR);
    const line = JSON.stringify(Object.assign({ ts: Date.now() }, rec));
    fs.appendFileSync(USAGE_FILE, line + '\n', 'utf8');
    return true;
  } catch (_) { return false; }
}

/* 读账本：坏行跳过（文件被手工编辑/半行写入时不炸） */
function usageReadAll() {
  let out = [];
  try {
    if (!fs.existsSync(USAGE_FILE)) return out;
    const txt = fs.readFileSync(USAGE_FILE, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && typeof o === 'object') out.push(o);
      } catch (_) { /* 坏行跳过 */ }
    }
  } catch (_) {}
  return out;
}

const USAGE_DAY = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

/* 聚合：总计 / 按天 / 按模型。天数与连续天数基于账本里的日期，
   不再依赖「消息是否还存在」。 */
function usageAggregate(rows) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, turns: 0, elapsedMs: 0 };
  const byDay = new Map();
  const byModel = new Map();
  for (const r of rows) {
    total.input += Number(r.input) || 0;
    total.output += Number(r.output) || 0;
    total.cacheRead += Number(r.cacheRead) || 0;
    total.cacheWrite += Number(r.cacheWrite) || 0;
    total.reasoning += Number(r.reasoning) || 0;
    total.elapsedMs += Number(r.elapsedMs) || 0;
    total.turns += 1;
    const day = r.date || USAGE_DAY(r.ts);
    let d = byDay.get(day);
    if (!d) { d = { date: day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, turns: 0 }; byDay.set(day, d); }
    d.input += Number(r.input) || 0;
    d.output += Number(r.output) || 0;
    d.cacheRead += Number(r.cacheRead) || 0;
    d.cacheWrite += Number(r.cacheWrite) || 0;
    d.reasoning += Number(r.reasoning) || 0;
    d.turns += 1;
    const mk = String(r.model || '未知');
    let m = byModel.get(mk);
    if (!m) { m = { model: mk, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, turns: 0 }; byModel.set(mk, m); }
    m.input += Number(r.input) || 0;
    m.output += Number(r.output) || 0;
    m.cacheRead += Number(r.cacheRead) || 0;
    m.cacheWrite += Number(r.cacheWrite) || 0;
    m.reasoning += Number(r.reasoning) || 0;
    m.turns += 1;
  }
  const days = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  const models = Array.from(byModel.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output));
  // 连续天数：从今天（或最后活跃日）往前数
  let streak = 0;
  const daySet = new Set(days.map((d) => d.date));
  const today = USAGE_DAY(Date.now());
  let cur = new Date();
  if (!daySet.has(today)) cur = new Date(Date.now() - 86400000); // 今天没用，从昨天开始数
  for (let i = 0; i < 3650; i++) {
    const k = USAGE_DAY(cur.getTime());
    if (daySet.has(k)) { streak++; cur = new Date(cur.getTime() - 86400000); }
    else break;
  }
  return { total, days, models, activeDays: days.length, streak };
}

/* ---------------- 产物空间（Agent 输出到 data/deliverables/） ----------------
   Agent 长交付可写 .md/.csv/.txt 到此目录（界面会实时列出）。本模块只读/转换该目录，绝对不越界。 */
function deliverSafeName(raw) {
  const n = String(raw || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').trim();
  return n || 'untitled';
}
function deliverList() {
  const out = [];
  try {
    ensureDir(DELIVER_DIR);
    const ents = fs.readdirSync(DELIVER_DIR, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile()) continue;
      if (e.name.startsWith('.')) continue;
      const fp = path.join(DELIVER_DIR, e.name);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      const ext = path.extname(e.name).toLowerCase().replace('.', '');
      out.push({
        name: e.name,
        base: e.name.replace(/\.[^.]+$/, ''),
        ext,
        size: st.size,
        mtime: st.mtimeMs,
        textType: ['md', 'markdown', 'txt', 'csv', 'json', 'html', 'srt', 'log'].includes(ext),
      });
    }
  } catch (_) {}
  return out.sort((a, b) => b.mtime - a.mtime);
}
function deliverRead(fileName) {
  const safe = path.basename(String(fileName || ''));
  const fp = path.join(DELIVER_DIR, safe);
  try {
    if (!fs.existsSync(fp)) return { error: '文件不存在：' + safe };
    const st = fs.statSync(fp);
    if (!st.isFile()) return { error: '不是文件' };
    if (st.size > DELIVER_MAX_FILE) return { error: '文件超过 ' + Math.round(DELIVER_MAX_FILE / 1024 / 1024) + 'MB，无法预览（可另存后本机打开）' };
    const text = fs.readFileSync(fp, 'utf8');
    return { ok: true, name: safe, text, size: st.size };
  } catch (e) { return { error: e.message }; }
}
/* 转换：md/txt→docx（docx.js）；csv→xlsx（xlsx-gen.js）；md/txt/csv→pdf（Electron pdf-worker）。
   返回新产物条目 */
function deliverConvert(fileName, target) {
  const base = path.basename(String(fileName || ''));
  const ext = path.extname(base).toLowerCase().replace('.', '');
  const src = path.join(DELIVER_DIR, base);
  if (!fs.existsSync(src)) return { error: '源文件不存在' };
  const targetExt = String(target || '').toLowerCase();
  let outName = '';
  if (targetExt === 'docx' && (ext === 'md' || ext === 'markdown' || ext === 'txt')) {
    try {
      const { markdownToDocx } = require('./docx');
      const text = fs.readFileSync(src, 'utf8');
      const buf = markdownToDocx(text, { title: base.replace(/\.[^.]+$/, '') });
      outName = base.replace(/\.[^.]+$/, '') + '.docx';
      let i = 1;
      while (fs.existsSync(path.join(DELIVER_DIR, outName))) outName = base.replace(/\.[^.]+$/, '') + '_' + (++i) + '.docx';
      fs.writeFileSync(path.join(DELIVER_DIR, outName), buf);
    } catch (e) { return { error: 'Word 转换失败：' + e.message }; }
  } else if (targetExt === 'xlsx' && (ext === 'csv')) {
    try {
      const { csvToXlsx } = require('./xlsx-gen');
      const text = fs.readFileSync(src, 'utf8');
      const buf = csvToXlsx(text, base.replace(/\.[^.]+$/, '').slice(0, 31));
      outName = base.replace(/\.[^.]+$/, '') + '.xlsx';
      let i = 1;
      while (fs.existsSync(path.join(DELIVER_DIR, outName))) outName = base.replace(/\.[^.]+$/, '') + '_' + (++i) + '.xlsx';
      fs.writeFileSync(path.join(DELIVER_DIR, outName), buf);
    } catch (e) { return { error: 'Excel 转换失败：' + e.message }; }
  } else if (targetExt === 'pdf' && (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'csv')) {
    try {
      const elec = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
      const worker = path.join(__dirname, 'pdf-worker.js');
      if (!fs.existsSync(elec) || !fs.existsSync(worker)) return { error: '桌面版 Electron 不可用，无法转 PDF' };
      outName = base.replace(/\.[^.]+$/, '') + '.pdf';
      let i = 1;
      while (fs.existsSync(path.join(DELIVER_DIR, outName))) outName = base.replace(/\.[^.]+$/, '') + '_' + (++i) + '.pdf';
      const target = path.join(DELIVER_DIR, outName);
      const r = spawnSync(elec, [worker, '--in', src, '--out', target, '--title', base.replace(/\.[^.]+$/, '')], { windowsHide: true, timeout: 90000, encoding: 'utf8' });
      if (r.error || r.status !== 0 || !fs.existsSync(target)) return { error: 'PDF 转换失败：' + String(r.stderr || (r.stdout || '')).slice(0, 200) };
    } catch (e) { return { error: 'PDF 转换失败：' + e.message }; }
  } else {
    return { error: '不支持的转换：' + ext + ' → ' + targetExt + '（支持 md/txt→docx、csv→xlsx、md/txt/csv→pdf）' };
  }
  const st = fs.statSync(path.join(DELIVER_DIR, outName));
  return { ok: true, item: { name: outName, ext: targetExt, size: st.size, mtime: st.mtimeMs, textType: false } };
}
function deliverDelete(fileName) {
  const safe = path.basename(String(fileName || ''));
  const fp = path.join(DELIVER_DIR, safe);
  try { if (!fs.existsSync(fp)) return { error: '文件不存在' }; fs.unlinkSync(fp); return { ok: true }; }
  catch (e) { return { error: '删除失败：' + e.message }; }
}

/* ---------------- 辩题档案夹（按辩题归集对话与产物） ----------------
   设计：cases.json 只存「哪个辩题关了哪些对话 / 哪些产物」的轻量索引，
   真实数据仍在 chats/ 与 deliverables/ 原处。删辩题只删索引，不删用户文件。
   辩题识别在服务端做（前端只负责选择/新建），这样浏览器与 Electron 行为一致。 */

function caseLoadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(CASE_INDEX, 'utf8'));
    if (j && Array.isArray(j.cases)) return j;
  } catch (_) {}
  return { version: 1, cases: [] };
}
function caseSaveIndex(idx) {
  writeJsonAtomic(CASE_INDEX, idx);
}
function caseNewId() {
  return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
/* 归一化辩题：去空白/标点差异，用于「同一个辩题别建两份」的匹配 */
function caseNorm(t) {
  return String(t || '')
    .replace(/[「」『』“”"'《》〈〉（）()【】\[\]]/g, '')
    .replace(/[\s\-—_·、,，.。:：;；!！?？]/g, '')
    .toLowerCase();
}
function caseFindByMotion(motion) {
  const n = caseNorm(motion);
  if (!n) return null;
  return caseLoadIndex().cases.find((c) => caseNorm(c.motion) === n) || null;
}
/* 从一段文字里猜辩题：优先书名号/引号包裹的「A应该/不应该B」，
   其次「辩题是/辩题：」后的整句。猜不到返回 ''（让前端走手动新建）。 */
/* 剥掉辩题后面黏着的「我持正方 / 持反方 / 我是反方 / 正方」等持方说明 —— 那不是辩题的一部分 */
function caseStripSideTail(s) {
  return String(s || '')
    .replace(/[，,、\s]*(?:我|我们|本方|我方)?\s*(?:持|站|打|是)?\s*(?:正方|反方)\s*(?:立场|方)?\s*[。.！!]?\s*$/g, '')
    .replace(/[，,、\s]*(?:请|帮我|请帮我|麻烦).*$/g, '')
    .trim();
}
function caseGuessMotion(text) {
  const s = String(text || '').slice(0, 4000);
  if (!s) return '';
  // ① 「…」/ "…" 里带 应该/不应该/应当/不应 / 是不是 的，最像辩题
  const quoted = s.match(/[「“”"']([^「」“”"']{6,80})[」“”"']/g) || [];
  for (const q of quoted) {
    const inner = q.replace(/^[「“”"']|[」“”"']$/g, '').trim();
    if (/应该|不应该|应当|不应|需不需要|是不是/.test(inner) || inner.includes('/')) return caseStripSideTail(inner);
  }
  // ② 「辩题是/辩题：」后面的整句，截到换行或标点（再剥掉尾部持方）
  const m = s.match(/辩题[是为:]?[:：]?\s*([^\n，。；!？]{6,80})/);
  if (m) {
    const v = caseStripSideTail(m[1]);
    if (v) return v;
  }
  // ③ 「A 还是 B」「A vs B」这类对立结构（取最贴近关键词的那一段，去掉「这场比赛讨论」之类前缀）
  const vs = s.match(/([^\n，。；]{2,40}?)\s*(?:还是|vs|VS|对)\s*([^\n，。；]{2,40})/);
  if (vs) {
    const a = caseStripSideTail(vs[1]).replace(/^.*?(?:讨论|辩题是|关于|就|针对)\s*/, '').trim();
    const b = caseStripSideTail(vs[2]).trim();
    if (a && b) return a + ' 还是 ' + b;
  }
  return '';
}
/* 把对话 / 产物挂到辩题上；motion 为空时尝试从 text 猜。
   attach: { chatId } 或 { deliverable } */
function caseAttach(motion, attach, opts) {
  const idx = caseLoadIndex();
  let name = String(motion || '').trim().slice(0, 60);
  if (!name && opts && opts.text) name = caseGuessMotion(opts.text).slice(0, 60);
  if (!name) return { error: '没有辩题' };
  let c = idx.cases.find((x) => caseNorm(x.motion) === caseNorm(name));
  if (!c) {
    c = { id: caseNewId(), motion: name, created: Date.now(), updated: Date.now(), side: '', chatIds: [], deliverables: [] };
    idx.cases.unshift(c);
  }
  if (attach && attach.chatId && !c.chatIds.includes(attach.chatId)) c.chatIds.push(attach.chatId);
  if (attach && attach.deliverable && !c.deliverables.includes(attach.deliverable)) c.deliverables.push(attach.deliverable);
  if (opts && typeof opts.side === 'string') c.side = opts.side.slice(0, 20);
  c.updated = Date.now();
  idx.cases.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  caseSaveIndex(idx);
  return { caseItem: c };
}
function casePublic(c, allChats) {
  const chatTitles = (c.chatIds || []).map((id) => {
    const ch = allChats.find((x) => x.id === id);
    return { id, title: ch ? (ch.title || '未命名') : '（对话已删除）', mode: ch ? ch.mode : '' };
  });
  return {
    id: c.id, motion: c.motion, side: c.side || '',
    created: c.created, updated: c.updated,
    chats: chatTitles,
    deliverables: (c.deliverables || []).slice(),
  };
}
/* ---- DELIVER 协议：Agent 在最终回复末尾附指令块自动转档 ----
   格式：<!-- DELIVER: 源文件名.md -> docx [到 子目录] -->   （可叠加多个块）
   只允许源文件在 data/deliverables 下；目标目录也必须在该目录内（防越权写别处）。 */
const DELIVER_SRC_PREFIX = dataDirSlash(DELIVER_DIR);
function dataDirSlash(p) { return String(p).replace(/\\/g, '/'); }
function deliverProtocolParse(stdout) {
  const out = { cleaned: String(stdout || ''), requests: [] };
  const re = /<!--\s*DELIVER:\s*([^\n\r]+?)\s*-->/g;
  let m;
  while ((m = re.exec(out.cleaned)) !== null) {
    const body = m[1].trim();
    const mm = body.match(/^(.+?)\s*(->|->|->|→)\s*(docx|xlsx|pdf)(?:\s*(?:到|至|去|to)\s+(.+))?$/i);
    if (!mm) continue;
    const srcName = path.basename(String(mm[1]).trim());
    const fmt = String(mm[2]).toLowerCase();
    const sub = String(mm[3] || '').trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
    out.requests.push({ src: srcName, fmt, sub });
    out.cleaned = out.cleaned.replace(m[0], '');
  }
  return out;
}
function deliverConvertTo(spec) {
  // 源必须在 deliverables 内（防路径穿越）
  const srcPath = path.join(DELIVER_DIR, path.basename(String(spec.src || '')));
  if (!fs.existsSync(srcPath)) return { error: 'DELIVER 源文件不存在：' + spec.src };
  const ext = path.extname(srcPath).toLowerCase().replace('.', '');
  const baseName = path.basename(srcPath).replace(/\.[^.]+$/, '');
  const dirAbs = spec.sub ? path.join(DELIVER_DIR, spec.sub) : DELIVER_DIR;
  ensureDir(dirAbs);
  const target = path.join(dirAbs, baseName + '.' + spec.fmt);
  // 目标必须落在 deliverables 下
  if (dataDirSlash(target).indexOf(DELIVER_SRC_PREFIX) !== 0) return { error: 'DELIVER 目标越界' };
  try {
    if (spec.fmt === 'docx') {
      if (!/md|markdown|txt/.test(ext)) return { error: 'docx 只支持从 md/markdown/txt 转换' };
      const { markdownToDocx } = require('./docx');
      fs.writeFileSync(target, markdownToDocx(fs.readFileSync(srcPath, 'utf8'), { title: baseName }));
    } else if (spec.fmt === 'xlsx') {
      if (ext !== 'csv') return { error: 'xlsx 只支持从 csv 转换' };
      const { csvToXlsx } = require('./xlsx-gen');
      fs.writeFileSync(target, csvToXlsx(fs.readFileSync(srcPath, 'utf8'), baseName.slice(0, 31)));
    } else if (spec.fmt === 'pdf') {
      if (!/md|markdown|txt|csv/.test(ext)) return { error: 'pdf 只支持从 md/txt/csv 转换' };
      const elec = path.join(ROOT, 'runtime', 'electron', 'dist', 'electron.exe');
      const worker = path.join(__dirname, 'pdf-worker.js');
      if (!fs.existsSync(elec) || !fs.existsSync(worker)) return { error: '桌面版 Electron 不可用，无法转 PDF' };
      const r = spawnSync(elec, [worker, '--in', srcPath, '--out', target, '--title', baseName], { windowsHide: true, timeout: 90000, encoding: 'utf8' });
      if (r.error || r.status !== 0 || !fs.existsSync(target)) return { error: 'PDF 转换失败：' + String(r.stderr || (r.stdout || '')).slice(0, 200) };
    } else return { error: '不支持的格式：' + spec.fmt };
    const st = fs.statSync(target);
    return { ok: true, rel: libRel(path.join('data', 'deliverables', spec.sub || '', path.basename(target))), item: { name: path.basename(target), ext: spec.fmt, size: st.size, mtime: st.mtimeMs, textType: false } };
  } catch (e) { return { error: e.message }; }
}


/* 分级裁剪：优先保住「用户需求 + 铁律 + 资料库片段」，依次让出对话历史、流水、片段长度
   顺序：全量 → 历史 4 轮 → 历史 3 轮/条 1200/片段 400 → 历史 2 轮/条 800/去流水/片段 300 → 无历史/去流水/片段 200 */
function buildTaskInBudget(runId, mode, text, history, opts = {}) {
  const attempts = [
    {},
    { historyRounds: 4 },
    { historyRounds: 3, historyItemLimit: 1200, libraryKeep: 3, snippetChars: 400, deliverablesKeep: 8 },
    { historyRounds: 2, historyItemLimit: 800, skipDaily: true, libraryKeep: 2, snippetChars: 300, deliverablesKeep: 5 },
    { historyRounds: 0, historyItemLimit: 0, skipDaily: true, libraryKeep: 2, snippetChars: 200, deliverablesKeep: 3 },
  ];
  // 这些输入与裁剪档位无关，只算一次（原先每档都要重读记忆/流水/召回/技能，最多 5 遍）
  const longSel = selectLongMemory(text);
  const dailySel = selectRecentDaily(2, longSel.fps, MEM_DAILY_MAX);
  const pre = {
    memory: longSel.text,
    memoryTotal: longSel.total,
    memoryShown: longSel.shown,
    recentDaily: dailySel.text,
    dailySkipped: dailySel.skipped,
    // 召回排除本轮已注入的长期条目：同一段内容不再二次占上下文
    recalled: memoryKeywordRecall(text, history, longSel.fps),
    userSkills: (() => {
      try { return skillScanUser().filter((s) => s.enabled && s.valid); } catch (_) { return []; }
    })(),
  };
  // 记忆注入量可观测：一眼看出本轮为记忆付了多少上下文成本
  try {
    console.log('[memory] 注入 长程 ' + pre.memoryShown + '/' + pre.memoryTotal + ' 条（' + pre.memory.length
      + ' 字）· 流水 ' + pre.recentDaily.length + ' 字（跳过重复 ' + pre.dailySkipped + ' 条）· 召回 '
      + pre.recalled.length + ' 条');
  } catch (_) {}
  let md = '';
  for (const a of attempts) {
    let lib = opts.library;
    if (Array.isArray(lib) && a.libraryKeep) {
      lib = lib.slice(0, a.libraryKeep).map((d) => (a.snippetChars
        ? Object.assign({}, d, { snippet: String(d.snippet || '').slice(0, a.snippetChars) })
        : d));
    }
    md = buildTaskFile(runId, mode, text, history, Object.assign({}, opts, a, { library: lib, pre }));
    if (md.length <= INLINE_TASK_LIMIT) return md;
  }
  return md;
}

/* ---------------- 文件工具 ---------------- */
function buildTaskFile(runId, mode, text, history, opts = {}) {
  const meta = MODE_META[mode] || MODE_META.free;
  const lines = [];
  lines.push('# Academy 辩论教练 · 任务单 ' + runId);
  lines.push('');
  lines.push('> 这是由桌面 App 生成的本地任务文件。你是「逻敏」辩论教练。');
  lines.push('> 若外层提示已直接给出本任务单全文，请直接按内容执行，不必再读本文件；');
  lines.push('> 若你只看到任务单开头或没有看到全文，请先用文件工具完整读取本文件，再按其中要求执行。');
  lines.push('');
  lines.push('## 任务类型');
  lines.push(meta.label);
  lines.push('');
  lines.push(meta.extra);
  lines.push('');

  // 多级记忆：长期记忆（常驻核心 + 相关性召回）+ 最近流水（未晋升部分）+ 主动召回。
  // 三段各有字符预算、彼此按内容指纹判重 —— 同一段记忆不会在任务单里出现两次。
  const pre = opts.pre || (() => {
    const longSel = selectLongMemory(text);
    const dailySel = selectRecentDaily(2, longSel.fps, MEM_DAILY_MAX);
    return {
      memory: longSel.text,
      memoryTotal: longSel.total,
      memoryShown: longSel.shown,
      recentDaily: dailySel.text,
      dailySkipped: dailySel.skipped,
      recalled: memoryKeywordRecall(text, history, longSel.fps),
    };
  })();
  if (pre.memory) {
    lines.push('## 长程记忆（长期归档，重要）');
    lines.push('');
    lines.push(pre.memory);
    lines.push('');
    if (pre.memoryShown < pre.memoryTotal) {
      lines.push('> 长期记忆共 ' + pre.memoryTotal + ' 条，此处只列出「最近 ' + MEM_CORE_ENTRIES
        + ' 条 + 与本问题最相关的若干条」，共 ' + pre.memoryShown + ' 条。'
        + '需要其余条目时，用文件工具读取 `data/memory.md`（历史归档在 `data/memory/archive-long.md`）。');
      lines.push('');
    }
  }
  const recentDaily = opts.skipDaily ? '' : pre.recentDaily;
  if (recentDaily) {
    lines.push('## 最近流水（memory/ 近期观察，供参考）');
    lines.push('');
    lines.push(recentDaily);
    lines.push('');
  }
  const recalled = pre.recalled || [];
  if (recalled.length) {
    lines.push('## 相关记忆召回（与当前问题匹配的历史记录）');
    lines.push('');
    lines.push(recalled.join('\n\n'));
    lines.push('');
  }

  // 个人资料库：按关键词召回用户自己的资料片段
  if (Array.isArray(opts.library) && opts.library.length) {
    lines.push('## 个人资料库（用户自己上传的资料，优先级高于通用知识）');
    lines.push('');
    lines.push('下面是按本次任务的关键词，从用户自己的资料库里召回的片段。涉及该辩题的事实、数据、口径、已有话术，优先采用这里的说法。');
    lines.push('需要看完整原文时，用文件工具读取该条给出的路径（相对工作区根目录）。');
    lines.push('');
    for (let i = 0; i < opts.library.length; i++) {
      const d = opts.library[i];
      lines.push('### ' + (i + 1) + '. 《' + d.name + '》');
      lines.push('');
      lines.push('- 全文字数：' + Number(d.charCount || 0).toLocaleString('en-US') + ' 字');
      lines.push('- 相关度：' + d.score + '（越高越相关）');
      lines.push('- 全文路径：' + d.path);
      lines.push('');
      lines.push('> ' + String(d.snippet || '').split('\n').join('\n> '));
      lines.push('');
    }
    lines.push('（以上只是摘录。若判断某份资料与本次任务强相关，务必读取全文路径后再动笔。）');
    lines.push('');
  }


  // 用户自装技能：让 Agent 知道有哪些可用（可要求按需加载）
  try {
    const userSkills = opts.pre ? opts.pre.userSkills : skillScanUser().filter((s) => s.enabled && s.valid);
    if (userSkills.length) {
      lines.push('## 用户已安装技能（用户自己加的 skill，可选用）');
      lines.push('');
      lines.push('本机用户启用了以下技能。若本任务与其描述相关，先用文件工具读取其全文（路径为相对工作区根目录），并按其中 SOP 执行：');
      lines.push('');
      for (const sk of userSkills) {
        lines.push('- **' + sk.name + '**：' + (sk.description || '') + (sk.whenToUse ? '（适用：' + sk.whenToUse + '）' : ''));
        lines.push('  - 路径：`data/.dsh/skills/' + sk.fileName + '`');
      }
      lines.push('');
    }
  } catch (_) {}

  lines.push('## 用户需求（完整原文，勿省略）');
  lines.push('');
  lines.push(String(text || '').trim() || '（用户没有输入文字）');
  lines.push('');

  const histRounds = opts.historyRounds === undefined ? HISTORY_ROUNDS : Number(opts.historyRounds) || 0;
  const histItemLimit = opts.historyItemLimit === undefined ? HISTORY_ITEM_LIMIT : Number(opts.historyItemLimit) || 0;
  const hist = (Array.isArray(history) && histRounds > 0) ? history.slice(-histRounds * 2) : [];
  if (hist.length && histItemLimit > 0) {
    lines.push('## 对话上下文（最近几轮，供你保持连贯）');
    lines.push('');
    for (const m of hist) {
      if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
      const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? '教练（你之前的回复）' : '对话');
      const body = m.text.trim().slice(0, histItemLimit);
      lines.push('### ' + role);
      lines.push('');
      lines.push(body);
      lines.push('');
    }
  }

  /* 产物空间清单：告诉 Agent 它自己以前写过什么。
     没有这一段，"基于上次那版备赛包改"是无从下手的——Agent 看不见产物目录里有什么。
     只列文本类产物（二进制它读不了），按修改时间倒序取最近 N 份。 */
  {
    const dvLimit = opts.deliverablesKeep || 12;
    let dv = [];
    try { dv = deliverList().filter((x) => x.textType); } catch (_) { dv = []; }
    if (dv.length) {
      const shown = dv.slice(0, dvLimit);
      lines.push('## 你已经写过的产物（产物空间 data/deliverables/）');
      lines.push('');
      lines.push('下面是你（或用户手动保存）此前产出过的文件。用户说「接着上次那版改」「基于之前的备赛包」时，');
      lines.push('**先用文件工具读取对应文件全文再动笔**，不要凭空重写，也不要说找不到。');
      lines.push('决定覆盖哪个文件时：优先新建新版本（如加 _v2），确需覆盖先说明理由。');
      lines.push('');
      for (const d of shown) {
        const dt = new Date(d.mtime || Date.now());
        const p2 = (x) => String(x).padStart(2, '0');
        const stamp = dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate()) + ' ' + p2(dt.getHours()) + ':' + p2(dt.getMinutes());
        lines.push('- `data/deliverables/' + d.name + '`　（' + stamp + '，' + Math.max(1, Math.round(d.size / 1024)) + 'KB）');
      }
      if (dv.length > shown.length) lines.push('- …以及更早的 ' + (dv.length - shown.length) + ' 份（用文件工具列目录查看）');
      lines.push('');
    }
  }

  lines.push('## 通用执行铁律');
  lines.push('');
  lines.push('1. 遵守根目录 `AGENTS.md` 与 `SOUL.md` 的全部规则。');
  lines.push('2. 动笔前至少加载一个对应的方法论文档；写完对照模板检查清单自检。');
  lines.push('3. 话术交付：每条策略建议必须配一句可以直接上场念的话。');
  lines.push('4. 攻防分级是统一语言：打钉子 / 击穿。');
  if (opts.searchEnabled !== false) {
    lines.push('5. 事实类信息（数据/法条/事件）优先用 web_search 核实，不编造。本机已提供端侧搜索代理，即使模型接口不是 DeepSeek 官方也可以调用 web_search。');
  } else {
    lines.push('5. 当前未配置可用的联网搜索服务：事实类信息基于本地知识库回答，缺少数据时明确说"需要联网核实"，不要调用 web_search。');
  }
  lines.push('6. 本内核是单智能体模式：不要调用 subagent / TeamCreate 之类的团队工具，由你自己按「逻敏团队」各成员的角色依次完成各阶段工作。');
  lines.push('7. 【产物空间】长篇交付（备赛包 / 复盘报告 / 述票词 / 数据表等）请落盘到产物空间：');
  lines.push('   目录：data/deliverables/（相对工作区根目录）');
  lines.push('   格式：文本类直接写 .md / .csv / .txt（Word/Excel/PDF 由用户在产物空间一键转档，你不用生成二进制文件）；');
  lines.push('   命名：<日期>_<辩题/用途>_<类型>.扩展名，如 2026-09-09_人工智能版权_反方备赛包.md、攻防记录.csv；');
  lines.push('   完成后在回复正文给「概要 + 文件名」，正文不必再粘贴全文；');
  lines.push('   除 data/deliverables/ 外的任何文件都不要新建或修改（data/tasks、data/chats、knowledge 等一律只读）。');
  lines.push('   若用户要 Word/Excel/PDF，把文本产物写进 data/deliverables/ 后，在最终回复末尾附协议块：<!-- DELIVER: 文件名.md -> docx [到 子目录] -->，服务端会自动转档（docx/xlsx/pdf 均可）。');
  if (opts.extendedTools) {
    lines.push('【扩展模式已开启（你已确认风险）】');
    lines.push('   - 允许按用户明确要求写文件到其指定的任意路径/文件夹；');
    lines.push('   - 允许使用 run_code（TypeScript）处理文档：读取/转换/生成 Excel/Word/PDF/md 到用户指定位置；');
    lines.push('   - 仍遵守：不读取用户未授权的隐私文件、不对用户做破坏性操作（删除/覆盖重要文件先经确认）；');
    lines.push('   - 做完格式化交付后，按第 7 条产出 file 产物（文本或指定格式），文件位置写入回复。');
  }
  lines.push('8. 输出使用中文 Markdown；给用户看的最终答复要完整、结构清晰。');
  lines.push('9. 单次输出有 token 上限：写一辩稿/长报告等长篇交付时，优先保证「正稿主体完整」，过程性说明（加载了哪些文件、搜索过程等）尽量一句话带过，避免因输出超长被截断导致任务失败。');
  lines.push('10. 记忆：若本次对话中有「值得长期记住」的内容（你的常用判准、辩题笔记、资料索引、用户偏好、基准结论等），在最终回复末尾单独附加 HTML 注释块 `<!-- MEMORY: 要记住的内容 -->`（服务端归档到长期记忆）；若只是「短期观察/可复用的过程信息」，用 `<!-- NOTE: 内容 -->`（归档到当日流水）。不要修改任何文件，不要重复已存在于「长程记忆」段落的内容。');
  if (Array.isArray(opts.library) && opts.library.length) {
    lines.push('11. 本次任务已附带「个人资料库」召回片段：这些是用户自己的备赛资料，优先级高于通用知识。引用其中的数据、口径、话术时直接采用；需要更多细节时用文件工具读取片段后给出的全文路径。资料库里没有的内容，不要说成来自资料库。');
  }
  lines.push('');
  return lines.join('\n');
}

/* ---------------- DSH 运行 ---------------- */
let currentRun = null; // { runId, child, cancelled, startedAt }

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) { try { child.kill(); } catch (_) {} }
}

function friendlyError(info) {
  const all = ((info.stderr || '') + '\n' + (info.stdout || '')).toLowerCase();
  if (info.cancelled) return '已由用户取消。';
  if (info.timedOut) return '运行超时（' + Math.round((DEFAULT_TIMEOUT_MS / 60000)) + ' 分钟）。复杂任务可以拆分后再试。';
  if (all.includes('missing_credential') || all.includes('no api key')) {
    return '还没有可用的 API Key，或 Key 无效。请点击右上角「设置」填写 API Key。';
  }
  if (all.includes('invalid_api_key') || all.includes('authentication') || all.includes('401')) {
    return 'API Key 校验失败（401）。请确认 Key 是否完整、是否还有额度。';
  }
  if (all.includes('model_not_found') || all.includes('model does not exist')) {
    return '模型名不可用。请在设置中检查模型名是否与该 API 服务商匹配。';
  }
  if (all.includes('insufficient') || all.includes('balance') || all.includes('402')) {
    return 'API 账户余额不足，请先充值。';
  }
  const stderrLines = String(info.stderr || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const last = stderrLines.slice(-2).join(' | ');
  return 'Agent 运行失败（exit ' + info.code + '）。' + (last ? ' 详情：' + last.slice(0, 300) : '');
}

/* ---------------- DSH 会话流式增量（tail session.jsonl） ---------------- */
/* v1.2 起会话日志改为明文 JSONL；旧版 zstd 日志整体迁移到备份目录，内容不丢 */
function migrateZstdSessions() {
  // 一次性迁移：做完就落标记，之后不再遍历整棵 sessions 树
  const marker = path.join(DSH_HOME, '.zstd-migrated');
  try { if (fs.existsSync(marker)) return; } catch (_) {}
  const root = path.join(DSH_HOME, 'sessions');
  const backup = path.join(DSH_HOME, 'sessions-zstd-backup');
  if (!fs.existsSync(root)) { try { fs.writeFileSync(marker, new Date().toISOString(), 'utf8'); } catch (_) {} return; }
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      const r = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) walk(p, r);
      else if (ent.isFile() && ent.name.endsWith('.jsonl.zstd')) {
        try {
          const dest = path.join(backup, r);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(p, dest);
        } catch (_) {}
      }
    }
  };
  walk(root, '');
  try { fs.writeFileSync(marker, new Date().toISOString(), 'utf8'); } catch (_) {}
}

function listSessionLogs() {
  const root = path.join(DSH_HOME, 'sessions');
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function createSessionWatcher(startedAt) {
  return { startedAt, offsets: new Map(), buffers: new Map(), toolNames: new Map() };
}
/* 兼容新旧内核 session 格式提取 usage chunk：
   0.1.1 旧格式：rec.type === 'assistant/chunk'，usage 在 rec.data.chunk
   0.1.5 新格式：rec.type === 'assistant/message'，各 chunk 装进 rec.data.stream[] 项的 .chunk
  （stream 项形如 {type:'chunk', time, chunk:{type:'usage', usage:{…}}}），chunk 本体结构与旧版一致 */
function usageChunksFromRecord(rec) {
  const out = [];
  if (rec.type === 'assistant/chunk' && rec.data?.chunk?.type === 'usage' && rec.data.chunk.usage) {
    out.push(rec.data.chunk.usage);
  } else if (rec.type === 'assistant/message' && Array.isArray(rec.data?.stream)) {
    for (const item of rec.data.stream) {
      const c = item ? (item.chunk || item) : null;
      if (c && c.type === 'usage' && c.usage) out.push(c.usage);
    }
  }
  return out;
}
function normalizeUsage(u) {
  return {
    inputTokens: Number(u.inputTokens) || 0,
    outputTokens: Number(u.outputTokens) || 0,
    cacheReadTokens: Number(u.cacheReadTokens) || 0,
    cacheWriteTokens: Number(u.cacheWriteTokens) || 0,
    reasoningTokens: Number(u.reasoningTokens) || 0,
  };
}
/* 从本次运行的最后 session 文件中读取最后一条 usage chunk（headless 模式 watcher 常漏读，这里兜底） */
function extractFinalUsage(startedAt, model) {
  try {
    const root = path.join(DSH_HOME, 'sessions');
    // 找最近修改的 session.jsonl
    let newest = null, newestT = 0;
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of ents) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          try { const t = fs.statSync(p).mtimeMs; if (t > newestT) { newestT = t; newest = p; } } catch (_) {}
        }
      }
    };
    walk(root);
    if (!newest || newestT < startedAt - 5000) return null;
    const lines = fs.readFileSync(newest, 'utf8').split('\n');
    let usage = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        const us = usageChunksFromRecord(o);
        if (us.length) {
          usage = normalizeUsage(us[us.length - 1]);
          break;
        }
      } catch (_) {}
    }
    if (usage) process.stderr.write('[usage] extracted: ' + JSON.stringify(usage) + '\n');
    else process.stderr.write('[usage] none found (newest=' + (newest||'').slice(-30) + ' t=' + newestT + ' startedAt=' + startedAt + ')\n');
    return usage;
  } catch (e) { process.stderr.write('[usage] err: ' + e.message + '\n'); return null; }
}


function toolArgsSummary(args) {
  if (args === undefined || args === null) return '';
  try {
    if (typeof args === 'string') return args.slice(0, 160);
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch (_) { return ''; }
}

function toolResultSummary(message) {
  try {
    const content = message?.content;
    if (!Array.isArray(content)) return '';
    const texts = [];
    for (const block of content) {
      if (typeof block?.text === 'string') texts.push(block.text);
      else if (Array.isArray(block?.content)) {
        for (const inner of block.content) if (typeof inner?.text === 'string') texts.push(inner.text);
      }
    }
    const s = texts.join(' ').replace(/\s+/g, ' ').trim();
    return s.length > 220 ? s.slice(0, 220) + '…' : s;
  } catch (_) { return ''; }
}

/* 读取本次运行新写入的会话事件，返回 UI 事件数组 */
function drainSessionWatcher(w) {
  const events = [];
  for (const file of listSessionLogs()) {
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; }
    if (stat.mtimeMs < w.startedAt - 3000 || stat.size === 0) continue;
    const offset = w.offsets.get(file) || 0;
    if (stat.size <= offset) continue;
    const len = stat.size - offset;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(len, 2 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      w.offsets.set(file, stat.size);
      let buffered = (w.buffers.get(file) || '') + buf.toString('utf8');
      const lines = buffered.split(/\r?\n/);
      w.buffers.set(file, lines.pop() || '');
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (_) { continue; }
        if (!rec || typeof rec.type !== 'string') continue;
        const chunk = rec.data?.chunk;
        /* 内核 0.1.5 起，原本作为「顶层记录」的 text-chunks / reasoning-chunks
           被挪进了 assistant/message 的 data.stream[] 里（与 usage 同一批改动）。
           只认顶层记录会导致一个 delta 都取不到 → 表现为「不流式、卡很久后整段蹦出」。
           下面先从 stream[] 里把这两类块抽出来，再走原有的顶层分支（向后兼容旧格式）。 */
        let handledInline = false;
        if (rec.type === 'assistant/message' && Array.isArray(rec.data?.stream)) {
          for (const item of rec.data.stream) {
            if (!item) continue;
            const itype = item.type || (item.chunk && item.chunk.type);
            if (itype === 'text-chunks' && Array.isArray(item.texts)) {
              const text = item.texts.join('');
              // texts + dt 一起带到前端：按字块的真实间隔回放，观感等同真流式
              if (text) events.push({ type: 'delta', text, dt: Array.isArray(item.dt) ? item.dt : null, texts: item.texts, time0: item.time0 || 0 });
            } else if (itype === 'reasoning-chunks' && Array.isArray(item.texts)) {
              const text = item.texts.join('');
              if (text) events.push({ type: 'reasoning', text, dt: Array.isArray(item.dt) ? item.dt : null, texts: item.texts, time0: item.time0 || 0 });
            } else if (item.chunk && item.chunk.type === 'text-delta' && typeof item.chunk.text === 'string') {
              events.push({ type: 'delta', text: item.chunk.text });
            } else if (item.chunk && item.chunk.type === 'reasoning-delta' && typeof item.chunk.text === 'string') {
              events.push({ type: 'reasoning', text: item.chunk.text });
            }
          }
          handledInline = true;
        }
        if (handledInline) {
          // 该记录的文本/推理已从 stream[] 抽取完；usage 仍由下面的 else 分支统一处理
          const us2 = usageChunksFromRecord(rec);
          if (us2.length) events.push({ type: 'usage', usage: normalizeUsage(us2[us2.length - 1]) });
        } else if (rec.type === 'text-chunks' && Array.isArray(rec.data?.texts)) {
          const text = rec.data.texts.join('');
          if (text) events.push({ type: 'delta', text });
        } else if (rec.type === 'reasoning-chunks' && Array.isArray(rec.data?.texts)) {
          const text = rec.data.texts.join('');
          if (text) events.push({ type: 'reasoning', text });
        } else if (rec.type === 'assistant/chunk' && chunk) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            events.push({ type: 'delta', text: chunk.text });
          } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            events.push({ type: 'reasoning', text: chunk.text });
          }
        } else if (rec.type === 'tool/call') {
          const callId = String(rec.data?.callId || '');
          const name = String(rec.data?.name || rec.data?.toolName || rec.data?.tool || '工具');
          if (callId) w.toolNames.set(callId, name);
          events.push({ type: 'tool', state: 'start', callId, name, detail: toolArgsSummary(rec.data?.arguments ?? rec.data?.args) });
        } else if (rec.type === 'tool/result') {
          const callId = String(rec.data?.message?.source?.callId || '');
          const name = w.toolNames.get(callId) || '工具';
          events.push({ type: 'tool', state: 'done', callId, name, detail: toolResultSummary(rec.data?.message) });
        } else {
          // usage：新旧内核格式都走这里（旧=assistant/chunk，新=assistant/message 的 stream 数组）
          const us = usageChunksFromRecord(rec);
          if (us.length) {
            events.push({ type: 'usage', usage: normalizeUsage(us[us.length - 1]) });
          }
        }
      }
    } catch (_) {
      try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
    }
  }
  return events;
}

function runDsh(runId, taskText, cfg, stream) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const bin = dshBin();
    const node = bundledNode();
    migrateZstdSessions();
    ensureStreamPlugin();
    // 补丁必须用「实例化到 data/ 的本机版本」——模板里是相对占位，内核加载不了
    const patchPath = materializePatch();
    const extended = cfg.extendedTools === true;
    const env = Object.assign({}, process.env, {
      DSH_HOME: DSH_HOME,
      // 普通模式：工作区写权限；扩展模式：全权 + code-mode（模型可见 run_code）——设置里已做风险确认
      DSH_PERMISSION_MODE: extended ? 'danger-full-access' : 'workspace-write',
      DSH_TOOLS_MODE: extended ? 'code' : undefined,
      DEEPSEEK_API_KEY: String(cfg.apiKey || '').trim(),
      ACADEMY_NO_OPEN: '1',
    });
    if (env.DSH_TOOLS_MODE === undefined) delete env.DSH_TOOLS_MODE;
    delete env.DEEPSEEK_KEY;
    const args = ['--profile', 'headless', '--patch', patchPath, taskText];
    let child;
    try {
      child = spawn(node, [bin].concat(args), {
        cwd: ROOT,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '无法启动引擎：' + e.message, launchError: true });
      return;
    }

    const info = { code: null, stdout: '', stderr: '', cancelled: false, timedOut: false };
    const watcher = createSessionWatcher(startedAt);
    const emitSessionEvents = () => {
      const evs = drainSessionWatcher(watcher);
      for (const ev of evs) {
        // dt：该段每个字块的真实生成间隔，前端据此按原速回放（内核只在 step 结束时整段落盘）
        if (ev.type === 'delta') stream('delta', { text: ev.text, dt: ev.dt || null, texts: ev.texts || null, time0: ev.time0 || 0 });
        else if (ev.type === 'reasoning') stream('reasoning', { text: ev.text, dt: ev.dt || null, texts: ev.texts || null, time0: ev.time0 || 0 });
        else if (ev.type === 'tool') stream('tool', { state: ev.state, callId: ev.callId, name: ev.name, detail: ev.detail || '' });
        else if (ev.type === 'usage') stream('usage', { usage: ev.usage, contextWindow: ctxWindowOf(cfg.model) });
      }
    };
    currentRun = { runId, child, cancelled: false, startedAt };
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearInterval(deltaTimer);
      clearTimeout(timer);
      try { emitSessionEvents(); } catch (_) {}

      if (currentRun && currentRun.runId === runId) {
        info.cancelled = !!currentRun.cancelled;
        currentRun = null;
      }
      try {
        writeJsonAtomic(path.join(TASK_DIR, runId + '.result.json'), {
          runId, time: now(), code: info.code, cancelled: info.cancelled,
          timedOut: info.timedOut, stdoutLength: info.stdout.length,
          stderrTail: info.stderr.slice(-2000),
        });
      } catch (_) {}
      // 归档 Agent 在最终回复末尾附带的 MEMORY/NOTE 块到记忆，并从最终文本中剥离
      if (info.code === 0 && info.stdout) {
        try {
          const mem = archiveMemoryFromOutput(info.stdout);
          if (mem && typeof mem.cleaned === 'string') info.stdout = mem.cleaned;
        } catch (_) {}
      }
      // 自动蒸馏：把较早流水中的有价值段落晋升到长期记忆，并清理过期流水
      try { distillRecentNotes(); } catch (_) {}
      resolve(info);
    };

    child.stdout.on('data', (d) => { info.stdout += d.toString('utf8'); });
    /* stderr 有两条用途：
       ① 内核的 reasoning 流（原样留在 info.stderr 里，供排错与思考过程展示）；
       ② 我们自建插件 academy-text-stream 推的正文增量行（前缀 ACA-TEXT:）。
       正文增量要当场转成 delta 事件推给前端，才能实现逐字显示。
       跨 chunk 的半行用 _textBuf 缓存，避免把一行切成两半解析失败。 */
    let _textBuf = '';
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      info.stderr += s;
      _textBuf += s;
      const lines = _textBuf.split('\n');
      _textBuf = lines.pop() || '';   // 末段可能不完整，留到下次
      for (const line of lines) {
        const i = line.indexOf('ACA-TEXT:');
        if (i < 0) continue;
        const raw = line.slice(i + 9).trim();
        if (!raw) continue;
        let text = '';
        try { text = JSON.parse(raw); } catch (_) { continue; }
        if (typeof text === 'string' && text) stream('delta', { text });
      }
    });

    // 流式推送：120ms 轮询（原 800ms 延迟过高，导致输出一顿一顿）
    const deltaTimer = setInterval(() => {
      if (!currentRun || currentRun.runId !== runId) return;
      try { emitSessionEvents(); } catch (_) {}
    }, 120);

    const heartbeat = setInterval(() => {
      if (currentRun && currentRun.runId === runId) {
        stream('status', { stage: 'running', elapsedMs: Date.now() - currentRun.startedAt });
      }
    }, 4000);

    const timer = setTimeout(() => {
      info.timedOut = true;
      killTree(child);
    }, Number(cfg.timeoutMs) || DEFAULT_TIMEOUT_MS);

    child.on('error', (e) => {
      info.code = -1;
      info.stderr += 'spawn error: ' + e.message;
      settle();
    });
    child.on('exit', (code) => {
      info.code = code === null ? -1 : code;
      settle();
    });
  });
}

/* ---------------- 端侧免费搜索（DuckDuckGo / Bing 网页解析） ---------------- */
function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/* 给搜索结果按域名/标题打轻量分类标签：学术 / 政策法规 / 新闻 / 百科 / 网页 */
function classifySearchSource(s) {
  const u = String(s.url || '').toLowerCase();
  const t = String(s.title || '').toLowerCase();
  const tags = [];
  if (/(arxiv\.org|doi\.org|scholar\.google|cnki\.net|wanfangdata|cqvip|semanticscholar|crossref|pubmed|nature\.com|science\.org|springer|wiley|ieee|xmol|researchgate)/.test(u)) tags.push('学术');
  if (/(\.gov\.cn|\.gov\b|cppcc|npc\.gov|people\.com\.cn|cssn\.cn|chinanews|lawinfochina|pkulaw)/.test(u)) tags.push('政策法规');
  if (/(news|cnn|bbc|cctv|people\.com\.cn|thepaper|sohu\.com|163\.com|sina|ifeng|caixin|jiemian|yicai|nhk)/.test(u) || /(新闻|报道|资讯)/.test(t)) tags.push('新闻');
  if (/(wikipedia|baike|zhihu|quora)/.test(u)) tags.push('百科');
  if (tags.length === 0) tags.push('网页');
  return tags.slice(0, 3);
}

/* 结果质量检测：判断一批来源是否与查询词相关。
   为什么需要它：端侧免费搜索（Bing/DDG 抓取）在部分网络/IP 下会被返回
   降级页面或缓存页——实测搜「人工智能 版权 争议」返回的是百度百科「人工」词条、
   搜「网络暴力 司法解释」返回测速网站。这类结果「看起来正常但完全无关」，
   比直接报错更危险（用户会误信、模型会误用）。宁可判定失败，也不返回垃圾。 */
function scoreSourcesRelevance(query, sources) {
  const q = String(query || '').toLowerCase();
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return { ok: false, score: 0, reason: '没有任何结果' };
  // 中文按 2-gram、英文按单词切分查询词
  const terms = [];
  const segs = q.split(/[\s,，、；;]+/).filter(Boolean);
  for (const seg of segs) {
    if (/^[a-z0-9]{2,}$/i.test(seg)) terms.push(seg);
    else for (let i = 0; i < seg.length - 1; i++) terms.push(seg.slice(i, i + 2));
  }
  if (!terms.length) return { ok: true, score: 1, reason: '' };
  const uniq = Array.from(new Set(terms));
  let hitDocs = 0;
  for (const s of list) {
    const hay = (String(s.title || '') + ' ' + String(s.snippet || '') + ' ' + String(s.url || '')).toLowerCase();
    const hit = uniq.filter((t) => hay.indexOf(t) !== -1).length;
    // 命中超过 1/4 的查询特征词才算相关
    if (hit >= Math.max(2, Math.ceil(uniq.length / 4))) hitDocs++;
  }
  const ratio = hitDocs / list.length;
  // 相关文档不足三成 → 判定为抓取失败（宁缺勿滥）
  const ok = ratio >= 0.3;
  return {
    ok,
    score: Number(ratio.toFixed(2)),
    reason: ok ? '' : ('返回的 ' + list.length + ' 条结果里只有 ' + hitDocs + ' 条与查询相关'),
  };
}

function decodeDdgUrl(href) {
  try {
    const u = new URL(href);
    if (u.hostname.includes('duckduckgo.com') && u.searchParams.has('uddg')) {
      return decodeURIComponent(u.searchParams.get('uddg'));
    }
    return href;
  } catch (_) { return href; }
}

function fetchUrlText(url, redirects = 2) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve(''); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchUrlText(new URL(res.headers.location, u).href, redirects - 1));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (data.length < 400000) data += d; });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(10000, () => { try { req.destroy(); } catch (_) {} resolve(''); });
  });
}

/* ---------------- 自定义搜索服务（通用适配器） ----------------
   为什么做这个：内置的免费抓取（Bing/DDG）在部分网络下会被反爬返回
   「看起来正常但完全无关」的结果，无法通过调参修好。与其给一个必然失败的
   免费通道，不如让用户接入自己可用的搜索服务（Tavily / SearXNG / Brave / 自建等）。
   做成开放适配器而非硬编码各家的 API：用户填地址模板 + 字段路径，
   任何返回 JSON 的搜索服务都能接上，也不存在我猜错某家 API 格式的风险。 */

/* 按 "a.b.c" 或 "a.0.b" 路径从对象里取值 */
function pickByPath(obj, pathStr) {
  if (!pathStr) return undefined;
  const segs = String(pathStr).split('.').filter((s) => s !== '');
  let cur = obj;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else cur = cur[seg];
  }
  return cur;
}

/* 模板替换：{query} 用 URL 编码后的关键词，{apiKey} 用 Key，{queryRaw} 用原文 */
function fillTemplate(tpl, query, apiKey) {
  return String(tpl || '')
    .replace(/\{query\}/g, encodeURIComponent(query))
    .replace(/\{queryRaw\}/g, query)
    .replace(/\{apiKey\}/g, apiKey || '');
}

/* 解析「名称: 值」多行文本为 headers 对象（跳过空行与注释） */
function parseHeaderLines(text, query, apiKey) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = fillTemplate(s.slice(i + 1).trim(), query, apiKey);
    if (k) out[k] = v;
  }
  return out;
}

/* 用自定义搜索服务检索。返回 { ok, sources, error } */
function customSearchResults(query, cs) {
  return new Promise((resolve) => {
    const c = cs || {};
    if (!c.enabled) return resolve({ ok: false, error: '自定义搜索未启用' });
    const tpl = String(c.urlTemplate || '').trim();
    if (!tpl) return resolve({ ok: false, error: '没有填写搜索地址模板' });
    const q = String(query || '').trim();
    if (!q) return resolve({ ok: false, error: '搜索词为空' });

    const apiKey = String(c.apiKey || '').trim();
    const method = String(c.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    const target = fillTemplate(tpl, q, apiKey);
    let u;
    try { u = new URL(target); } catch (_) { return resolve({ ok: false, error: '搜索地址无效：' + target.slice(0, 80) }); }
    const mod = u.protocol === 'https:' ? https : http;

    const headers = Object.assign({
      'Accept': 'application/json',
      'User-Agent': 'AcademyDebateCoach/2.0',
    }, parseHeaderLines(c.headers, q, apiKey));
    // Key 允许只填在 headers 里（如 Brave 用 X-Subscription-Token），
    // 若没写进 headers，则默认补一个 Authorization: Bearer（Tavily 等常用）
    if (apiKey && !Object.keys(headers).some((k) => /authorization|api[-_]?key|token/i.test(k))) {
      headers['Authorization'] = 'Bearer ' + apiKey;
    }

    let payload = null;
    if (method === 'POST') {
      const raw = String(c.bodyTemplate || '').trim();
      payload = raw ? fillTemplate(raw, q, apiKey) : JSON.stringify({ query: q });
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = mod.request(u, { method, headers, timeout: 20000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (data.length < 800000) data += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = '';
          try { const j = JSON.parse(data); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (_) {}
          return resolve({ ok: false, error: 'HTTP ' + res.statusCode + (detail ? '：' + String(detail).slice(0, 120) : '') });
        }
        let j;
        try { j = JSON.parse(data); } catch (_) {
          return resolve({ ok: false, error: '返回的不是 JSON（请检查地址模板是否正确）' });
        }
        const arr = pickByPath(j, c.resultsPath || '');
        if (!Array.isArray(arr)) {
          return resolve({ ok: false, error: '没在响应里找到结果数组，请检查「结果字段路径」（当前填的是 ' + (c.resultsPath || '（空）') + '）' });
        }
        const sources = [];
        const seen = new Set();
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const url = String(pickByPath(item, c.urlPath || 'url') || '').trim();
          const title = String(pickByPath(item, c.titlePath || 'title') || '').trim();
          if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
          seen.add(url);
          const snippet = c.snippetPath ? String(pickByPath(item, c.snippetPath) || '').trim() : '';
          const s = { url, title: title.slice(0, 120), snippet: snippet.slice(0, 300), engine: 'custom' };
          s.tags = classifySearchSource(s);
          sources.push(s);
          if (sources.length >= 12) break;
        }
        if (!sources.length) return resolve({ ok: false, error: '搜索服务没有返回可用结果（结果数组是空的）' });
        resolve({ ok: true, sources });
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: '自定义搜索超时（20 秒）' }); });
    req.on('error', (e) => resolve({ ok: false, error: '请求失败：' + e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/* 预设搜索服务。每个预设只预填「格式」，Key/地址由用户自己补。
   说明：这些服务的 API 格式可能随版本变化，所以预设只是起点，
   用户可以改任意字段；跑不通就点「测试」看具体报错。 */
const SEARCH_PRESETS = [
  {
    id: 'tavily',
    name: 'Tavily（AI 搜索，有免费额度）',
    urlTemplate: 'https://api.tavily.com/search',
    method: 'POST',
    headers: 'Authorization: Bearer {apiKey}\nContent-Type: application/json',
    bodyTemplate: '{"query":"{queryRaw}","max_results":8}',
    resultsPath: 'results',
    titlePath: 'title',
    urlPath: 'url',
    snippetPath: 'content',
    signup: 'https://tavily.com',
    note: '注册后在控制台拿 API Key（tvly- 开头），每月有免费额度。',
  },
  {
    id: 'searxng',
    name: 'SearXNG（自建/公共实例，完全免费）',
    urlTemplate: 'https://your-searxng.example.com/search?q={query}&format=json',
    method: 'GET',
    headers: '',
    bodyTemplate: '',
    resultsPath: 'results',
    titlePath: 'title',
    urlPath: 'url',
    snippetPath: 'content',
    signup: 'https://docs.searxng.org',
    note: '需要自己部署或找公共实例；把上面地址换成你的实例地址。部分实例未开 JSON 输出，需在 settings.yml 里开启 format: json。',
  },
  {
    id: 'brave',
    name: 'Brave Search API（有免费额度）',
    urlTemplate: 'https://api.search.brave.com/res/v1/web/search?q={query}&count=10',
    method: 'GET',
    headers: 'X-Subscription-Token: {apiKey}\nAccept: application/json',
    bodyTemplate: '',
    resultsPath: 'web.results',
    titlePath: 'title',
    urlPath: 'url',
    snippetPath: 'description',
    signup: 'https://brave.com/search/api/',
    note: '注册后在控制台拿订阅令牌，免费档每月有查询额度。',
  },
  {
    id: 'generic',
    name: '自定义（任何返回 JSON 的搜索服务）',
    urlTemplate: '',
    method: 'GET',
    headers: '',
    bodyTemplate: '',
    resultsPath: 'results',
    titlePath: 'title',
    urlPath: 'url',
    snippetPath: '',
    signup: '',
    note: '自己填地址模板和字段路径。地址里用 {query} 表示关键词，请求头里用 {apiKey} 表示密钥。',
  },
];

async function freeSearchResults(query) {
  const q = encodeURIComponent(String(query || '').slice(0, 200));
  if (!q) return [];
  // www.bing.com 会 302 到 cn.bing.com；直接请求 cn 少一跳，也更少被挡
  const [bingHtml, ddgHtml] = await Promise.all([
    fetchUrlText('https://cn.bing.com/search?q=' + q + '&setlang=zh-hans&count=10'),
    fetchUrlText('https://html.duckduckgo.com/html/?q=' + q),
  ]);
  const sources = [];
  const seen = new Set();

  const add = (url, title, snippet, engine) => {
    try { new URL(url); } catch (_) { return; }
    if (seen.has(url) || !/^https?:\/\//i.test(url)) return;
    seen.add(url);
    const s = { url, title: stripHtml(title).slice(0, 120), snippet: stripHtml(snippet).slice(0, 260), engine };
    s.tags = classifySearchSource(s);
    sources.push(s);
  };

  // Bing 结果
  const bingRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m;
  while ((m = bingRe.exec(bingHtml)) !== null && sources.length < 10) add(m[1], m[2], m[3] || '', 'bing');
  // DuckDuckGo HTML 结果
  const ddgA = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const ddgS = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const as = [...ddgHtml.matchAll(ddgA)];
  const ss = [...ddgHtml.matchAll(ddgS)];
  for (let i = 0; i < as.length && sources.length < 10; i++) {
    add(decodeDdgUrl(as[i][1]), as[i][2], ss[i] ? ss[i][1] : '', 'duckduckgo');
  }

  // 质量检测：抓到的结果可能「看起来正常但完全无关」（被反爬/降级页面）。
  // 这时宁可判定失败，也不把垃圾喂给模型和用户。
  const rel = scoreSourcesRelevance(query, sources);
  if (!sources.length || !rel.ok) {
    return [{
      url: 'https://cn.bing.com/search?q=' + q,
      title: '基础检索未找到相关结果',
      snippet: (rel.reason ? '(' + rel.reason + ') ' : '') + '当前网络下免费搜索源可能被限制或返回了无关内容。请改用「深度检索」，或基于本地知识库回答，不要据此编造事实。',
      lowQuality: true,
    }];
  }
  return sources;
}

/* 搜索通道 A：端侧免费（Bing/DuckDuckGo 本地抓取，0 扣费），任何网络可用 */
/* 快速检证：从一条论据里抽出 2~3 个检索词。
   论据常是整句（"据《柳叶刀》2019年研究，中国有9500万抑郁症患者"），
   整句去搜效果差，所以优先抓：书名号/引号里的专名、数字串、以及去掉修饰后的核心词。 */
function buildVerifySeeds(claim) {
  const s = String(claim || '').trim();
  if (!s) return [];
  const out = [];
  const push = (q) => {
    // 去掉首尾标点与不成对的引号（片段截取常会留下半个引号，影响搜索）
    let t = String(q || '').trim().replace(/^[，。；、,.;\s]+|[，。；、,.;\s]+$/g, '');
    for (const [l, r2] of [['《', '》'], ['「', '」'], ['"', '"'], ["'", "'"], ['【', '】']]) {
      const n = t.split(l).length - 1, m = t.split(r2).length - 1;
      if (n !== m) t = t.split(l).join('').split(r2).join('');
    }
    if (t && t.length >= 3 && t.length <= 120 && out.indexOf(t) === -1) out.push(t);
  };
  // ① 书名号 / 引号里的专名
  const quoted = s.match(/[《"「'【]([^》"」'】]{2,40})[》"」'】]/g) || [];
  for (const q of quoted) push(q.replace(/[《》"「」'【】]/g, ''));
  // ② 含数字的关键片段（数字最容易核对）
  const numSeg = s.match(/[^，。；、]{0,18}\d[^，。；、]{0,18}/g) || [];
  for (const q of numSeg.slice(0, 2)) push(q);
  // ③ 兜底：整句前 40 字
  if (!out.length) push(s.slice(0, 40));
  return out.slice(0, 3);
}

/* 端侧检索统一入口：优先用用户配置的自定义搜索服务（可靠），
   没有配置才退回内置免费抓取（可能被反爬挡住，返回结果会带 lowQuality 标记）。 */
async function searchResults(query) {
  const cfg = loadConfig();
  const cs = cfg.customSearch || {};
  if (cs.enabled && String(cs.urlTemplate || '').trim()) {
    const r = await customSearchResults(query, cs);
    if (r.ok) return { provider: 'custom', sources: r.sources, answer: '' };
    // 自定义服务失败：如实上报，不退化成免费抓取的垃圾结果
    return {
      provider: 'custom',
      sources: [{
        url: 'https://www.bing.com/search?q=' + encodeURIComponent(query),
        title: '自定义搜索服务调用失败',
        snippet: (r.error || '未知错误') + '　请到「设置 → 高级 → 自定义搜索服务」检查配置，或点「测试」验证。',
        lowQuality: true,
      }],
      answer: '',
    };
  }
  return { provider: 'free', sources: await freeSearchResults(query), answer: '' };
}

/* ---------------- 搜索通道 B：服务侧（模型商原生 web_search） ----------------
   直连当前模型商 Anthropic 兼容接口的 web_search_20250305 server tool，
   协议与 DSH 内核 @deepseek-ai/dsh-web-search-deepseek 插件一致。
   目前只有 DeepSeek 官方接口提供该能力，其他服务商请用端侧。 */
function searchServerBase(cfg) {
  const c = cfg || loadConfig();
  return isDeepSeekBase(c) ? 'https://api.deepseek.com/anthropic/v1' : '';
}

function postJsonTimeout(target, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (_) { return reject(new Error('无效的搜索接口地址')); }
    const mod = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = mod.request(u, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (data.length < 800000) data += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let detail = '';
          try { const j = JSON.parse(data); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (_) {}
          return reject(new Error('HTTP ' + res.statusCode + (detail ? '：' + String(detail).slice(0, 200) : '')));
        }
        try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('搜索结果解析失败')); }
      });
    });
    req.on('error', (e) => reject(new Error('网络请求失败：' + e.message)));
    req.setTimeout(timeoutMs || 60000, () => { try { req.destroy(); } catch (_) {} reject(new Error('服务侧搜索超时（60 秒）')); });
    req.write(body);
    req.end();
  });
}

/* 服务侧搜资料：返回 ok:false 表示不可用/失败（前端展示原因并提示可切端侧） */
async function serverSearchResults(query) {
  const cfg = loadConfig();
  const key = String(cfg.apiKey || '').trim();
  if (!key) return { ok: false, error: '未配置 API Key，服务侧搜索不可用。请到 ⚙ 设置 填写 Key，或改用端侧（免费）搜索。' };
  const base = searchServerBase(cfg);
  if (!base) return { ok: false, error: '服务侧搜索目前只支持 DeepSeek 官方接口；当前服务商请用端侧（免费）搜索。' };
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: false, error: '搜索词为空' };
  let body;
  try {
    body = await postJsonTimeout(base + '/messages', {
      'x-api-key': key,
      'authorization': 'Bearer ' + key,
      'anthropic-version': '2023-06-01',
      'accept': 'application/json',
    }, {
      model: cfg.model || DEFAULT_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: ' + q }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    });
  } catch (e) {
    return { ok: false, error: '服务侧搜索失败：' + e.message };
  }
  const blocks = (body && Array.isArray(body.content)) ? body.content : [];
  // 摘录不在 web_search_result 里，而在 text 块的 citations[]（url → cited_text）
  const snippets = new Map();
  for (const b of blocks) {
    if (!b || b.type !== 'text') continue;
    for (const cite of b.citations || []) {
      if (cite && cite.url && cite.cited_text && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text);
    }
  }
  const sources = [];
  const seen = new Set();
  for (const b of blocks) {
    if (!b || b.type !== 'web_search_tool_result') continue;
    for (const item of b.content || []) {
      if (!item || item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const s = { url: item.url };
      if (item.title) s.title = String(item.title).slice(0, 120);
      const snip = snippets.get(item.url);
      if (snip) s.snippet = String(snip).slice(0, 260);
      else if (item.snippet) s.snippet = String(item.snippet).slice(0, 260);
      if (item.page_age) s.publishedAt = String(item.page_age);
      s.tags = classifySearchSource(s);
      sources.push(s);
    }
  }
  if (!sources.length) {
    return { ok: false, error: '服务侧搜索没有返回结构化结果（当前模型可能不支持原生搜索）。可改用端侧（免费）搜索。' };
  }
  return { ok: true, provider: 'server', sources, answer: '' };
}

/* 把搜索结果包装成 DeepSeek Anthropic Messages 兼容响应，供内置 web_search 调用 */
function anthropicSearchResponse(query, result) {
  const sources = result.sources || [];
  const answerText = (result.answer || '').trim();
  const citations = sources.map((s) => ({
    type: 'char_location',
    cited_text: s.snippet || s.title,
    document_index: 0,
    document_title: s.title || s.url,
    start_char_index: 0,
    end_char_index: (s.snippet || '').length || 10,
  }));
  return {
    id: 'msg_' + Date.now().toString(36),
    type: 'message',
    role: 'assistant',
    model: 'academy-local-search',
    content: [
      { type: 'text', text: answerText || ('Search results for: ' + query), citations },
      {
        type: 'web_search_tool_result',
        content: sources.map((s) => ({
          type: 'web_search_result',
          url: s.url,
          title: s.title,
          page_age: '',
        })),
      },
    ],
    stop_reason: 'end_turn',
  };
}

/* 把 API 错误翻译成小白能看懂的提示 */
function friendlyApiError(status, detail) {
  const d = String(detail || '').toLowerCase();
  if (status === 401 || status === 403 || d.includes('invalid_api_key') || d.includes('authentication') || d.includes('invalid api key')) {
    return 'API Key 无效或已失效。请检查：① 是否完整复制（应以 sk- 开头，无多余空格）② 是否在平台里删除了这个 Key';
  }
  if (status === 402 || d.includes('insufficient') || d.includes('balance') || d.includes('quota') || d.includes('欠费')) {
    return '账户余额不足。请到 platform.deepseek.com 充值（按用量扣费，几块钱可用很久）';
  }
  if (status === 429 || d.includes('rate limit') || d.includes('too many')) {
    return '请求太频繁，请等几秒再试';
  }
  if (status === 404 || d.includes('model_not_found') || d.includes('does not exist')) {
    return '模型不存在。请在设置里检查模型名是否正确';
  }
  if (status === 400 && d.includes('model')) {
    return '模型名有误，请检查设置里的模型名';
  }
  if (status >= 500) {
    return '服务商服务器异常（HTTP ' + status + '），请稍后再试';
  }
  return 'HTTP ' + status + (detail ? '：' + String(detail).slice(0, 120) : '');
}

/* ---------------- 对话标题生成（轻量 LLM 调用） ---------------- */
function generateTitle(cfg, userText, assistantText) {
  return new Promise((resolve) => {
    const key = String((cfg && cfg.apiKey) || '').trim();
    if (!key) return resolve({ ok: false, error: '未配置 API Key' });
    const target = chatCompletionsUrl(cfg.baseUrl);
    const prompt = '为下面这段辩论对话起一个标题。\n'
      + '要求：中文，不超过 12 个字，概括主题，不要引号、不要标点、不要任何解释，只输出标题本身。\n\n'
      + '用户：' + String(userText || '').slice(0, 400) + '\n\n'
      + '教练：' + String(assistantText || '').slice(0, 600);
    const payload = JSON.stringify({
      model: cfg.model || DEFAULT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      stream: false,
    });
    let req;
    try {
      const u = new URL(target);
      const mod = u.protocol === 'https:' ? https : require('http');
      req = mod.request(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (d) => data += d);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
          try {
            const j = JSON.parse(data);
            const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
            let t = msg.content || '';
            // 推理模型兜底：content 为空时从 reasoning_content 里找引号包裹的短标题
            if (!t && msg.reasoning_content) {
              const rc = String(msg.reasoning_content);
              const m = rc.match(/[「『"“]([^」』"”]{2,20})[」』"”]/);
              if (m) t = m[1];
            }
            t = String(t).replace(/[\r\n]+/g, ' ').replace(/^["'「『“\s]+|["'」』”\s]+$/g, '').trim();
            if (t.length > 20) t = t.slice(0, 20);
            if (!t) return resolve({ ok: false, error: '生成结果为空' });
            resolve({ ok: true, title: t });
          } catch (e) { resolve({ ok: false, error: '解析失败' }); }
        });
      });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: '超时' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

/* ---------------- 直连 API 测 Key ---------------- */
function testDeepSeekKey(apiKey, model, baseUrl) {
  return new Promise((resolve) => {
    const target = chatCompletionsUrl(baseUrl);
    const payload = JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
      max_tokens: 8,
      stream: false,
    });
    let req;
    try {
      const u = new URL(target);
      const mod = u.protocol === 'https:' ? https : require('http');
      req = mod.request(u, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + String(apiKey || '').trim(),
        },
        timeout: 20000,
      }, (res) => {
        let data = '';
        res.on('data', (d) => data += d);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, message: '连接成功：API 地址与模型「' + (model || DEFAULT_MODEL) + '」均可用。' });
            return;
          }
          let detail = '';
          try { detail = JSON.parse(data).error?.message || ''; } catch (_) {}
          resolve({ ok: false, message: friendlyApiError(res.statusCode, detail) });
        });
      });
    } catch (e) {
      resolve({ ok: false, message: 'API 地址无效：' + e.message });
      return;
    }
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', (e) => {
      const m = String(e.message || '');
      if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return resolve({ ok: false, message: '无法连接服务器：请检查网络（或公司/校园网是否需要代理）' });
      if (/ECONNREFUSED|ECONNRESET/i.test(m)) return resolve({ ok: false, message: '连接被拒绝：地址可能不正确，或网络被限制' });
      if (/timeout/i.test(m)) return resolve({ ok: false, message: '连接超时：请检查网络后重试' });
      resolve({ ok: false, message: '网络错误：' + m });
    });
    req.write(payload);
    req.end();
  });
}

/* 获取某服务商的模型列表（支持传入"尚未保存"的 Key / 地址） */
function fetchModels({ apiKey, baseUrl } = {}) {
  return new Promise((resolve) => {
    const key = String(apiKey || '').trim();
    if (!key) return resolve({ ok: false, error: '请先填写 / 配置 API Key 再获取模型列表。' });
    // 拼 /models 时必须保留 base 里的路径段（如 /v1、/api/paas/v4）。
    // 不能用 new URL('/models', base)：前导斜杠会把 base 的路径整个丢掉，
    // 变成 api.moonshot.cn/models（正确是 /v1/models）——除 DeepSeek 外全会 404。
    const baseNorm = String(normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const u = new URL(baseNorm + '/models');
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.get(u, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      timeout: 15000,
    }, (r2) => {
      let body = '';
      r2.on('data', (d) => { body += d; });
      r2.on('end', () => {
        if (r2.statusCode && r2.statusCode >= 400) {
          let detail = '';
          try { const j = JSON.parse(body); detail = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (_) {}
          return resolve({ ok: false, error: 'HTTP ' + r2.statusCode + (detail ? '：' + detail : '（可能是 API Key 无效或地址不对）') });
        }
        try {
          const j = JSON.parse(body);
          const models = (j.data || []).map((m) => ({ id: m.id, ownedBy: m.owned_by || '' }));
          resolve({ ok: true, models });
        } catch (_) { resolve({ ok: false, error: '模型列表解析失败（服务商可能不支持此接口），请手动输入模型名。' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', (er) => resolve({ ok: false, error: '获取模型失败：' + er.message }));
  });
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/* index.html 里的版本号占位符（__APP_VERSION__）在发送前替换成 APP_VERSION。
   这样「关于应用」页的硬编码版本号只存在于模板里，发版时改 server.js 一处即可，
   不会再出现改了 APP_VERSION 但页面上还写着旧号的情况。 */
function injectVersion(buf, filePath) {
  if (path.basename(filePath).toLowerCase() !== 'index.html') return buf;
  if (buf.indexOf('__APP_VERSION__') === -1) return buf;
  return Buffer.from(
    buf.toString('utf8').replace(/__APP_VERSION__/g, 'v' + APP_VERSION),
    'utf8'
  );
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel.replace(/\//g, path.sep));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { ok: false, error: 'not found' });
    const ext = path.extname(filePath).toLowerCase();
    const body = injectVersion(data, filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    res.end(body);
  });
}

/* ---------------- HTTP 服务 ---------------- */
let actualPort = DEFAULT_PORT;

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // 本机来源校验（见 localOriginOk）：所有请求先过这道门
  if (!localOriginOk(req)) {
    return sendJson(res, 403, { ok: false, error: '已拒绝非本机来源的请求' });
  }

  // 预检：正常流程不会走到（同源请求无预检）；保留 204 但不放行跨源读取
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method === 'GET' && (p === '/api/status' || p === '/api/health')) {
    return sendJson(res, 200, statusPayload());
  }

  if (req.method === 'GET' && p === '/api/ping') {
    return sendJson(res, 200, { ok: true, pong: Date.now() });
  }

  // 搜资料（手动面板）：mode=free 端侧（默认）｜mode=server 服务侧（模型商原生搜索）
  if (req.method === 'GET' && p === '/api/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 400, { ok: false, error: '缺少 q 参数' });
    const mode = String(url.searchParams.get('mode') || '').toLowerCase() === 'server' ? 'server' : 'free';
    const run = (mode === 'server')
      ? serverSearchResults(q)
      : searchResults(q).then((r) => ({ ok: true, provider: r.provider, sources: r.sources || [], answer: r.answer || '' }));
    return run.then((r) => {
      if (r.ok === false) return sendJson(res, 400, { ok: false, error: r.error });
      const sources = r.sources || [];
      // 端侧搜索可能因反爬/降级页面返回无关结果：识别为 lowQuality 并如实上报，
      // 让前端明确提示用户改用深度检索，而不是把垃圾结果当正常结果显示。
      const lowQuality = sources.length > 0 && sources.every((s) => s && s.lowQuality);
      return sendJson(res, 200, {
        ok: true, query: q, mode,
        provider: r.provider || mode,
        sources,
        answer: r.answer || '',
        lowQuality,
        notice: lowQuality
          ? '基础检索（免费）在当前网络下没有拿到相关结果，通常是搜索源被限制。建议切到「深度检索」，或改用本地知识库。'
          : '',
      });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* —— 自定义搜索服务：预设 / 读取 / 保存 / 测试 —— */
  if (req.method === 'GET' && p === '/api/search/custom') {
    const cfg = loadConfig();
    const cs = cfg.customSearch || defaultCustomSearch();
    // Key 不回传明文，只回传是否已设置
    return sendJson(res, 200, {
      ok: true,
      presets: SEARCH_PRESETS,
      config: Object.assign({}, cs, { apiKey: '', hasKey: !!String(cs.apiKey || '').trim() }),
    });
  }

  if (req.method === 'POST' && p === '/api/search/custom') {
    return readBody(req, 128 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const cur = loadConfig().customSearch || defaultCustomSearch();
      const next = Object.assign({}, cur);
      const strFields = ['name', 'urlTemplate', 'method', 'headers', 'bodyTemplate', 'resultsPath', 'titlePath', 'urlPath', 'snippetPath'];
      for (const f of strFields) {
        if (body[f] !== undefined) next[f] = String(body[f] || '').slice(0, 4000);
      }
      if (body.enabled !== undefined) next.enabled = body.enabled === true;
      // Key：留空表示保持原值（与 API Key 的处理一致），传 null 表示清空
      if (body.apiKey === null) next.apiKey = '';
      else if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
      saveConfig({ customSearch: next });
      return sendJson(res, 200, { ok: true, config: Object.assign({}, next, { apiKey: '', hasKey: !!next.apiKey }) });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* 测试自定义搜索：用固定测试词跑一次，返回样例结果或具体报错 */
  if (req.method === 'POST' && p === '/api/search/custom/test') {
    return readBody(req, 128 * 1024).then(async (raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const saved = loadConfig().customSearch || defaultCustomSearch();
      // 允许用界面上未保存的内容测试
      const cs = Object.assign({}, saved, body.config || {}, { enabled: true });
      if (!String(cs.apiKey || '').trim() && String(saved.apiKey || '').trim() && !(body.config && body.config.apiKey)) {
        cs.apiKey = saved.apiKey;
      }
      const q = String(body.query || '辩论').trim() || '辩论';
      const t0 = Date.now();
      const r2 = await customSearchResults(q, cs);
      if (!r2.ok) return sendJson(res, 200, { ok: false, error: r2.error, elapsedMs: Date.now() - t0 });
      return sendJson(res, 200, {
        ok: true, query: q, elapsedMs: Date.now() - t0,
        count: r2.sources.length,
        samples: r2.sources.slice(0, 3),
      });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  // 研究台：按 7 种主动搜索触发条件，为当前辩题生成建议搜索词。
  // 用 DSH 内核跑一次极小任务（复用现有 runDsh 管线），返回结构化建议。
  if (req.method === 'POST' && p === '/api/research/suggest') {
    if (currentRun) return sendJson(res, 409, { ok: false, error: 'BUSY', message: '有一个任务正在运行，请稍后再试。' });
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const topic = String(body.topic || '').trim();
      if (!topic) return sendJson(res, 400, { ok: false, error: '缺少辩题/关键词' });
      if (!engineReady()) return sendJson(res, 500, { ok: false, error: 'NO_ENGINE', message: 'Agent 内核缺失，无法生成建议。' });
      const cfg = loadConfig();
      const runId = 'sug-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      const prompt = [
        '你是辩论资料研究助手。用户给出的辩题或关键词：',
        '',
        '【' + topic + '】',
        '',
        '请按以下 7 种触发条件逐一判断：哪些条件命中、该搜什么。',
        '① 专业学术概念 ② 政策法规 ③ 新闻事件/社会现象 ④ 国际比较',
        '⑤ 对方论据引用的研究/数据 ⑥ 历史背景 ⑦ 陌生术语/人名',
        '',
        '只输出 JSON（不要输出任何其他文字），格式：',
        '{"hits":[{"trigger":"触发条件名","query":"可直接复制的搜索词","reason":"一句话说明为什么搜这个"}]}',
        '',
        '规则：只列命中的条件（通常 2~5 个，不足 2 个时列出最值得查的 2 个）；',
        'query 必须是可直接粘贴到搜索引擎的具体搜索词（含引号或限定词更好）；不要编造。',
      ].join('\n');
      ensureDir(TASK_DIR);
      const taskFile = path.join(TASK_DIR, runId + '.md');
      fs.writeFileSync(taskFile, prompt, 'utf8');
      writeDshSettings(cfg.model, cfg.baseUrl, effectiveSearchKey(cfg), resolveSearchProvider(cfg));
      return runDsh(runId, prompt, cfg, () => {}).then((info) => {
        const out = String(info.stdout || '').trim();
        // 从回复里抠 JSON（模型可能裹在代码块里）
        const m = out.match(/\{[\s\S]*\}/);
        if (!m) return sendJson(res, 200, { ok: true, topic, hits: [], raw: out.slice(0, 400) });
        try {
          const j = JSON.parse(m[0]);
          const hits = Array.isArray(j.hits) ? j.hits.filter((h) => h && h.query) : [];
          return sendJson(res, 200, { ok: true, topic, hits });
        } catch (_) { return sendJson(res, 200, { ok: true, topic, hits: [], raw: out.slice(0, 400) }); }
      }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  // 研究台：证据检证。把用户给出的论据（数据/案例/研究/引言）逐条核查——
  // 是否真实存在、是否被曲解/断章取义、口径与时效、以及引用时的注意事项。
  // 内核自带 web_search 代理（/internal/web-search/*），可边推理边联网检索。
  if (req.method === 'POST' && p === '/api/research/verify') {
    if (currentRun) return sendJson(res, 409, { ok: false, error: 'BUSY', message: '有一个任务正在运行，请等待完成后再试。' });
    return readBody(req, 256 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const claim = String(body.claim || '').trim();
      if (!claim) return sendJson(res, 400, { ok: false, error: '缺少要核查的论据' });
      if (claim.length > 20000) return sendJson(res, 400, { ok: false, error: '论据过长（超过 20000 字符），请拆分后逐条核查。' });
      const context = String(body.context || '').trim().slice(0, 2000);
      if (!engineReady()) return sendJson(res, 500, { ok: false, error: 'NO_ENGINE', message: 'Agent 内核缺失，无法进行证据检证。' });
      const cfg = loadConfig();
      const runId = 'ver-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      const prompt = [
        '你是辩论资料研究助手，正在做【证据检证】。用户会给出一条（或一组）准备在赛场上使用的论据，',
        '你要逐条核查它是否真实存在、有没有被编造、有没有被曲解或断章取义。',
        '',
        '## 待核查论据',
        '',
        claim,
        '',
        context ? ('## 使用语境（供参考，不必核查这部分）\n\n' + context) : '',
        '',
        '## 检证流程（逐条执行，必须真联网搜索）',
        '',
        '1. **找原始出处**：用 web_search 搜这条论据的原始来源（官方发布/一手研究/权威媒体报道），',
        '   优先找政府网站、学术期刊、机构报告的原文；只看转述不追原文是不合格。',
        '2. **核对数字与口径**：把用户给的数字/年份/样本量/比例和原始出处逐一比对，',
        '   任何不一致都要指出来（谁对、差多少、可能的原因）。',
        '3. **检查曲解与断章取义**：原始研究/原文的结论是不是用户说的这个意思？',
        '   特别注意：相关性≠因果性、单次调查≠普遍规律、样本差异、时效过期。',
        '4. **交叉验证**：至少找两个独立来源相互印证；只有单一来源且查不到原文的，标注为「无法交叉验证」。',
        '5. **给使用建议**：这条论据能不能用、怎么用才严谨、对方会怎么攻击它。',
        '',
        '## 输出格式（严格遵守）',
        '',
        '对每一条论据输出：',
        '',
        '### 第 N 条：<论据摘要>',
        '**判定**：✅ 真实可用 / ⚠️ 部分属实（有偏差）/ ❌ 查无实据或明显错误 / 🔍 无法核实',
        '**原始出处**：<找到的最权威来源，附链接；找不到就写「未检索到原始出处」>',
        '**比对结果**：<数字/口径/结论与原始出处的差异，逐项列>',
        '**风险点**：<对方会怎么攻击这条论据，如「样本只覆盖大学生」>',
        '**使用建议**：<能不能用、严谨的表述应该怎么说（给一句可以直接上场念的话）>',
        '',
        '## 铁律',
        '',
        '- 必须真联网搜索核实，禁止凭记忆判断「这条我记得是真的」；',
        '- 查不到就明说「未检索到」，绝对不能为了显得专业而编造出处；',
        '- 检测到论据数字与原始出处不一致时，以原始出处为准，并明确指出用户原表述错在哪；',
        '- 结论宁可保守：证据存疑就降级为「无法核实」，不要硬给可用/不可用。',
      ].filter(Boolean).join('\n');
      ensureDir(TASK_DIR);
      const taskFile = path.join(TASK_DIR, runId + '.md');
      fs.writeFileSync(taskFile, prompt, 'utf8');
      writeDshSettings(cfg.model, cfg.baseUrl, effectiveSearchKey(cfg), resolveSearchProvider(cfg));
      return runDsh(runId, prompt, cfg, () => {}).then((info) => {
        const out = String(info.stdout || '').trim();
        if (!out) return sendJson(res, 500, { ok: false, error: '内核没有返回内容，请重试。' });
        return sendJson(res, 200, { ok: true, claim, report: out, elapsedMs: info.timedOut ? -1 : 0 });
      }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  // 研究台：快速检证（赛场上用，几十秒出结果）。
  // 与深度检证的区别：绕过内核 Agent 循环（省掉 DSH 启动 + 多轮工具调用）。
  //
  // 搜索通道自适应（两条都快，按可用性自动选）：
  //   ① 模型商原生 web_search（DeepSeek 官方支持）——召回质量高，能挖到论文 DOI/PubMed；
  //   ② 端侧免费搜索（Bing/DuckDuckGo）——任何服务商通用，但学术原文召回弱
  //      （实测即使精准查询也拿不到 PubMed，只有官网/百科页）。
  // 所以策略是「能用原生就用原生，不能用自动降级端侧」，而不是二选一；
  // 两条通道拿到的来源最后都交给模型做一次判定（标准 OpenAI 兼容 /chat/completions）。
  // 注意：各家搜索协议互不统一（智谱走 Anthropic 兼容、Kimi 走内置工具、
  // OpenAI 走 Responses API…），逐个适配不划算，故只接 DeepSeek 原生 + 端侧兜底。
  if (req.method === 'POST' && p === '/api/research/verify-quick') {
    if (currentRun) return sendJson(res, 409, { ok: false, error: 'BUSY', message: '内核任务正在运行（不影响快速检证），但为避免抢资源请稍后再试。' });
    return readBody(req, 128 * 1024).then(async (raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const claim = String(body.claim || '').trim();
      if (!claim) return sendJson(res, 400, { ok: false, error: '缺少要核查的论据' });
      if (claim.length > 4000) return sendJson(res, 400, { ok: false, error: '快速检证单次只处理一条论据（限 4000 字符）。多条请逐条来，或用完整检证。' });

      const cfg = loadConfig();
      const key = String(cfg.apiKey || '').trim();
      if (!key) return sendJson(res, 400, { ok: false, error: '未配置 API Key，无法调用模型做判定。' });

      const t0 = Date.now();
      try {
        const seeds = buildVerifySeeds(claim);
        const seenUrl = new Set();
        const sources = [];
        let via = 'free';

        // ① 优先：模型商原生 web_search（DeepSeek 官方，质量高）
        const nativeBase = searchServerBase(cfg);
        if (nativeBase) {
          try {
            const r2 = await postJsonTimeout(nativeBase + '/messages', {
              'x-api-key': key,
              'authorization': 'Bearer ' + key,
              'anthropic-version': '2023-06-01',
              'accept': 'application/json',
            }, {
              model: cfg.model || DEFAULT_MODEL,
              max_tokens: 4096,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: ' + String(claim).slice(0, 200) }] }],
              tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
            }, 60000);
            const blocks = (r2 && Array.isArray(r2.content)) ? r2.content : [];
            for (const b of blocks) {
              if (!b || b.type !== 'web_search_tool_result') continue;
              for (const item of (b.content || [])) {
                if (!item || item.type !== 'web_search_result' || !item.url || seenUrl.has(item.url)) continue;
                seenUrl.add(item.url);
                sources.push({ url: item.url, title: String(item.title || '').slice(0, 120), snippet: '' });
                if (sources.length >= 12) break;
              }
              if (sources.length >= 12) break;
            }
            if (sources.length) via = 'native';
          } catch (_) { /* 原生搜索不可用 → 静默走端侧 */ }
        }

        // ② 回退/补充：端侧免费搜索（任何服务商通用）
        if (sources.length < 5) {
          const before = sources.length;
          for (const q of seeds) {
            try {
              const r3 = await searchResults(q);
              const list = (r3 && r3.sources) || [];
              for (const s of list) {
                if (!s || !s.url || seenUrl.has(s.url)) continue;
                seenUrl.add(s.url);
                sources.push({ url: s.url, title: String(s.title || '').slice(0, 120), snippet: String(s.snippet || '').slice(0, 300) });
                if (sources.length >= 12) break;
              }
            } catch (_) {}
            if (sources.length >= 12) break;
          }
          if (sources.length > before && via === 'native') via = 'native+free';
          else if (sources.length > before) via = 'free';
        }

        // ② 把来源交给模型做单次判定（标准 OpenAI 兼容接口，任何服务商都能用）
        const srcText = sources.length
          ? sources.map((s, i) => '[' + (i + 1) + '] ' + (s.title || s.url) + '\n    ' + s.url + (s.snippet ? '\n    摘要：' + s.snippet : '')).join('\n')
          : '（本次没有检索到任何来源，请据此判定为「无法核实」，不要臆造出处）';

        const prompt = [
          '你是辩论赛场边的证据核查员。下面是待核查的论据，以及系统检索到的来源材料。',
          '请只依据这些材料（以及可靠的常识）判断，并输出报告。',
          '',
          '【待核查论据】',
          claim,
          '',
          '【检索到的来源】',
          srcText,
          '',
          '【输出格式】',
          '**判定**：真实可用 / 部分属实（有偏差）/ 查无实据或错误 / 无法核实（选一个）',
          '**出处**：<最权威来源+链接；材料不足就写「未检索到原始出处」>',
          '**关键差异**：<数字/年份/口径与来源材料的差异；没有则写「与来源一致」>',
          '**一句话结论**：<能不能用，怎么用才严谨，30 字内>',
          '',
          '【铁律】',
          '- 来源材料不足以确认时，判定为「无法核实」，绝不编造出处或数据；',
          '- 数字冲突以更权威/更一手来源为准，并指出差异；',
          '- 结论宁可保守。',
        ].join('\n');

        const target = chatCompletionsUrl(cfg.baseUrl);
        const result = await postJsonTimeout(target, {
          'authorization': 'Bearer ' + key,
          'accept': 'application/json',
        }, {
          model: cfg.model || DEFAULT_MODEL,
          max_tokens: 6000,   // 推理型模型的思考过程也计入，给足预算避免正文被截断
          temperature: 0.2,
          messages: [
            { role: 'system', content: '你是严谨的辩论证据核查员，只依据给定材料判断，绝不编造。直接输出报告，不要复述思考过程。' },
            { role: 'user', content: prompt },
          ],
        }, 90000);

        const msg0 = (((result || {}).choices || [])[0] || {}).message || {};
        // 推理型模型（如 deepseek-flash 默认推理模式）常把正文写进 reasoning_content，
        // content 为空——token 预算被思考过程吃掉。故 content 为空时回退取 reasoning_content。
        let report = String(msg0.content || '').trim();
        if (!report) report = String(msg0.reasoning_content || '').trim();
        if (!report) {
          console.log('[research] 快速检证: 模型响应为空 raw=' + JSON.stringify(result).slice(0, 300));
          return sendJson(res, 500, { ok: false, error: '模型没有返回检证报告（响应为空），请重试。' });
        }
        console.log('[research] 快速检证完成: ' + claim.slice(0, 40) + ' 用时 ' + Math.round((Date.now() - t0) / 1000) + 's, 来源 ' + sources.length + ' 条, 通道 ' + via);
        return sendJson(res, 200, {
          ok: true, claim, report,
          sources: sources.map((s) => ({ url: s.url, title: s.title })),
          elapsedMs: Date.now() - t0,
          quick: true,
          via,
          disclaimer: via === 'free'
            ? '快速检证只做一轮端侧检索（当前服务商无原生搜索，已自动降级为免费端侧搜索，学术原文召回较弱），结论供赛场快速参考；重要论据建议赛后用「完整检证」复核。'
            : '快速检证只做一轮检索，结论供赛场快速参考；重要论据建议赛后用「完整检证」复核。',
        });
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: '快速检证失败：' + e.message });
      }
    });
  }

  // 供 DSH 内置 web_search 调用的本地搜索代理（Anthropic Messages 兼容）
  if (req.method === 'POST' && p === '/internal/web-search/messages') {
    return readBody(req, 256 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const userText = (body.messages || []).map((m) => m.content || '').flat().map((b) => b.text || '').join(' ');
      const match = userText.match(/query:\s*(.+)$/i);
      const query = (match ? match[1] : userText).trim().slice(0, 200) || '辩论';
      return searchResults(query).then((result) => sendJson(res, 200, anthropicSearchResponse(query, result)))
        .catch(() => sendJson(res, 200, anthropicSearchResponse(query, {
          sources: [{ url: 'https://www.bing.com/search?q=' + encodeURIComponent(query), title: '搜索服务暂不可用', snippet: '本地搜索源暂时不可用，请基于知识库回答。' }],
          answer: '',
        })));
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* —— 对话历史（文件存储） —— */
  // 列表（元数据，走 SQLite 索引；不解析全部对话正文）
  if (req.method === 'GET' && p === '/api/chats/list') {
    let list = chatIndexList();
    if (!list) {
      try { list = readAllChats().map((c) => ({ id: c.id, mode: c.mode || 'free', title: c.title || '', created: c.created || 0, updated: c.updated || 0, msgCount: (c.messages || []).length })); } catch (_) { list = []; }
    }
    return sendJson(res, 200, { ok: true, chats: list, count: list.length });
  }
  // 单条读取（配合列表懒加载正文）
  if (req.method === 'GET' && p.startsWith('/api/chats/') && p.split('/')[3] && !p.endsWith('/import')) {
    const id = safeChatId(decodeURIComponent(p.split('/')[3]));
    const fp = path.join(CHATS_DIR, id + '.json');
    try {
      const c = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!c || typeof c !== 'object' || !c.id) throw new Error('bad chat');
      return sendJson(res, 200, { ok: true, chat: c });
    } catch (_) {
      return sendJson(res, 404, { ok: false, error: '对话不存在' });
    }
  }
  if (req.method === 'GET' && p === '/api/chats') {
    const chats = readAllChats();
    return sendJson(res, 200, { ok: true, chats, count: chats.length });
  }
  if (req.method === 'PUT' && p === '/api/chats') {
    return readBody(req, CHATS_BODY_LIMIT).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const chats = Array.isArray(body.chats) ? body.chats : [];
      const n = writeAllChats(chats);
      return sendJson(res, 200, { ok: true, count: n });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }
  // 单条保存（前端每条消息后只落盘变了的那个对话，不再整库重写）
  if (req.method === 'PUT' && p === '/api/chats/upsert') {
    return readBody(req, CHATS_BODY_LIMIT).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const c = body.chat;
      if (!c || typeof c !== 'object' || !c.id) return sendJson(res, 400, { ok: false, error: '缺少对话数据' });
      if (!Array.isArray(c.messages)) c.messages = [];
      const id = safeChatId(c.id);
      if (id.startsWith('_')) return sendJson(res, 400, { ok: false, error: '对话 id 不能以 _ 开头（内部保留前缀）' });
      const rec = Object.assign({}, c, { id });
      try {
        writeJsonAtomic(path.join(CHATS_DIR, id + '.json'), rec);
      } catch (e) { return sendJson(res, 500, { ok: false, error: '写入失败：' + e.message }); }
      chatIndexUpsert(rec);
      return sendJson(res, 200, { ok: true, id });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }
  // 单条删除（配合列表删除按钮，不再整库重写）
  if (req.method === 'DELETE' && p.startsWith('/api/chats/') && p.split('/')[3] && !p.endsWith('/import')) {
    const id = safeChatId(decodeURIComponent(p.split('/')[3]));
    try { fs.unlinkSync(path.join(CHATS_DIR, id + '.json')); } catch (_) {}
    chatIndexDelete(id);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/chats/import') {
    return readBody(req, CHATS_BODY_LIMIT).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const incoming = Array.isArray(body.chats) ? body.chats : [];
      const existing = readAllChats();
      const byId = new Map();
      for (const c of existing) if (c && c.id) byId.set(c.id, c);
      for (const c of incoming) if (c && c.id && !byId.has(c.id)) byId.set(c.id, c);
      const n = writeAllChats(Array.from(byId.values()));
      return sendJson(res, 200, { ok: true, count: n, imported: incoming.length });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }
  /* —— 个人数据备份：一键导出 / 导入（换电脑用） —— */
  if (req.method === 'GET' && p === '/api/backup/export') {
    try {
      const cfg = loadConfig();
      const { activeId, profiles } = loadProfiles();
      const memory = { long: '', daily: {} };
      try { memory.long = fs.readFileSync(MEMORY_FILE, 'utf8'); } catch (_) {}
      try {
        ensureDir(MEMORY_DIR);
        for (const e of fs.readdirSync(MEMORY_DIR, { withFileTypes: true })) {
          if (e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) {
            try { memory.daily[e.name.replace('.md', '')] = fs.readFileSync(path.join(MEMORY_DIR, e.name), 'utf8'); } catch (_) {}
          }
        }
      } catch (_) {}
      // 个人资料库：带纯文本与索引（原件 files/ 体积大，不带；换电脑时整文件夹拷贝即可）
      const library = { items: [], texts: {} };
      try {
        const idx = libLoadIndex();
        for (const it of idx.items) {
          let text = '';
          try { text = fs.readFileSync(path.join(ROOT, it.textFile), 'utf8'); } catch (_) { text = ''; }
          if (!text) continue;
          library.items.push(it);
          library.texts[it.id] = text;
        }
      } catch (_) {}
      const payload = {
        app: 'Academy Debate Coach',
        version: 2,
        exportedAt: new Date().toISOString(),
        chats: readAllChats(),
        memory,
        config: cfg,
        profiles: { activeId, profiles },
        library,
      };
      return sendJson(res, 200, { ok: true, backup: payload, stats: {
        chats: payload.chats.length,
        memoryDaily: Object.keys(memory.daily).length,
        profiles: (profiles || []).length,
        library: library.items.length,
        libraryChars: Object.values(library.texts).reduce((n, t) => n + t.length, 0),
      } });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && p === '/api/backup/import') {
    return readBody(req, CHATS_BODY_LIMIT).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: '备份文件格式错误（不是合法 JSON）' }); }
      const b = body && body.backup ? body.backup : body;
      if (!b || typeof b !== 'object' || (!b.chats && !b.memory && !b.config)) {
        return sendJson(res, 400, { ok: false, error: '这不是有效的 Academy 备份文件' });
      }
      // 1) 先自动备份现有数据（防误操作）
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupDir = path.join(DATA_DIR, '_backup_' + stamp);
      try {
        ensureDir(backupDir);
        for (const fl of ['config.json', 'profiles.json', 'memory.md']) {
          const src = path.join(DATA_DIR, fl);
          if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(backupDir, fl)); } catch (_) {} }
        }
        copyDirSafe(CHATS_DIR, path.join(backupDir, 'chats'));
        copyDirSafe(MEMORY_DIR, path.join(backupDir, 'memory'));
        copyDirSafe(LIB_DIR, path.join(backupDir, 'library'));
      } catch (_) {}
      // 2) 写入导入数据
      const result = { chats: 0, memoryDaily: 0, profiles: 0, library: 0 };
      try {
        if (Array.isArray(b.chats)) result.chats = writeAllChats(b.chats);
      } catch (_) {}
      try {
        if (b.memory && typeof b.memory === 'object') {
          if (typeof b.memory.long === 'string') { ensureDir(DATA_DIR); fs.writeFileSync(MEMORY_FILE, b.memory.long, 'utf8'); }
          if (b.memory.daily && typeof b.memory.daily === 'object') {
            ensureDir(MEMORY_DIR);
            for (const [date, text] of Object.entries(b.memory.daily)) {
              if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof text === 'string') {
                fs.writeFileSync(path.join(MEMORY_DIR, date + '.md'), text, 'utf8');
                result.memoryDaily++;
              }
            }
          }
        }
      } catch (_) {}
      try {
        // 资料库：合并式导入（按 id 去重，已有同名不覆盖，避免误删本机已有资料）
        if (b.library && b.library.items && b.library.texts) {
          libEnsure();
          const idx = libLoadIndex();
          const have = new Set(idx.items.map((x) => x.id));
          const haveName = new Set(idx.items.map((x) => x.name));
          for (const it of b.library.items) {
            if (!it || !it.id || have.has(it.id)) continue;
            const text = b.library.texts[it.id];
            if (typeof text !== 'string' || !text.trim()) continue;
            let name = it.name || ('资料-' + it.id);
            if (haveName.has(name)) name = name + '（导入）';
            haveName.add(name);
            const item = Object.assign({}, it, {
              name,
              file: '',            // 原件不在备份里
              hasFile: undefined,
              textFile: libRel(path.join('data', 'library', 'text', it.id + '.txt')),
            });
            delete item.hasFile;
            fs.writeFileSync(path.join(LIB_TEXT_DIR, it.id + '.txt'), text, 'utf8');
            idx.items.push(item);
            have.add(it.id);
            result.library++;
          }
          if (result.library) libSaveIndex(idx);
        }
      } catch (_) {}
      try {
        if (b.profiles && Array.isArray(b.profiles.profiles)) {
          saveProfiles({ activeId: b.profiles.activeId || null, profiles: b.profiles.profiles });
          result.profiles = b.profiles.profiles.length;
          const active = b.profiles.profiles.find((x) => x.id === b.profiles.activeId) || b.profiles.profiles[0];
          if (active) activateProfile(active);
        } else if (b.config && typeof b.config === 'object') {
          saveConfig(b.config);
        }
      } catch (_) {}
      return sendJson(res, 200, { ok: true, result, backupDir: path.basename(backupDir) });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'DELETE' && p === '/api/chats') {
    try {
      ensureDir(CHATS_DIR);
      for (const name of fs.readdirSync(CHATS_DIR)) {
        if (name.endsWith('.json') && !name.startsWith('_')) {
          try { fs.unlinkSync(path.join(CHATS_DIR, name)); } catch (_) {}
        }
      }
    } catch (_) {}
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/memory') {
    // 多级记忆：长期 + 每日流水（QClaw 风格结构化返回）
    let longText = '', longSize = 0;
    try {
      const b = fs.readFileSync(MEMORY_FILE);
      longText = b.toString('utf8'); longSize = b.length;
    } catch (_) {}
    const daily = [];
    try {
      ensureDir(MEMORY_DIR);
      const ents = fs.readdirSync(MEMORY_DIR, { withFileTypes: true });
      const files = ents.filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name));
      for (const e of files) {
        const fp = path.join(MEMORY_DIR, e.name);
        try {
          const c = fs.readFileSync(fp, 'utf8');
          daily.push({ date: e.name.replace('.md', ''), size: c.length, text: c });
        } catch (_) {}
      }
    } catch (_) {}
    const longEntries = parseMemoryEntries(longText);
    const dailyEntries = [];
    for (const d of daily) {
      const entries = parseMemoryEntries(d.text);
      dailyEntries.push({ date: d.date, size: d.size, count: entries.length, entries });
    }
    return sendJson(res, 200, {
      ok: true,
      indexReady: (() => { try { return openMemoryIndex(); } catch (_) { return false; } })(),
      long: { text: longText, size: longSize, count: longEntries.length, entries: longEntries },
      daily: dailyEntries.slice(0, 14), // 最近 14 天流水
      stats: {
        longCount: longEntries.length,
        dailyCount: dailyEntries.reduce((t, d) => t + d.count, 0),
        dailyFiles: dailyEntries.length,
        totalBytes: longSize + dailyEntries.reduce((t, d) => t + d.size, 0),
      },
    });
  }

  /* —— 记忆编辑（用户手动增 / 改 / 删单条记忆） —— */
  if (req.method === 'POST' && p === '/api/memory/save') {
    return readBody(req, 256 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const scope = body.scope === 'daily' ? 'daily' : 'long';
      const fp = memoryTargetPath(scope, body.date);
      if (!fp) return sendJson(res, 400, { ok: false, error: '无法定位记忆文件' });
      const title = String(body.title || '').trim();
      const text = String(body.body || '').trim();
      if (!title && !text) return sendJson(res, 400, { ok: false, error: '标题和内容不能都为空' });

      let segs;
      try { segs = memorySegments(fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : ''); } catch (_) { segs = []; }

      const seg = memoryMakeSegment(title, text, { daily: scope === 'daily' });
      // 区分「新增」和「改」：body.idx 没传 = 新增；传了但越界 = 条目已被别处改动，
      // 必须报错而不是静默当新增，否则用户会莫名其妙多出一条。
      const wantsUpdate = body.idx !== undefined && body.idx !== null && body.idx !== '';
      if (wantsUpdate) {
        const idx = Number(body.idx);
        if (!Number.isInteger(idx) || idx < 0 || idx >= segs.length) {
          return sendJson(res, 409, { ok: false, error: '这条记忆已发生变化（可能被 Agent 或别处修改过），请关闭重开后重试。' });
        }
        segs[idx] = seg;                        // 改
      } else {
        segs.push(seg);                         // 增（追加到末尾）
      }
      try {
        const size = memoryWriteSegments(fp, segs);
        return sendJson(res, 200, { ok: true, scope, file: path.basename(fp), size, mode: wantsUpdate ? 'update' : 'create' });
      } catch (e) { return sendJson(res, 500, { ok: false, error: '写入失败：' + e.message }); }
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/memory/delete') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const scope = body.scope === 'daily' ? 'daily' : 'long';
      const fp = memoryTargetPath(scope, body.date);
      if (!fp || !fs.existsSync(fp)) return sendJson(res, 404, { ok: false, error: '记忆文件不存在' });
      let segs;
      try { segs = memorySegments(fs.readFileSync(fp, 'utf8')); } catch (_) { return sendJson(res, 500, { ok: false, error: '读取失败' }); }
      const idx = Number(body.idx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= segs.length) {
        return sendJson(res, 404, { ok: false, error: '该条目不存在（可能已被修改，请刷新）' });
      }
      segs.splice(idx, 1);
      try {
        memoryWriteSegments(fp, segs);
        return sendJson(res, 200, { ok: true, removed: idx, left: segs.length });
      } catch (e) { return sendJson(res, 500, { ok: false, error: '写入失败：' + e.message }); }
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* —— 记忆全文搜索（记忆中心的搜索框；长期 + 流水一并检索） —— */
  if (req.method === 'GET' && p === '/api/memory/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 400, { ok: false, error: '缺少 q 参数' });
    let indexReady = false;
    try { indexReady = openMemoryIndex(); } catch (_) {}
    const results = memorySearch(q, 20);
    return sendJson(res, 200, { ok: true, query: q, indexReady, results });
  }

  if (req.method === 'POST' && p === '/api/memory/clear') {
    try { autoBackupData('before-clear'); } catch (_) {}
    try { if (fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '', 'utf8'); } catch (_) {}
    // 清空 = 全部：每日流水一并删除（按钮文案即「清空全部记忆」）
    try {
      ensureDir(MEMORY_DIR);
      for (const e of fs.readdirSync(MEMORY_DIR, { withFileTypes: true })) {
        if (e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) { try { fs.unlinkSync(path.join(MEMORY_DIR, e.name)); } catch (_) {} }
      }
    } catch (_) {}
    try { rebuildMemoryIndex(); } catch (_) {}
    return sendJson(res, 200, { ok: true });
  }

  /* —— 多配置模型档案 —— */
  if (req.method === 'GET' && p === '/api/profiles') {
    const { activeId, profiles } = loadProfiles();
    return sendJson(res, 200, {
      ok: true,
      activeId,
      profiles: profiles.map(profilePublic),
      current: profilePublic(profiles.find((x) => x.id === activeId) || (profiles[0] || {})),
    });
  }

  if (req.method === 'POST' && p === '/api/profiles') {
    return readBody(req, 128 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const { activeId, profiles } = loadProfiles();
      const name = String(body.name || '').trim() || ('配置 ' + (profiles.length + 1));
      const baseUrl = normalizeBaseUrl(String(body.baseUrl || DEFAULT_BASE_URL));
      const model = String(body.model || 'deepseek-chat').trim();
      const apiKey = String(body.apiKey || '').trim();
      if (!apiKey) return sendJson(res, 400, { ok: false, error: '请填写 API Key' });
      const id = newProfileId();
      const newProfile = { id, name, baseUrl, model, apiKey, provider: body.provider || '', created: Date.now() };
      profiles.push(newProfile);
      const next = { activeId: activeId || id, profiles };
      saveProfiles(next);
      // 新建即激活：让用户马上能用
      const act = activateProfile(newProfile);
      return sendJson(res, 200, { ok: true, id, profile: profilePublic(newProfile), activeId: id, activated: true, cfg: act ? act.cfg : undefined });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'PUT' && p.startsWith('/api/profiles/') && p.split('/')[3] && !p.endsWith('/activate')) {
    return readBody(req, 128 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const pid = decodeURIComponent((p.split('/')[3] || '').replace(/^:/, ''));
      const { activeId, profiles } = loadProfiles();
      const idx = profiles.findIndex((x) => x.id === pid);
      if (idx < 0) return sendJson(res, 404, { ok: false, error: '配置不存在' });
      const cur = profiles[idx];
      // 逐字段更新：只改传了的字段，没传的保持原值（改模型时不该把 Key 清掉）
      if (body.name !== undefined && String(body.name).trim()) cur.name = String(body.name).trim();
      if (body.model !== undefined && String(body.model).trim()) cur.model = String(body.model).trim();
      if (body.baseUrl !== undefined && String(body.baseUrl).trim()) cur.baseUrl = normalizeBaseUrl(String(body.baseUrl).trim());
      if (body.provider !== undefined) cur.provider = String(body.provider || '');
      // apiKey === null 表示显式清空；undefined 表示不改；空串按「不改」处理（前端留空=保留旧 Key）
      if (body.apiKey === null) { cur.apiKey = ''; }
      else if (body.apiKey !== undefined && String(body.apiKey).trim()) { cur.apiKey = String(body.apiKey).trim(); }
      profiles[idx] = cur;
      saveProfiles({ activeId, profiles });
      // 若更新的是当前生效配置，同步到 config.json
      if (activeId === pid) activateProfile(cur);
      return sendJson(res, 200, { ok: true, profile: profilePublic(cur) });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'DELETE' && p.startsWith('/api/profiles/') && p.split('/')[3]) {
    const pid = decodeURIComponent((p.split('/')[3] || '').replace(/^:/, ''));
    const { activeId, profiles } = loadProfiles();
    const idx = profiles.findIndex((x) => x.id === pid);
    if (idx < 0) return sendJson(res, 404, { ok: false, error: '配置不存在' });
    profiles.splice(idx, 1);
    let nextActive = activeId;
    if (activeId === pid) nextActive = profiles.length ? profiles[0].id : null;
    saveProfiles({ activeId: nextActive, profiles });
    if (nextActive) {
      const nxt = profiles.find((x) => x.id === nextActive);
      if (nxt) activateProfile(nxt);
    } else {
      saveConfig({ apiKey: '', model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL });
    }
    return sendJson(res, 200, { ok: true, activeId: nextActive });
  }

  if (req.method === 'POST' && p === '/api/profiles/activate') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const id = String(body.id || '');
      const { activeId, profiles } = loadProfiles();
      const hit = profiles.find((x) => x.id === id);
      if (!hit) return sendJson(res, 404, { ok: false, error: '配置不存在' });
      saveProfiles({ activeId: id, profiles });
      const act = activateProfile(hit);
      return sendJson(res, 200, { ok: true, activeId: id, profile: profilePublic(hit), cfg: act ? act.cfg : undefined });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* 「设置 → 关于应用」用：告诉前端本机 LICENSE.md 的真实路径（前端交给系统打开） */
  if (req.method === 'GET' && p === '/api/about/license') {
    const lic = path.join(ROOT, 'LICENSE.md');
    return sendJson(res, 200, { ok: fs.existsSync(lic), path: lic });
  }

  if (req.method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, { ok: true, config: loadConfig() });
  }

  if (req.method === 'POST' && p === '/api/config') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const cfg = saveConfig({
        apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : loadConfig().apiKey,
        model: (body.model && String(body.model).trim()) || loadConfig().model,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : loadConfig().baseUrl,
        searchApiKey: typeof body.searchApiKey === 'string' ? body.searchApiKey.trim() : loadConfig().searchApiKey,
        searchProvider: typeof body.searchProvider === 'string' ? body.searchProvider : loadConfig().searchProvider,
        libraryEnabled: body.libraryEnabled !== undefined ? body.libraryEnabled !== false : loadConfig().libraryEnabled,
        extendedTools: body.extendedTools !== undefined ? body.extendedTools === true : loadConfig().extendedTools,
      });
      return sendJson(res, 200, {
        ok: true, hasKey: !!cfg.apiKey, keyMasked: maskKey(cfg.apiKey),
        model: cfg.model, baseUrl: cfg.baseUrl,
        hasSearchKey: !!effectiveSearchKey(cfg),
        searchEnabled: true,
        searchProvider: cfg.searchProvider || 'auto',
        searchMode: resolveSearchProvider(cfg), // server | free
      });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/generate-title') {
    return readBody(req, 256 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const cfg = loadConfig();
      return generateTitle(cfg, String(body.userText || ''), String(body.assistantText || ''))
        .then((r) => sendJson(res, r.ok ? 200 : 400, r));
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }
  if (req.method === 'POST' && p === '/api/test-key') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const cfg = loadConfig();
      const key = (typeof body.apiKey === 'string' && body.apiKey.trim()) ? body.apiKey.trim() : cfg.apiKey;
      const model = (body.model && String(body.model).trim()) || cfg.model;
      const baseUrl = (typeof body.baseUrl === 'string' && body.baseUrl.trim()) ? body.baseUrl : cfg.baseUrl;
      if (!key) return sendJson(res, 400, { ok: false, error: '请先填写 API Key' });
      return testDeepSeekKey(key, model, baseUrl).then((r) => sendJson(res, r.ok ? 200 : 400, r));
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'GET' && p === '/api/models') {
    return fetchModels(loadConfig()).then((m) => sendJson(res, m.ok ? 200 : 400, m));
  }
  if (req.method === 'POST' && p === '/api/models') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const cfg = loadConfig();
      // 允许传入"尚未保存"的 Key / 地址（设置界面"获取模型"在保存前即可用）
      const apiKey = (typeof body.apiKey === 'string' && body.apiKey.trim()) ? body.apiKey.trim() : cfg.apiKey;
      const baseUrl = (typeof body.baseUrl === 'string' && body.baseUrl.trim()) ? normalizeBaseUrl(body.baseUrl) : cfg.baseUrl;
      return fetchModels({ apiKey, baseUrl }).then((m) => sendJson(res, m.ok ? 200 : 400, m));
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/extract-pdf') {
    return readBody(req, MAX_BODY).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const b64 = String(body.data || '');
      if (!b64) return sendJson(res, 400, { ok: false, error: '没有收到 PDF 数据' });
      let buf;
      try { buf = Buffer.from(b64, 'base64'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'PDF 数据格式错误' }); }
      if (buf.length < 4 || buf.toString('latin1', 0, 4) !== '%PDF') {
        return sendJson(res, 400, { ok: false, error: '文件不是有效的 PDF' });
      }
      const text = extractPdfText(buf);
      if (!text) {
        return sendJson(res, 422, { ok: false, error: '未能从 PDF 提取到文字（可能是扫描件/图片版 PDF），请改用 OCR 或直接粘贴文字。' });
      }
      return sendJson(res, 200, {
        ok: true,
        name: String(body.name || 'document.pdf').slice(0, 120),
        text,
        charCount: text.length,
      });
    }).catch((e) => sendJson(res, 500, { ok: false, error: 'PDF 提取失败：' + e.message }));
  }

  if (req.method === 'POST' && p === '/api/extract-docx') {
    return readBody(req, MAX_BODY).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const b64 = String(body.data || '');
      if (!b64) return sendJson(res, 400, { ok: false, error: '没有收到文件数据' });
      let buf;
      try { buf = Buffer.from(b64, 'base64'); } catch (_) { return sendJson(res, 400, { ok: false, error: '文件数据格式错误' }); }
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        return sendJson(res, 400, { ok: false, error: '这不是有效的 .docx 文件（旧版 .doc 请先用 Word 另存为 .docx）' });
      }
      const text = extractDocxText(buf);
      if (!text) return sendJson(res, 422, { ok: false, error: '未能从 Word 文档提取到文字' });
      return sendJson(res, 200, {
        ok: true,
        name: String(body.name || 'document.docx').slice(0, 120),
        text,
        charCount: text.length,
      });
    }).catch((e) => sendJson(res, 500, { ok: false, error: 'Word 提取失败：' + e.message }));
  }

  if (req.method === 'POST' && p === '/api/export/docx') {
    return readBody(req, MAX_BODY).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: '没有可导出的内容' });
      const title = (String(body.title || '').trim() || '辩论教练导出').slice(0, 80);
      const buf = markdownToDocx(text, { title });
      const safeName = title.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40) || 'export';
      const filename = safeName + '.docx';
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="export.docx"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    }).catch((e) => sendJson(res, 500, { ok: false, error: '生成 Word 失败：' + e.message }));
  }

  /* ---------------- 个人资料库 API ---------------- */
  if (req.method === 'GET' && p === '/api/library') {
    try {
      const cfg = loadConfig();
      const idx = libLoadIndex();
      const items = idx.items.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).map(libPublic);
      const totalChars = items.reduce((n, x) => n + (Number(x.charCount) || 0), 0);
      return sendJson(res, 200, { ok: true, items, count: items.length, totalChars, enabled: cfg.libraryEnabled !== false });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/library/upload') {
    return readBody(req, 24 * 1024 * 1024).then(async (raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: '缺少文件名' });
      const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，\s]+/).filter(Boolean);
      let payload;
      let ocrInfo = null;
      if (typeof body.text === 'string') {
        payload = { text: body.text };
      } else {
        const b64 = String(body.data || '');
        if (!b64) return sendJson(res, 400, { ok: false, error: '没有收到文件内容' });
        let buf;
        try { buf = Buffer.from(b64, 'base64'); } catch (_) { return sendJson(res, 400, { ok: false, error: '文件数据格式错误' }); }
        if (buf.length > LIB_MAX_FILE) {
          return sendJson(res, 413, { ok: false, error: '《' + name + '》超过 ' + Math.round(LIB_MAX_FILE / 1024 / 1024) + 'MB 上限，请先拆分或压缩' });
        }
        const ext = libExtOf(name);
        if (OCR_IMAGE_EXT.has(ext)) {
          // 图片：走本机 Windows OCR（不出网）
          const o = await ocrImageBuffer(buf, ext);
          if (o.error) return sendJson(res, 422, { ok: false, error: '图片 OCR 失败：' + o.error, name });
          payload = { text: o.text, kind: 'ocr', note: '图片 OCR 识别（' + (o.lang || '系统默认语言') + '）' };
          ocrInfo = { lang: o.lang, charCount: o.text.length };
        } else {
          payload = { buf };
        }
      }
      const r = libAdd(Object.assign({ name, tags }, payload));
      if (r.error) return sendJson(res, 422, { ok: false, error: r.error, name });
      return sendJson(res, 200, { ok: true, item: libPublic(r.item), ocr: ocrInfo });
    }).catch((e) => sendJson(res, 500, { ok: false, error: '入库失败：' + e.message }));
  }

  /* 产物 → 资料库：引用式入库（不复制内容，永远读产物最新版） */
  if (req.method === 'POST' && p === '/api/library/from-deliverable') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r2 = libAddFromDeliverable(body.name, { tags: body.tags, name: body.title });
      if (r2.error && !r2.item) return sendJson(res, 422, { ok: false, error: r2.error });
      if (r2.error) return sendJson(res, 200, { ok: true, duplicated: true, error: r2.error, item: libPublic(r2.item) });
      return sendJson(res, 200, { ok: true, item: libPublic(r2.item) });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/library/update') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const idx = libLoadIndex();
      const it = idx.items.find((x) => x.id === body.id);
      if (!it) return sendJson(res, 404, { ok: false, error: '资料不存在' });
      if (typeof body.name === 'string' && body.name.trim()) it.name = libSafeName(body.name, it.name);
      if (Array.isArray(body.tags)) it.tags = body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
      if (body.enabled !== undefined) it.enabled = body.enabled !== false;
      libSaveIndex(idx);
      return sendJson(res, 200, { ok: true, item: libPublic(it) });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/library/delete') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const ok = libRemove(String(body.id || ''));
      return sendJson(res, 200, { ok, error: ok ? undefined : '资料不存在' });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/library/search') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const q = String(body.query || '').trim();
      if (!q) return sendJson(res, 400, { ok: false, error: '请输入检索关键词' });
      // 检索前按需重建：引用式条目的正文在产物空间，产物可能在服务运行期间被改/删，
      // 只在启动时检查会召回不到最新内容（改动后要立刻能搜到）。
      try { libIndexRebuildIfStale(); } catch (_) {}
      const hits = libRecall(q, { ids: Array.isArray(body.ids) ? body.ids : null });
      return sendJson(res, 200, { ok: true, query: q, count: hits.length, hits });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'GET' && p === '/api/library/doc') {
    try {
      const id = String(url.searchParams.get('id') || '');
      const idx = libLoadIndex();
      const it = idx.items.find((x) => x.id === id);
      if (!it) return sendJson(res, 404, { ok: false, error: '资料不存在' });
      let text = '';
      try { text = fs.readFileSync(path.join(ROOT, it.textFile), 'utf8'); } catch (_) { text = ''; }
      return sendJson(res, 200, { ok: true, id: it.id, name: it.name, text, charCount: text.length });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/library/config') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const cfg = saveConfig({ libraryEnabled: body.enabled !== false });
      return sendJson(res, 200, { ok: true, enabled: cfg.libraryEnabled !== false });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }


  if (req.method === 'GET' && p === '/api/library/ocr') {
    return ocrStatus()
      .then((st) => sendJson(res, 200, { ok: true, available: !!st.available, lang: st.lang || '', reason: st.reason || '' }))
      .catch((e) => sendJson(res, 200, { ok: true, available: false, lang: '', reason: e.message }));
  }

  if (req.method === 'GET' && p === '/api/library/synonyms') {
    try { return sendJson(res, 200, { ok: true, groups: libLoadSynonyms() }); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/library/synonyms') {
    return readBody(req, 256 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      let groups = body.groups;
      if (!Array.isArray(groups) && typeof body.text === 'string') {
        groups = body.text.split(/\r?\n/).map((line) => line.split(/[,，、|]/).map((s) => s.trim()).filter(Boolean)).filter((g) => g.length >= 2);
      }
      if (!Array.isArray(groups)) return sendJson(res, 400, { ok: false, error: '格式不对：需要二维数组，或一行一组的文本' });
      const clean = groups.map((g) => (Array.isArray(g) ? g : String(g).split(/[,，、|]/))
        .map((s) => String(s).trim()).filter(Boolean)).filter((g) => g.length >= 2).slice(0, 300);
      libSaveSynonyms(clean);
      return sendJson(res, 200, { ok: true, groups: clean, count: clean.length });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }


  /* ---------------- 技能 / 插件 API ---------------- */
  if (req.method === 'GET' && p === '/api/skills') {
    try {
      const user = skillScanUser();
      const bundled = skillScanBundled();
      return sendJson(res, 200, {
        ok: true,
        user,
        bundled,
        userDir: libRel(path.join('data', '.dsh', 'skills')),
        count: user.length,
        activeCount: user.filter((s) => s.enabled).length,
      });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/skills/import') {
    return readBody(req, SKILL_MAX_FILE + 1024 * 1024).then(async (raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      let content = String(body.content || '');
      if (!content && body.data) {
        try { content = Buffer.from(String(body.data), 'base64').toString('utf8'); } catch (_) { return sendJson(res, 400, { ok: false, error: '文件数据格式错误' }); }
      }
      if (!content || !content.trim()) return sendJson(res, 400, { ok: false, error: '技能内容为空' });
      const r = skillWriteUser(null, content, { overwrite: body.overwrite === true });
      if (r.error) return sendJson(res, 422, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, item: r.item });
    }).catch((e) => sendJson(res, 500, { ok: false, error: '导入失败：' + e.message }));
  }

  if (req.method === 'POST' && p === '/api/skills/save') {
    return readBody(req, SKILL_MAX_FILE + 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: '缺少技能名' });
      const meta = skillParseMd(String(body.content || ''));
      if (meta.name && meta.name !== name) return sendJson(res, 422, { ok: false, error: 'frontmatter 的 name 与文件名不一致' });
      const r = skillWriteUser(name, String(body.content || ''), { overwrite: true });
      if (r.error) return sendJson(res, 422, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, item: r.item });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/skills/toggle') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = skillToggleUser(String(body.name || ''), body.enabled !== false);
      if (r.error) return sendJson(res, 404, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, enabled: r.enabled });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/skills/delete') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = skillRemoveUser(String(body.name || ''));
      if (r.error) return sendJson(res, 404, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'GET' && p === '/api/skills/view') {
    try {
      const name = String(url.searchParams.get('name') || '').trim();
      const r = skillReadUser(name);
      if (r.error) return sendJson(res, 404, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, skill: r });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }


  /* ---------------- 产物空间 API ---------------- */
  if (req.method === 'GET' && p === '/api/deliverables') {
    try {
      const items = deliverList();
      return sendJson(res, 200, { ok: true, items, dir: libRel(path.join('data', 'deliverables')), count: items.length });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'GET' && p === '/api/deliverables/read') {
    try {
      const name = String(url.searchParams.get('name') || '');
      const rawMode = url.searchParams.get('raw') === '1';
      if (rawMode) {
        const safe = path.basename(name);
        const fp = path.join(DELIVER_DIR, safe);
        if (!fs.existsSync(fp)) return sendJson(res, 404, { ok: false, error: '文件不存在' });
        const buf = fs.readFileSync(fp);
        const st = fs.statSync(fp);
        return sendJson(res, 200, { ok: true, file: { name: safe, base64: buf.toString('base64'), size: st.size } });
      }
      const r = deliverRead(name);
      if (r.error) return sendJson(res, 404, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, file: r });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/deliverables/convert') {
    return readBody(req, 128 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = deliverConvert(String(body.name || ''), String(body.target || ''));
      if (r.error) return sendJson(res, 422, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true, item: r.item });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/deliverables/delete') {
    return readBody(req, 128 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = deliverDelete(String(body.name || ''));
      if (r.error) return sendJson(res, 404, { ok: false, error: r.error });
      return sendJson(res, 200, { ok: true });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* ---------------- 使用统计（从 append-only 账本读，删对话不影响历史） ---------------- */
  if (req.method === 'GET' && p === '/api/stats') {
    try {
      const rows = usageReadAll();
      const agg = usageAggregate(rows);
      // 对话数/消息数仍来自当前真实存在的对话（这两个本来就该随删除变化）
      let chats = 0, messages = 0, starred = 0;
      try {
        const all = readAllChats();
        chats = all.length;
        for (const c of all) {
          const ms = Array.isArray(c.messages) ? c.messages : [];
          messages += ms.length;
          for (const m of ms) if (m && m.starred) starred++;
        }
      } catch (_) {}
      return sendJson(res, 200, {
        ok: true,
        usage: agg.total,
        activeDays: agg.activeDays,
        streak: agg.streak,
        days: agg.days,
        models: agg.models,
        chats, messages, starred,
        ledgerRows: rows.length,
      });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  /* ---------------- 辩题档案夹 API ---------------- */
  if (req.method === 'GET' && p === '/api/cases') {
    try {
      const idx = caseLoadIndex();
      const allChats = readAllChats();
      const items = (idx.cases || []).map((c) => casePublic(c, allChats));
      // 丢掉只剩空壳（对话和产物都没了）的辩题，避免列表越用越脏
      const alive = items.filter((x) => x.chats.length || x.deliverables.length);
      if (alive.length !== items.length) {
        idx.cases = idx.cases.filter((c) => {
          const p2 = casePublic(c, allChats);
          return p2.chats.length || p2.deliverables.length;
        });
        caseSaveIndex(idx);
      }
      return sendJson(res, 200, { ok: true, cases: alive, count: alive.length });
    } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/cases/attach') {
    return readBody(req, 256 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r2 = caseAttach(body.motion, { chatId: body.chatId, deliverable: body.deliverable }, { text: body.text, side: body.side });
      if (r2.error) return sendJson(res, 400, { ok: false, error: r2.error });
      return sendJson(res, 200, { ok: true, case: casePublic(r2.caseItem, readAllChats()) });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  if (req.method === 'POST' && p === '/api/cases/guess') {
    return readBody(req, 256 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const guess = caseGuessMotion(body.text || '');
      const exist = guess ? caseFindByMotion(guess) : null;
      return sendJson(res, 200, { ok: true, motion: guess, existing: exist ? exist.id : null });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* 改名 / 改持方：只动索引，不动对话与产物文件名 */
  if (req.method === 'POST' && p === '/api/cases/update') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const idx = caseLoadIndex();
      const c = idx.cases.find((x) => x.id === body.id);
      if (!c) return sendJson(res, 404, { ok: false, error: '辩题不存在' });
      if (typeof body.motion === 'string' && body.motion.trim()) c.motion = body.motion.trim().slice(0, 60);
      if (typeof body.side === 'string') c.side = body.side.trim().slice(0, 20);
      if (Array.isArray(body.deliverables)) c.deliverables = body.deliverables.map((n) => String(n)).slice(0, 200);
      c.updated = Date.now();
      caseSaveIndex(idx);
      return sendJson(res, 200, { ok: true, case: casePublic(c, readAllChats()) });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* 删除辩题：只删索引（用户的对话与产物文件保留），这也是它安全的理由 */
  if (req.method === 'POST' && p === '/api/cases/delete') {
    return readBody(req, 64 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const idx = caseLoadIndex();
      const before = idx.cases.length;
      idx.cases = idx.cases.filter((x) => x.id !== body.id);
      if (idx.cases.length === before) return sendJson(res, 404, { ok: false, error: '辩题不存在' });
      caseSaveIndex(idx);
      return sendJson(res, 200, { ok: true });
    }).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  }

  /* 工具页（辩案工作台/简易流水单）把内容直接存为产物空间文件 */
  if (req.method === 'POST' && p === '/api/deliverables/save') {
    return readBody(req, 16 * 1024 * 1024).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const base = path.basename(String(body.name || '').trim());
      const content = String(body.content ?? '');
      if (!base) return sendJson(res, 400, { ok: false, error: '缺少文件名' });
      if (!content.trim()) return sendJson(res, 400, { ok: false, error: '内容为空' });
      const ext = path.extname(base).toLowerCase();
      if (!['.md', '.markdown', '.txt', '.csv', '.json', '.html'].includes(ext)) {
        return sendJson(res, 400, { ok: false, error: '仅支持 md/txt/csv/json/html，收到：' + (ext || '无扩展名') });
      }
      ensureDir(DELIVER_DIR);
      let out = base;
      let i = 1;
      while (fs.existsSync(path.join(DELIVER_DIR, out))) out = base.replace(/(\.[^.]+)$/, '_' + (++i) + '$1');
      // csv 加 BOM 方便 Excel 直接打开；其余格式不加
      fs.writeFileSync(path.join(DELIVER_DIR, out), ext === '.csv' ? '\ufeff' + content : content, 'utf8');
      return sendJson(res, 200, { ok: true, name: out });
    }).catch((e) => sendJson(res, 500, { ok: false, error: '保存失败：' + e.message }));
  }

  if (req.method === 'POST' && p === '/api/cancel') {
    if (currentRun) {
      currentRun.cancelled = true;
      killTree(currentRun.child);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 200, { ok: false, error: '没有正在运行的任务' });
  }

  if (req.method === 'POST' && p === '/api/chat/stream') {
    const cfg = loadConfig();
    if (!cfg.apiKey) return sendJson(res, 400, { ok: false, error: 'NO_KEY', message: '请先在设置中填写 API Key。' });
    if (!engineReady()) return sendJson(res, 500, { ok: false, error: 'NO_ENGINE', message: 'Agent 内核缺失（runtime/dsh 或 runtime/node 不存在）。请重新解压完整压缩包。' });
    if (currentRun) return sendJson(res, 409, { ok: false, error: 'BUSY', message: '有一个任务正在运行，请等待完成或点击停止。' });

    return readBody(req, MAX_BODY).then((raw) => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: '请输入内容。' });

      const runId = 'task-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      const mode = MODE_META[body.mode] ? body.mode : 'free';
      const searchEnabled = true; // 端侧免费搜索代理常开；有 DeepSeek 搜索 Key 时自动切官方搜索
      // 个人资料库召回：只在用户开启时生效，命中结果注入任务单
      const useLibrary = cfg.libraryEnabled !== false && body.useLibrary !== false;
      // 召回前按需重建：引用式条目跟随产物变化，不刷新会召回不到刚改过的备赛包
      if (useLibrary) { try { libIndexRebuildIfStale(); } catch (_) {} }
      const libHits = useLibrary
        ? libRecall(text, { ids: Array.isArray(body.libraryIds) ? body.libraryIds : null })
        : [];
      ensureDir(TASK_DIR);
      const taskFile = path.join(TASK_DIR, runId + '.md');
      fs.writeFileSync(taskFile, buildTaskInBudget(runId, mode, text, body.history || [], { searchEnabled, library: libHits, extendedTools: cfg.extendedTools === true }), 'utf8');

      // 任务单写入文件供长任务使用；同时把内容内联到 CLI 提示里，避免依赖文件工具。
      // 有些第三方 OpenAI 兼容接口不支持 DSH 工具调用（工具名变为空字符串），
      // 短任务直接内联全文就可以不触发工具调用正常执行。
      let taskText = '';
      try { taskText = fs.readFileSync(taskFile, 'utf8'); } catch (_) {}
      const INLINE_LIMIT = INLINE_TASK_LIMIT; // 字符，留足 Windows 命令行长度余量
      const cliTask = (taskText && taskText.length <= INLINE_LIMIT)
        ? ('你是「逻敏」辩论教练。以下是本次任务的完整任务单，请直接严格执行其中的要求，并把最终答复全文写在你的最终回复里。\n\n' + taskText)
        : ('请先用文件工具读取工作区文件 data/tasks/' + runId + '.md 中的完整任务单（文件较长，下面只贴开头，务必先读文件）。\n\n任务单开头：\n' + (taskText || '').slice(0, 2000));
      writeDshSettings(cfg.model, cfg.baseUrl, effectiveSearchKey(cfg), resolveSearchProvider(cfg));

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let streamedText = '';
      const stream = (event, data) => {
        if (event === 'delta' && typeof data?.text === 'string') streamedText += data.text;
        try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (_) {}
      };
      stream('start', { runId, mode, label: MODE_META[mode].label, model: cfg.model, baseUrl: cfg.baseUrl });
      stream('status', { stage: 'launching', message: '正在启动 Agent 内核（首次启动约 10~30 秒）…' });
      if (libHits.length) {
        stream('library', { items: libHits.map((h) => ({ id: h.id, name: h.name, charCount: h.charCount, score: h.score })) });
      }

      const startedAt = Date.now();
      return runDsh(runId, cliTask, cfg, stream).then((info) => {
        let finalText = String(info.stdout || '').trim();
        const ok = !info.cancelled && !info.timedOut && info.code === 0 && (finalText.length > 0 || streamedText.length > 0);
        // DELIVER 协议：解析并自动转档，成功信息并入回复
        if (ok && finalText) {
          try {
            const dp = deliverProtocolParse(finalText);
            if (dp.requests.length) {
              const notes = [];
              for (const req of dp.requests) {
                const got = deliverConvertTo(req);
                if (got.ok) notes.push('✅ 已生成：' + got.rel);
                else notes.push('❌ 转档失败（' + req.src + ' → ' + req.fmt + '）：' + got.error);
              }
              finalText = dp.cleaned.trim() + (notes.length ? '\n\n---\n**产物转档**\n' + notes.join('\n') : '');
            }
          } catch (_) {}
        }
        if (ok) {
          const doneUsage = extractFinalUsage(startedAt, cfg.model);
          const usagePayload = doneUsage ? Object.assign({ contextWindow: ctxWindowOf(cfg.model) }, doneUsage) : undefined;
          // 落账本：只追加。以后即使这条对话被删掉，这段消耗仍在统计里。
          if (doneUsage) {
            usageAppend({
              date: USAGE_DAY(Date.now()),
              chatId: String(body.chatId || ''),
              mode: String(body.mode || 'free'),
              model: String(cfg.model || ''),
              input: Number(doneUsage.input) || 0,
              output: Number(doneUsage.output) || 0,
              cacheRead: Number(doneUsage.cacheRead) || 0,
              cacheWrite: Number(doneUsage.cacheWrite) || 0,
              reasoning: Number(doneUsage.reasoning) || 0,
              elapsedMs: Date.now() - startedAt,
            });
          }
          stream('done', { runId, text: finalText || streamedText, elapsedMs: Date.now() - startedAt, usage: usagePayload });
        } else {
          stream('error', { runId, message: friendlyError(info), stderrTail: String(info.stderr || '').slice(-800) });
        }
        res.end();
        return undefined;
      }).catch((e) => {
        try { stream('error', { runId, message: '服务内部错误：' + e.message }); } catch (_) {}
        res.end();
      });
    }).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, p);
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

/* ---------------- 中间产物清理（磁盘保留策略） ----------------
   只清「中间产物」，不碰任何用户内容：
   - data/tasks/          每次发送时临时拼出的任务单快照 + 结果 JSON
                          （内容全部来自 chats/memory/library/用户输入，且没有任何代码读回它）
   - data/.dsh/sessions/  内核逐帧运行日志（UI 不读；内核每次都是全新会话，从不 resume 旧会话）
   - storages/session_projcache/  与上面配对的会话投影缓存（会话删了就成孤儿）
   明确不动：chats/、memory.md 与 memory/、deliverables/、library/、config/profiles。
   _auto_backup 也不动 —— 它自己已有 10 份滚动上限。 */
const TASK_KEEP_DAYS = 14;      // 任务单快照保留天数
const TASK_KEEP_MIN = 80;       // 无论如何保留最近 N 个任务文件
const SESSION_KEEP_DAYS = 14;   // 内核会话日志保留天数
const SESSION_KEEP_MIN = 20;    // 无论如何保留最近 N 个会话
const CLEAN_GUARD_MS = 3600 * 1000; // 一小时内动过的文件不删（可能正在跑）

/** 从「按 mtime 降序」的列表里挑出可删项：超出保留期，且不在最近 keepMin 个之内 */
function pickExpired(items, keepDays, keepMin, now) {
  const cutoff = now - keepDays * 86400000;
  return items.filter((it, i) => i >= keepMin && it.mtime < cutoff && (now - it.mtime) > CLEAN_GUARD_MS);
}

/** 清理中间产物，返回 { files, bytes, skipped } */
function cleanIntermediateArtifacts() {
  if (currentRun) return { files: 0, bytes: 0, skipped: 'busy' };
  const now = Date.now();
  let files = 0;
  let bytes = 0;

  // 1) 任务单快照
  try {
    const list = fs.readdirSync(TASK_DIR)
      .filter((n) => /\.(md|json)$/.test(n))
      .map((n) => {
        const p = path.join(TASK_DIR, n);
        try { const st = fs.statSync(p); return { p, mtime: st.mtimeMs, size: st.size }; } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const it of pickExpired(list, TASK_KEEP_DAYS, TASK_KEEP_MIN, now)) {
      try { fs.rmSync(it.p, { force: true }); files++; bytes += it.size; } catch (_) {}
    }
  } catch (_) {}

  // 2) 内核会话日志：按「会话目录」整目录删，避免留下半截会话
  try {
    const root = path.join(DSH_HOME, 'sessions');
    const sessions = [];
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      let newest = 0;
      let size = 0;
      let hasFile = false;
      for (const ent of ents) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.isFile()) continue;
        hasFile = true;
        try { const st = fs.statSync(p); size += st.size; if (st.mtimeMs > newest) newest = st.mtimeMs; } catch (_) {}
      }
      // 只把「叶子会话目录」当清理单元（会话目录 = 直接存日志的那层）
      if (hasFile) sessions.push({ p: dir, mtime: newest, size });
    };
    walk(root);
    sessions.sort((a, b) => b.mtime - a.mtime);
    for (const it of pickExpired(sessions, SESSION_KEEP_DAYS, SESSION_KEEP_MIN, now)) {
      const sid = path.basename(it.p);
      try { fs.rmSync(it.p, { recursive: true, force: true }); files++; bytes += it.size; } catch (_) { continue; }
      try {
        // 顺带删掉配对的投影缓存（会话已删，缓存成孤儿）
        const pc = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', sid + '.json');
        if (fs.existsSync(pc)) { bytes += fs.statSync(pc).size; fs.rmSync(pc, { force: true }); files++; }
      } catch (_) {}
    }
  } catch (_) {}

  return { files, bytes };
}

/* 启动维护（后台跑，不挡窗口）：会话迁移 + 记忆蒸馏 + 三个索引刷新 + 中间产物清理 + 启动快照。
   索引是持久化镜像，重启时已是上次的状态，所以这里只是「刷新」；源没变的直接跳过。 */
async function runStartupMaintenance() {
  const yieldLoop = () => new Promise((r) => setImmediate(r));
  const t0 = Date.now();
  let mm = 'skip', ll = 'skip', cc = 'skip';
  let cl = { files: 0, bytes: 0 };
  try { migrateZstdSessions(); } catch (_) {}
  await yieldLoop();
  try { distillRecentNotes(); } catch (_) {}
  await yieldLoop();
  try { mm = rebuildMemoryIndexIfStale(); } catch (_) {}
  await yieldLoop();
  try { ll = libIndexRebuildIfStale(); } catch (_) {}
  await yieldLoop();
  try { cc = chatIndexRebuildIfStale(); } catch (_) {}
  await yieldLoop();
  try { cl = cleanIntermediateArtifacts(); } catch (_) {}
  await yieldLoop();
  try { autoBackupData('startup', { oncePerDay: true }); } catch (_) {}
  try {
    console.log('[startup] 维护完成 ' + (Date.now() - t0) + 'ms · memory=' + mm + ' lib=' + ll
      + ' chats=' + cc + ' · 清理中间产物 ' + cl.files + ' 个/' + Math.round(cl.bytes / 1024) + 'KB'
      + (cl.skipped ? '（跳过：' + cl.skipped + '）' : ''));
  } catch (_) {}
}

function startServer() {
  const server = http.createServer((req, res) => {
    Promise.resolve(handleRequest(req, res)).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
      else try { res.end(); } catch (_) {}
    });
  });

  const wanted = Number(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.ACADEMY_PORT || DEFAULT_PORT);
  let candidate = Number.isInteger(wanted) && wanted > 0 ? wanted : DEFAULT_PORT;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && candidate < wanted + 20) {
      candidate += 1;
      server.listen(candidate, '127.0.0.1');
    } else {
      console.error('[Academy] 无法监听端口：' + err.message);
      process.exit(1);
    }
  });

  server.listen(candidate, '127.0.0.1', () => {
    actualPort = candidate;
    // 维护工作一律推到下一拍、并分步让出事件循环：Node 单线程，若在 listen 回调里同步跑完，
    // 期间任何请求都答不了；而 electron-main 是等 /api/status 成功才建窗口 —— 那会把窗口出现
    // 硬生生推迟「全部重建 + 全量备份」的时长。索引是持久化镜像，晚几百毫秒刷新无影响。
    setImmediate(() => { runStartupMaintenance(); });
    try {
      const bootCfg = loadConfig();
      writeDshSettings(bootCfg.model, bootCfg.baseUrl, effectiveSearchKey(bootCfg), resolveSearchProvider(bootCfg)); // 启动时同步搜索/模型配置
    } catch (_) {}
    console.log('');
    console.log('============================================');
    console.log('  Academy 辩论教练 · 本地桌面版');
    console.log('  页面: http://127.0.0.1:' + actualPort);
    console.log('  关闭本窗口即退出程序');
    console.log('============================================');
    console.log('');
    const cfg = loadConfig();
    console.log('  引擎: ' + (engineReady() ? 'DSH 极简内核（就绪）' : '缺失！请检查 runtime 目录'));
    console.log('  API Key: ' + (cfg.apiKey ? '已配置（' + maskKey(cfg.apiKey) + '）' : '未配置（首次打开页面会引导填写）'));
    console.log('');

    // 只在默认端口自动开浏览器：非默认端口基本都是测试 / 多开实例，
    // 弹窗会干扰用户（开发调试时也会一次弹一堆）。桌面版由 electron-main 传 ACADEMY_NO_OPEN=1。
    if (!process.env.ACADEMY_NO_OPEN && actualPort === DEFAULT_PORT) {
      const url = 'http://127.0.0.1:' + actualPort + '/';
      if (process.platform === 'win32') {
        exec('cmd /c start "" "' + url + '"', { windowsHide: true });
      } else if (process.platform === 'darwin') {
        exec('open "' + url + '"');
      } else {
        exec('xdg-open "' + url + '"');
      }
    }
  });
}

startServer();
