/*
 * docx.js — 零依赖 Markdown → .docx 生成器
 * 用 runtime/dsh/node_modules/fflate（纯 JS zip）把 Markdown 转成标准 Word 文档。
 * 支持：标题、段落、粗体/斜体/行内代码、围栏代码块、引用、无序/有序列表、表格、分隔线。
 */
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FFLATE_CJS = path.join(ROOT, 'runtime', 'dsh', 'node_modules', 'fflate', 'lib', 'index.cjs');
const FFLATE_NODE_CJS = path.join(ROOT, 'runtime', 'dsh', 'node_modules', 'fflate', 'lib', 'node.cjs');

function loadFflate() {
  try { return require(FFLATE_CJS); } catch (_) {}
  try { return require(FFLATE_NODE_CJS); } catch (_) {}
  return require('fflate'); // 最后回退：开发机系统安装
}

function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, '');
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/* ---------- 行内格式 ---------- */
function inlineRuns(text) {
  const out = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(`([^`\n]+)`)|(~~([^~]+)~~)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false, italic: false, code: false, strike: false });
    if (m[1]) out.push({ text: m[2], bold: true, italic: false, code: false, strike: false });
    else if (m[3]) out.push({ text: m[4], bold: false, italic: true, code: false, strike: false });
    else if (m[5]) out.push({ text: m[6], bold: false, italic: false, code: true, strike: false });
    else if (m[7]) out.push({ text: m[8], bold: false, italic: false, code: false, strike: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, italic: false, code: false, strike: false });
  if (!out.length) out.push({ text: '', bold: false, italic: false, code: false, strike: false });
  return out;
}

function runsXml(text) {
  return inlineRuns(text).map((seg) => {
    const props = [];
    if (seg.bold) props.push('<w:b/>');
    if (seg.italic) props.push('<w:i/>');
    if (seg.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/>', '<w:sz w:val="20"/>');
    if (seg.strike) props.push('<w:strike/>');
    return '<w:r><w:rPr>' + props.join('') + '</w:rPr><w:t xml:space="preserve">' + escXml(seg.text) + '</w:t></w:r>';
  }).join('');
}

function paraXml(text, styleId, opts = {}) {
  const pPr = [];
  pPr.push('<w:pStyle w:val="' + styleId + '"/>');
  if (opts.indent) pPr.push('<w:ind w:left="' + opts.indent + '"/>');
  if (opts.align) pPr.push('<w:jc w:val="' + opts.align + '"/>');
  if (opts.border) pPr.push('<w:pBdr><w:left w:val="single" w:sz="12" w:space="4" w:color="9CB3F5"/></w:pBdr>');
  let body = runsXml(text);
  if (opts.brs) body += opts.brs.map(() => '<w:r><w:br/></w:r>').join('');
  return '<w:p><w:pPr>' + pPr.join('') + '</w:pPr>' + body + '</w:p>';
}

function cellXml(text, opts = {}) {
  const p = paraXml(text, opts.header ? 'CellHeader' : 'Normal', { align: opts.header ? 'center' : undefined });
  return '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:vAlign w:val="center"/></w:tcPr>' + p + '</w:tc>';
}

function tableXml(rows) {
  const cols = rows[0].length;
  const grid = Array(cols).fill(0).map(() => '<w:gridCol w:w="' + Math.floor(9000 / cols) + '"/>').join('');
  let xml = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '</w:tblBorders></w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>';
  for (let i = 0; i < rows.length; i++) {
    xml += '<w:tr>' + rows[i].map((c, j) => cellXml(c, { header: i === 0 })).join('') + '</w:tr>';
  }
  return xml + '</w:tbl>';
}

/* ---------- 块级解析 ---------- */
function isTableSep(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}
function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function markdownToDocXml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const body = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      i++;
      const codeLines = [];
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++; // 跳过结束围栏
      for (const c of codeLines) body.push(paraXml(c || ' ', 'Code'));
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      body.push(paraXml(h[2], 'Heading' + h[1].length));
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      body.push(paraXml('', 'Normal', { border: true }));
      i++;
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cols = Math.max(...rows.map((r) => r.length));
      for (const r of rows) while (r.length < cols) r.push('');
      body.push(tableXml(rows));
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      for (const b of buf) body.push(paraXml(b, 'Quote'));
      continue;
    }

    // 列表
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      let n = 0;
      while (i < lines.length) {
        const l = lines[i];
        let content = null;
        if (ordered && /^\s*\d+[.)]\s+/.test(l)) { content = l.replace(/^\s*\d+[.)]\s*/, ''); }
        else if (!ordered && /^\s*[-*+]\s+/.test(l)) { content = l.replace(/^\s*[-*+]\s*/, ''); }
        if (content === null) break;
        n++;
        const prefix = ordered ? n + '. ' : '• ';
        body.push(paraXml(prefix + content, 'ListParagraph'));
        i++;
      }
      continue;
    }

    // 普通段落（合并相邻行）
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s+|```|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      buf.push(lines[i]);
      i++;
    }
    body.push(paraXml(buf.join(' '), 'Normal'));
  }
  return body.join('');
}

/* ---------- 文档部件 ---------- */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:keepNext/><w:spacing w:before="280" w:after="140"/></w:pPr><w:rPr><w:b/><w:color w:val="1F5EFF"/><w:sz w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/><w:keepNext/><w:spacing w:before="220" w:after="100"/></w:pPr><w:rPr><w:b/><w:color w:val="1F5EFF"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/><w:keepNext/><w:spacing w:before="180" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="2F3B52"/><w:sz w:val="25"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/><w:keepNext/><w:spacing w:before="140" w:after="60"/></w:pPr><w:rPr><w:b/><w:color w:val="2F3B52"/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="4" w:color="1F5EFF"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="445066"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:fill="F2F4F8"/><w:spacing w:before="20" w:after="20"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="420" w:hanging="210"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="CellHeader"><w:name w:val="Cell Header"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`;

function coreXml(title) {
  const t = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escXml(title)}</dc:title><dc:creator>逻敏辩论教练</dc:creator><cp:lastModifiedBy>逻敏辩论教练</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${t}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${t}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Academy Debate Coach</Application><Company>logisme-debate-coach</Company><AppVersion>1.1.0</AppVersion>
</Properties>`;
}

function docXml(md, title) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}>
<w:body>
${paraXml(title, 'Heading1', { align: 'center' })}
${markdownToDocXml(md)}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>`;
}

const encoder = new TextEncoder();

/**
 * 把 Markdown 文本转成标准 .docx 的 Buffer。
 * @param {string} markdown
 * @param {object} [opts] - { title, watermark }
 */
function markdownToDocx(markdown, opts = {}) {
  const fflate = loadFflate();
  const title = String(opts.title || '辩论教练导出').slice(0, 80);
  const files = {
    '[Content_Types].xml': encoder.encode(CONTENT_TYPES),
    '_rels/.rels': encoder.encode(ROOT_RELS),
    'word/document.xml': encoder.encode(docXml(markdown, title)),
    'word/_rels/document.xml.rels': encoder.encode(DOC_RELS),
    'word/styles.xml': encoder.encode(STYLES),
    'docProps/core.xml': encoder.encode(coreXml(title)),
    'docProps/app.xml': encoder.encode(appXml()),
  };
  const zipped = fflate.zipSync(files, { level: 6 });
  return Buffer.from(zipped);
}

module.exports = { markdownToDocx };
