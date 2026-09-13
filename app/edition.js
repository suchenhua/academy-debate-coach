/*
 * edition.js — 版本线（Edition）配置 · 单一来源
 *
 * 一条代码库产出两个版本线：
 *   flash = 轻量线（当前公开发行）
 *   pro   = 完整线（在 flash 基础上增加更多前后端功能，后续开发）
 *
 * 选择方式（构建期 / 运行期）：
 *   打包：node tools/pack.js --edition=pro
 *   运行：设置环境变量 ACADEMY_EDITION=pro
 *   都不指定时默认 flash，行为与历史版本完全一致。
 *
 * 用途：
 *   1. version —— 该版本线的发行版本号（必须保持 X.Y.Z 三段式，
 *      tools/pack.js 的版本一致性自检与 tools/sfx/SfxLauncher.cs 的 AssemblyVersion 依赖它）
 *   2. features —— 功能开关表。键存在且为 true 才启用；未声明一律视为关闭，
 *      这样 Pro 独有功能不会因为漏配而泄漏进 Flash 包。
 *   3. name —— 展示用版本线名（「关于应用」显示 v{version} {name}）
 */
'use strict';

const EDITIONS = {
  flash: {
    key: 'flash',
    name: 'Flash',
    version: '2.1.0',
    /* Pro 独有功能的开关都写在这里；flash 下保持 false。
       例：research2: false, batchImport: false */
    features: {},
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    version: '3.0.0',
    features: {},
  },
};

const DEFAULT_EDITION = 'flash';

function resolveEditionKey(raw) {
  const key = String(raw == null ? '' : raw).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EDITIONS, key) ? key : DEFAULT_EDITION;
}

const key = resolveEditionKey(process.env.ACADEMY_EDITION);
const current = EDITIONS[key];

module.exports = {
  EDITIONS,
  DEFAULT_EDITION,
  resolveEditionKey,
  key,
  name: current.name,
  version: current.version,
  features: current.features,
  /** 功能开关查询：未声明的功能一律关闭 */
  has(feature) {
    return current.features[feature] === true;
  },
};
