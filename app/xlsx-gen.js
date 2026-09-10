#!/usr/bin/env node
/*
 * xlsx-gen.js — 极简 CSV → .xlsx 生成器（零外部依赖）
 *
 * 原理与 docx.js 一致：XLSX 本质是 zip 包，用 runtime 自带的 fflate 打包几个 XML。
 * 单元格用 inlineStr（内联字符串），避免 sharedStrings 复杂度。
 * 供「产物空间」把 Agent 产出的 .csv 转成 Excel，数据不出本机。
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const FFLATE_CJS = path.join(ROOT, 'runtime', 'dsh', 'node_modules', 'fflate', 'lib', 'index.cjs');
const FFLATE_NODE_CJS = path.join(ROOT, 'runtime', 'dsh', 'node_modules', 'fflate', 'lib', 'node.cjs');

function loadFflate() {
  try { return require(FFLATE_CJS); } catch (_) {}
  try { return require(FFLATE_NODE_CJS); } catch (_) {}
  return require('fflate');
}

function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, '');
}

/* CSV 解析（RFC4180 简化：支持引号包裹与转义引号、
） */
function parseCsv(text) {
  const s = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [], field = '', inQ = false;
  const push = () => { row.push(field); field = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"' && field === '') inQ = true;
    else if (c === ',') push();
    else if (c === '\n') { push(); rows.push(row); row = []; }
    else field += c;
  }
  push(); rows.push(row);
  // 去掉整行全空的尾部空行
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop();
  return rows;
}

function xmlEscapeCell(v) {
  const s = String(v == null ? '' : v);
  // 纯数字且不带前导0/长数字 → 数字单元格；否则字符串
  const num = /^-?\d+(\.\d+)?$/.test(s) && s.length < 15 && !/^0\d/.test(s) && !/^-0/.test(s);
  if (num && !s.includes('.')) return '<c><v>' + s + '</v></c>';
  if (num && s.includes('.')) return '<c><v>' + s + '</v></c>';
  return '<c t="inlineStr"><is><t xml:space="preserve">' + escXml(s) + '</t></is></c>';
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>';

function sheetXml(rows) {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const cells = rows.map((r, ri) => {
    const cs = [];
    for (let ci = 0; ci < cols; ci++) cs.push(xmlEscapeCell(r[ci]));
    return '<row r="' + (ri + 1) + '">' + cs.join('') + '</row>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + cells + '</sheetData></worksheet>';
}

function csvToXlsx(csvText, sheetName) {
  const fflate = loadFflate();
  const rows = parseCsv(csvText);
  const name = String(sheetName || 'Sheet1').slice(0, 31).replace(/[\\/*?:\[\]]/g, '_') || 'Sheet1';
  const wb = WORKBOOK.replace('Sheet1', escXml(name));
  const files = {
    '[Content_Types].xml': Buffer.from(CONTENT_TYPES, 'utf8'),
    '_rels/.rels': Buffer.from(ROOT_RELS, 'utf8'),
    'xl/workbook.xml': Buffer.from(wb, 'utf8'),
    'xl/_rels/workbook.xml.rels': Buffer.from(WORKBOOK_RELS, 'utf8'),
    'xl/worksheets/sheet1.xml': Buffer.from(sheetXml(rows), 'utf8'),
  };
  return Buffer.from(fflate.zipSync(files, { level: 6 }));
}

module.exports = { csvToXlsx, parseCsv };
