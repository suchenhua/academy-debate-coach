/*
 * docx.js — 零依赖 Markdown → .docx 生成器（排版规范版）
 * 用 runtime/dsh/node_modules/fflate（纯 JS zip）把 Markdown 转成标准 Word 文档。
 *
 * 排版规范移植自 debate-toolbox/scripts/gen_prep_docx.py（python-docx 编程排版，齐辩备赛包同款）：
 *   页面：上下 2cm、左右 2.5cm；正文：微软雅黑 11pt、行距 1.35、段后 6pt；
 *   标题真层级（outlineLvl，Word 导航窗格可用）；长文档自动加封面页；页脚页码。
 * 支持真·自动编号列表（含两级嵌套）、可点击超链接、表格按内容分列宽、
 * 标题/段落/粗体/斜体/行内代码/围栏代码块/引用/分隔线。
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

/* ---------- 行内格式 ----------
   返回 segment 数组：{text, bold, italic, code, strike} 或 {linkText, url} */
const INLINE_RE = /(`([^`\n]+)`)|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(~~([^~]+)~~)|(!?\[([^\]]*)\]\(([^)\s]+)\))/g;

function inlineSegments(text) {
  const out = [];
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false, italic: false, code: false, strike: false });
    if (m[1]) out.push({ text: m[2], bold: false, italic: false, code: true, strike: false });
    else if (m[3]) out.push({ text: m[4], bold: true, italic: false, code: false, strike: false });
    else if (m[5]) out.push({ text: m[6], bold: false, italic: true, code: false, strike: false });
    else if (m[7]) out.push({ text: m[8], bold: false, italic: false, code: false, strike: true });
    else if (m[9]) out.push({ linkText: m[10] || m[9], url: m[11] });
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false, italic: false, code: false, strike: false });
  if (!out.length) out.push({ text: '', bold: false, italic: false, code: false, strike: false });
  return out;
}

/* 中文行合并不加空格（中文段落里混进空格是旧版最大的观感问题） */
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
function smartJoin(lines) {
  let out = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const a = out.slice(-1) || '';
    const b = (lines[i][0] || '');
    out += (CJK_RE.test(a) || CJK_RE.test(b)) ? '' : ' ';
    out += lines[i];
  }
  return out;
}

/* ---------- run / 段落 XML ---------- */
function runXml(seg, links, extra) {
  if (seg.url !== undefined && seg.url !== null && !seg.text && seg.linkText !== undefined) {
    // 超链接段：http(s) 才生成真链接，其余当普通文本
    if (/^https?:\/\//i.test(seg.url)) {
      links.push(seg.url);
      const rid = 'rIdLink' + links.length;
      const props = ['<w:rStyle w:val="Hyperlink"/>'];
      if (extra && extra.size) props.push('<w:sz w:val="' + extra.size + '"/>');
      return '<w:hyperlink r:id="' + rid + '"><w:r><w:rPr>' + props.join('') + '</w:rPr><w:t xml:space="preserve">' + escXml(seg.linkText) + '</w:t></w:r></w:hyperlink>';
    }
    return '<w:r><w:t xml:space="preserve">' + escXml(seg.linkText + '（' + seg.url + '）') + '</w:t></w:r>';
  }
  const props = [];
  if (seg.bold) props.push('<w:b/>');
  if (seg.italic) props.push('<w:i/>');
  if (seg.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/>', '<w:sz w:val="20"/>', '<w:shd w:val="clear" w:fill="F2F4F8"/>');
  if (seg.strike) props.push('<w:strike/>');
  if (extra && extra.size) props.push('<w:sz w:val="' + extra.size + '"/>');
  if (extra && extra.color) props.push('<w:color w:val="' + extra.color + '"/>');
  return '<w:r><w:rPr>' + props.join('') + '</w:rPr><w:t xml:space="preserve">' + escXml(seg.text) + '</w:t></w:r>';
}

function runsXml(text, links, extra) {
  return inlineSegments(text).map((s) => runXml(s, links, extra)).join('');
}

function paraXml(text, styleId, opts = {}, links = []) {
  const pPr = [];
  if (styleId) pPr.push('<w:pStyle w:val="' + styleId + '"/>');
  if (opts.numPr) pPr.push('<w:numPr><w:ilvl w:val="' + (opts.numPr.ilvl || 0) + '"/><w:numId w:val="' + opts.numPr.numId + '"/></w:numPr>');
  if (opts.indent) pPr.push('<w:ind w:left="' + opts.indent + '"/>');
  if (opts.align) pPr.push('<w:jc w:val="' + opts.align + '"/>');
  if (opts.border) pPr.push('<w:pBdr><w:left w:val="single" w:sz="12" w:space="4" w:color="9CB3F5"/></w:pBdr>');
  let body = runsXml(text, links, opts.run);
  if (opts.brs) body += opts.brs.map(() => '<w:r><w:br/></w:r>').join('');
  return '<w:p>' + (pPr.length ? '<w:pPr>' + pPr.join('') + '</w:pPr>' : '') + body + '</w:p>';
}

/* ---------- 表格：按内容长度分列宽（旧版均分，长句挤成细条） ---------- */
function cellXml(text, opts = {}) {
  const p = paraXml(text, opts.header ? 'CellHeader' : 'Normal', { align: opts.header ? 'center' : undefined });
  return '<w:tc><w:tcPr><w:tcW w:w="' + opts.width + '" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>' + p + '</w:tc>';
}

function tableXml(rows, links) {
  const cols = rows[0].length;
  const TABLE_W = 9072; // A4 宽 11906 − 左右边距 2×1417
  const weights = Array(cols).fill(4);
  for (const r of rows) {
    r.forEach((c, j) => {
      const len = Math.min(String(c).length, 48);
      if (len > weights[j]) weights[j] = len;
    });
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.max(700, Math.floor((TABLE_W * w) / sum)));
  widths[cols - 1] += TABLE_W - widths.reduce((a, b) => a + b, 0); // 补齐取整误差

  let xml = '<w:tbl><w:tblPr><w:tblW w:w="' + TABLE_W + '" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="C9C9C9"/>' +
    '</w:tblBorders></w:tblPr><w:tblGrid>' +
    widths.map((w) => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>';
  for (let i = 0; i < rows.length; i++) {
    xml += '<w:tr>' + rows[i].map((c, j) => cellXml(c, { header: i === 0, width: widths[j] })).join('') + '</w:tr>';
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
/* 列表嵌套层级：缩进 2-3 空格或 1 个 Tab = 一级，4+ 空格 = 二级（封顶） */
function listDepth(line) {
  const m = line.match(/^([ \t]*)/);
  const ind = m ? m[1] : '';
  if (ind.includes('\t')) return Math.min(ind.length, 2);
  if (ind.length >= 4) return 2;
  if (ind.length >= 2) return 1;
  return 0;
}
function stripListMarker(line) {
  let l = line.replace(/^([ \t]*)/, (s) => ' '.repeat(Math.min(s.replace(/\t/g, '  ').length, 0))); // 去缩进
  return l.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
}

function markdownToDocXml(md, links, nums) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const body = [];
  let i = 0;
  let nextNumId = 10; // 每个有序列表一个独立 numId（计数器互不延续，各列表从 1 重数）

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^```/.test(line)) {
      i++;
      const codeLines = [];
      while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      if (i < lines.length) i++;
      for (const c of codeLines) body.push(paraXml(c || ' ', 'Code', {}, links));
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      body.push(paraXml(h[2], 'Heading' + h[1].length, {}, links));
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      body.push(paraXml('', 'Normal', { border: true }, links));
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
      body.push(tableXml(rows, links));
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      for (const b of buf) body.push(paraXml(b, 'Quote', {}, links));
      continue;
    }

    // 列表（含嵌套）：无序共用 numId=1，有序每块独立 numId 真自动编号
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      let orderId = null;
      while (i < lines.length) {
        const l = lines[i];
        const isOrdered = /^\s*\d+[.)]\s+/.test(l);
        const isBullet = /^\s*[-*+]\s+/.test(l);
        if (!isOrdered && !isBullet) break;
        if (isOrdered && orderId === null) {
          orderId = nextNumId++;
          nums.push(orderId);
        }
        const depth = listDepth(l);
        const content = stripListMarker(l);
        body.push(paraXml(content, 'ListParagraph', {
          numPr: isOrdered ? { numId: orderId, ilvl: depth } : { numId: 1, ilvl: depth },
        }, links));
        i++;
      }
      continue;
    }

    // 普通段落（合并相邻行；中文行间不加空格）
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s+|```|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) {
      buf.push(lines[i]);
      i++;
    }
    body.push(paraXml(smartJoin(buf), 'Normal', {}, links));
  }
  return body.join('');
}

/* ---------- 封面（长文档自动加：居中标题 + 日期署名 + 分页） ---------- */
function coverXml(title) {
  const now = new Date();
  const dateStr = now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日';
  const blank = '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>';
  const t = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:rPr>' + FONT_YAHEI + '<w:b/><w:color w:val="1F3864"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr>' +
    '<w:t xml:space="preserve">' + escXml(title) + '</w:t></w:r></w:p>';
  const meta = paraXml('逻敏辩论教练 · ' + dateStr, null, { align: 'center', run: { size: '18', color: '8A93A6' } }, []); // 9pt
  const br = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  return blank + blank + blank + blank + blank + blank + t + blank + blank + blank + blank + meta + br;
}

/* ---------- 文档部件 ---------- */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

function docRels(links) {
  // styles/numbering/footer 必须在这里声明，否则严格解析器（python-docx、部分 Word 版本）会忽略整个样式表
  let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  rels += '<Relationship Id="rIdS1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  rels += '<Relationship Id="rIdN1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
  rels += '<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>';
  links.forEach((url, i) => {
    rels += '<Relationship Id="rIdLink' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + escXml(url) + '" TargetMode="External"/>';
  });
  return rels + '</Relationships>';
}

/* 排版规范：正文微软雅黑 11pt 行距 1.35；标题深蓝灰层级（Word 导航可用） */
const FONT_YAHEI = '<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="微软雅黑"/>';
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}>
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="120" w:line="324" w:lineRule="auto"/></w:pPr><w:rPr>${FONT_YAHEI}<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:keepNext/><w:spacing w:before="360" w:after="200"/></w:pPr><w:rPr>${FONT_YAHEI}<w:b/><w:color w:val="1F3864"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/><w:keepNext/><w:spacing w:before="280" w:after="140"/></w:pPr><w:rPr>${FONT_YAHEI}<w:b/><w:color w:val="2F5496"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/><w:keepNext/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr>${FONT_YAHEI}<w:b/><w:color w:val="404040"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/><w:keepNext/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr>${FONT_YAHEI}<w:b/><w:color w:val="404040"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="4"/><w:keepNext/></w:pPr><w:rPr>${FONT_YAHEI}<w:b/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="5"/><w:keepNext/></w:pPr><w:rPr>${FONT_YAHEI}<w:b/><w:i/><w:sz w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="4" w:color="8496B0"/></w:pBdr></w:pPr><w:rPr>${FONT_YAHEI}<w:i/><w:color w:val="445066"/><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:fill="F2F4F8"/><w:spacing w:before="20" w:after="20"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="CellHeader"><w:name w:val="Cell Header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

/* 真自动编号：abstract 0 = 项目符号（• / ◦ / ▪），abstract 1 = 有序（1. / 1.1 样式）。
   每个有序列表块引用独立 numId，计数器从 1 重数。 */
function numberingXml(orderedIds) {
  const lvl = (ilvl, fmt, text, left) =>
    '<w:lvl w:ilvl="' + ilvl + '"><w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/><w:lvlText w:val="' + text + '"/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="' + left + '" w:hanging="360"/></w:pPr>' +
    '<w:rPr>' + FONT_YAHEI + '</w:rPr></w:lvl>';
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${NS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>` +
    lvl(0, 'bullet', '\u2022', 720) + lvl(1, 'bullet', '\u25E6', 1440) + lvl(2, 'bullet', '\u25AA', 2160) +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    lvl(0, 'decimal', '%1.', 720) + lvl(1, 'decimal', '%2.', 1440) + lvl(2, 'decimal', '%3.', 2160) +
    '</w:abstractNum>';
  xml += '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
  for (const id of orderedIds) xml += '<w:num w:numId="' + id + '"><w:abstractNumId w:val="1"/></w:num>';
  return xml + '</w:numbering>';
}

/* 页脚页码：第 X 页 · 共 Y 页 */
const FOOTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${NS}>
<w:p><w:pPr><w:jc w:val="center"/><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr></w:pPr>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> · 共 </w:t></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r>
<w:r><w:rPr>${FONT_YAHEI}<w:color w:val="8A93A6"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r>
</w:p></w:ftr>`;

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
<Application>Academy Debate Coach</Application><Company>logisme-debate-coach</Company>
</Properties>`;
}

/* 页面规格：上下 2cm（1134 缇）、左右 2.5cm（1417 缇），与 gen_prep_docx.py 一致 */
const SECTPR = '<w:sectPr><w:footerReference w:type="default" r:id="rIdF1"/>' +
  '<w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1134" w:right="1417" w:bottom="1134" w:left="1417" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';

function docXml(md, title, links, nums, withCover) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}>
<w:body>
${withCover ? coverXml(title) : ''}
${markdownToDocXml(md, links, nums)}
${SECTPR}
</w:body>
</w:document>`;
}

const encoder = new TextEncoder();

/**
 * 把 Markdown 文本转成标准 .docx 的 Buffer。
 * @param {string} markdown
 * @param {object} [opts] - { title, cover:boolean 强制开/关封面 }（默认长文档自动加封面）
 */
function markdownToDocx(markdown, opts = {}) {
  const fflate = loadFflate();
  const title = String(opts.title || '辩论教练导出').slice(0, 80);
  const links = [];   // 收集过程中填充（超链接 rId）
  const nums = [];    // 收集过程中填充（有序列表 numId）
  const withCover = opts.cover !== undefined ? !!opts.cover : String(markdown || '').length > 6000;

  const files = {
    '[Content_Types].xml': encoder.encode(CONTENT_TYPES),
    '_rels/.rels': encoder.encode(ROOT_RELS),
    'word/document.xml': encoder.encode(docXml(markdown, title, links, nums, withCover)),
    'word/_rels/document.xml.rels': encoder.encode(docRels(links)),
    'word/styles.xml': encoder.encode(STYLES),
    'word/numbering.xml': encoder.encode(numberingXml(nums)),
    'word/footer1.xml': encoder.encode(FOOTER),
    'docProps/core.xml': encoder.encode(coreXml(title)),
    'docProps/app.xml': encoder.encode(appXml()),
  };
  const zipped = fflate.zipSync(files, { level: 6 });
  return Buffer.from(zipped);
}

module.exports = { markdownToDocx };
