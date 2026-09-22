/* 独立工具窗注册表 —— 加新工具只改这一处。
 *
 * tool-window.js（通用壳）按它开窗口，electron-main.js 按它校验主窗口的 spawn 请求，
 * 两边共用同一份清单，不再各写一份工具名白名单。
 *
 * 一项的字段：
 *   title / dir            窗口标题 + 渲染目录（目录下需有 renderer.html）
 *   width/height           首次打开的尺寸（用户拖过窗口后以 tool-options-*.json 为准）
 *   minWidth/minHeight     可选，默认 640×480
 *   defaults               该工具额外的持久化字段（写进 data/tool-options-<id>.json）
 *   legacyOptsFile         可选，迁壳前的旧存档名；首次读取会搬家到 tool-options-<id>.json
 *   migrateOpts(raw, opts) 可选，读到存档后的一次性修正（raw 为 null 表示无存档）
 *   initOpts(opts)         窗口启动时回给渲染层的存档字段
 *   offlineHint            主 App 没在运行时的提示文案
 */
'use strict';

const path = require('path');

const TOOLS = {
  research: {
    title: '🔍 研究台 · Academy 辩论教练',
    dir: path.join(__dirname, 'research'),
    width: 1080, height: 780, minWidth: 720, minHeight: 480,
    defaults: { mode: 'server', lastTopic: '' },
    legacyOptsFile: 'research-options.json',   // 2026-09-22 迁壳前的自有存档
    /* 老版本默认通道是 free，实测免费源常被反爬挡掉、返回无关结果。
       迁移研究台时原样保留了它升级前那段强制逻辑（见 09-22 开发日志），
       代价是「基础检索」重开窗口就被切回深度检索。 */
    migrateOpts(raw, opts) { if (!raw || raw.mode !== 'server') opts.mode = 'server'; },
    initOpts: (o) => ({ mode: o.mode, lastTopic: o.lastTopic || '' }),
    offlineHint: '主 App 没在运行：研究台需要主 App 提供搜索与对话服务。请先启动 Academy 辩论教练。',
  },
  verify: {
    title: '🛡 证据检证 · Academy 辩论教练',
    dir: path.join(__dirname, 'verify'),
    width: 860, height: 720,
    defaults: { lastInput: '' },
    initOpts: (o) => ({ lastInput: o.lastInput || '' }),
    offlineHint: '主 App 没在运行：本工具需要主 App 提供搜索与模型服务。请先启动 Academy 辩论教练。',
  },
  trace: {
    title: '📚 资料溯源 · Academy 辩论教练',
    dir: path.join(__dirname, 'trace'),
    width: 860, height: 720,
    defaults: { lastInput: '' },
    initOpts: (o) => ({ lastInput: o.lastInput || '' }),
    offlineHint: '主 App 没在运行：本工具需要主 App 提供搜索与模型服务。请先启动 Academy 辩论教练。',
  },
};

module.exports = { TOOLS };
