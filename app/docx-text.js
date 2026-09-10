#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · 轻量 Word(.docx) 文本提取器
 *
 * 零新增依赖：复用 runtime/dsh 里已有的 fflate（纯 JS zip）。
 *   - .docx 本质是 zip 包，正文在 word/document.xml
 *   - 按段落(<w:p>)、换行(<w:br>)、制表(<w:tab>)还原文本结构
 *
 * 不支持旧版 .doc（二进制 OLE 格式），前端会提示另存为 .docx。
 * ----------------------------------------------- */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FFLATE_CJS = path.join(ROOT, 'runtime', 'dsh', 'node_modules', 'fflate', 'lib', 'index.cjs');
const FFLATE_NODE_CJS = path.join(ROOT, 'runtime', 'dsh', 'node_modules', 'fflate', 'lib', 'node.cjs');

function loadFflate() {
  try { return require(FFLATE_CJS); } catch (_) {}
  try { return require(FFLATE_NODE_CJS); } catch (_) {}
  return require('fflate');
}

function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch (_) { return ''; } })
    .replace(/&amp;/g, '&');
}

/** 从 .docx 二进制提取纯文本；失败返回 '' */
function extractDocxText(buf) {
  try {
    if (!buf || !buf.length) return '';
    const fflate = loadFflate();
    const files = fflate.unzipSync(new Uint8Array(buf));
    const docEntry = files['word/document.xml'];
    if (!docEntry) return '';
    let xml = Buffer.from(docEntry).toString('utf8');

    // 结构标记 → 文本控制符
    xml = xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:tr>/g, '\n');

    // 只保留 <w:t> 内文本
    xml = xml.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (m, t) => t);
    // 去掉其余标签
    xml = xml.replace(/<[^>]+>/g, '');
    xml = unescapeXml(xml);

    return xml
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (_) { return ''; }
}

module.exports = { extractDocxText };
