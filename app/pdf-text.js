#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · 轻量 PDF 文本提取器
 *
 * 纯 Node 实现、零外部依赖：
 *   - 读取 PDF 中 FlateDecode 压缩流（zlib 解压）
 *   - 从内容流提取 Tj / TJ 文本操作符
 *
 * 适用：文本型 PDF（论文/资料/备赛包）。扫描件/图片 PDF 不含文本层，
 * 提取结果为空，前端应提示用 OCR 或手动粘贴。
 * ----------------------------------------------- */
'use strict';

const zlib = require('zlib');

function unescapePdfString(s) {
  return String(s || '')
    .replace(/\\([nrtbf()\\])/g, (all, c) => {
      switch (c) {
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        case 'b': return '\b';
        case 'f': return '\f';
        default:  return c;
      }
    })
    .replace(/\\(\d{1,3})/g, (all, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function extractTextOps(content) {
  const parts = [];
  // 匹配 [ (a) (b) ] TJ 和 (a) Tj
  const re = /\[([\s\S]*?)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) {
      const arr = m[1].match(/\(((?:\\.|[^\\()])*)\)/g) || [];
      parts.push(arr.map((x) => unescapePdfString(x.slice(1, -1))).join(''));
    } else {
      parts.push(unescapePdfString(m[2]));
    }
  }
  return parts.join('');
}

function extractPdfText(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || '');
  const latin = buffer.toString('latin1');

  // 收集 FlateDecode 流
  const streams = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const dict = m[1] || '';
    if (/\/FlateDecode/.test(dict)) streams.push(m[2]);
  }

  let text = '';
  for (const raw of streams) {
    let data;
    try {
      data = zlib.inflateSync(Buffer.from(raw, 'latin1'));
    } catch (_) {
      continue;
    }
    text += extractTextOps(data.toString('latin1')) + '\n';
  }

  // 清理：合并多余空行/空格，保留段落
  let cleaned = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned;
}

module.exports = { extractPdfText };