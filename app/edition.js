/*
 * edition.js — 版本型号（Edition）配置 · 单一来源
 *
 * 同一版本、两种型号：
 *   flash = 轻量版（当前公开发行）
 *   pro   = 完整版（在 flash 基础上增加更多前后端功能，后续开发）
 *
 * 两个型号共用同一个版本号（version）：型号只决定功能集，不决定版本号。
 *
 * 选择方式（构建期 / 运行期）：
 *   打包：node tools/pack.js --edition=pro
 *   运行：设置环境变量 ACADEMY_EDITION=pro
 *   都不指定时默认 flash，行为与历史版本完全一致。
 *
 * 用途：
 *   1. version —— 发行版本号（必须保持 X.Y.Z 三段式，
 *      tools/pack.js 的版本一致性自检与 tools/sfx/SfxLauncher.cs 的 AssemblyVersion 依赖它）
 *   2. features —— 功能开关表。键存在且为 true 才启用；未声明一律视为关闭，
 *      这样 Pro 独有功能不会因为漏配而泄漏进 Flash 包。
 *   3. name —— 展示用型号名（「关于应用」显示 v{version} {name}）
 */
'use strict';

const EDITIONS = {
  flash: {
    key: 'flash',
    name: 'Flash',
    version: '2.1.1',
    /* Pro 独有功能的开关都写在这里；flash 下保持 false。
       例：research2: false, batchImport: false */
    features: {},
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    /* 与 flash 共用同一个版本号：Flash / Pro 是「同一版本的两个型号」，
       不是两条独立演进的产品线——型号只决定功能集。 */
    version: '2.1.1',
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
