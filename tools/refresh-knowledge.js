/*
 * refresh-knowledge.js（发行版用 · 已脱敏）
 * 只复制「逻敏 v5.0 蒸馏知识库 + 工具页 + 团队角色卡」，
 * 不复制任何原始资料（会议逐字稿/期刊/备赛包/行政文件/历史复盘）。
 * 复制完成后自动执行 sanitize-open-source.js 做开源合规检查。
 *
 * 用法：node tools/refresh-knowledge.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = {
  logisme: 'E:\\辩论助手工作区\\logisme-debate-coach-v1（skill版本开发）',
  academy: 'E:\\辩论助手工作区\\academy-coach',
};
const TEXT_EXT = new Set(['.md', '.txt', '.py', '.ps1', '.html']);
const EXCLUDE_DIRS = new Set(['__pycache__', 'node_modules', '.git', 'outputs', 'temp']);

function rm(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.warn('rm warn:', dir, e.message); } }
function cp(src, dst, opts = {}) { fs.cpSync(src, dst, Object.assign({ recursive: true, force: true }, opts)); }
function cpTextTree(src, dst, note) {
  const filter = (file) => {
    const base = path.basename(file);
    if (EXCLUDE_DIRS.has(base)) return false;
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return true;
    return TEXT_EXT.has(path.extname(base).toLowerCase());
  };
  cp(src, dst, { filter });
  console.log('  ✓', note);
}

console.log('== Academy 辩论教练 · 刷新脱敏知识库 ==');

// 1) 逻敏 v5.0 主体（原始资料一律不复制）
for (const name of ['knowledge', 'modules', 'prep-coach', 'review-coach', 'judge-assistant', 'protocols', 'personas', 'scripts']) {
  const src = path.join(SRC.logisme, name);
  const dst = path.join(ROOT, name);
  if (!fs.existsSync(src)) { console.warn('  - 跳过缺失目录', src); continue; }
  rm(dst);
  cpTextTree(src, dst, name);
}
for (const f of ['SOUL.md', 'TOOLS.md']) {
  const src = path.join(SRC.logisme, f);
  if (fs.existsSync(src)) { cp(src, path.join(ROOT, f)); console.log('  ✓', f); }
}

// 2) HTML 工具页 → 前端 public/tools
const toolsSrc = path.join(SRC.logisme, 'tools');
const toolsDst = path.join(ROOT, 'app', 'public', 'tools');
if (fs.existsSync(toolsSrc)) {
  rm(toolsDst);
  cpTextTree(toolsSrc, toolsDst, 'HTML 工具页（计时器/流水单/语音练习/辩案工作台/教练计时器）');
}

// 3) Academy 团队角色卡 → team/（仅角色定义，复制后由消毒脚本清洗来源表述）
rm(path.join(ROOT, 'team'));
if (fs.existsSync(path.join(SRC.academy, 'agents'))) {
  cpTextTree(path.join(SRC.academy, 'agents'), path.join(ROOT, 'team'), 'team 角色卡');
  const readme = path.join(SRC.academy, 'README.md');
  if (fs.existsSync(readme)) cp(readme, path.join(ROOT, 'team', 'README.md'));
}

// 4) 开源合规检查（确保无 QFUD 内部痕迹残留）
const sanitize = path.join(ROOT, 'tools', 'sanitize-open-source.js');
if (fs.existsSync(sanitize)) {
  const r = spawnSync(process.execPath, [sanitize], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error('✗ 开源消毒脚本执行失败'); process.exit(1); }
} else {
  console.warn('  ! 未找到 sanitize-open-source.js，跳过开源合规检查');
}

console.log('== 完成（已脱敏 · 未包含任何原始资料/个人隐私/行政模块） ==');