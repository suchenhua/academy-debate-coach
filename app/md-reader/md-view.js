// md-view.js — 与主 App 同款的最小 Markdown → HTML 渲染器（供独立阅读窗使用，纯前端、无依赖）
// 从 app/public/app.js 原样提炼：esc / inlineMd / mdToHtml，保证显示一致。
(function () {
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function inlineMd(src) {
    let s = esc(src);
    s = s.replace(/\`([^\`\n]+)\`/g, (_m, c) => '<code>' + c + '</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  function mdToHtml(src) {
    const text = String(src || '').replace(/\r\n/g, '\n');
    const codeBlocks = [];
    const withPlaceholders = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      codeBlocks.push({ lang, code });
      return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
    });
    const lines = withPlaceholders.split('\n');
    const html = [];
    let i = 0;
    const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l) && l.includes('|');
    while (i < lines.length) {
      const line = lines[i];
      if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
        const idx = Number(line.trim().match(/CODE(\d+)/)[1]);
        const b = codeBlocks[idx];
        html.push('<pre' + (b.lang ? ' data-lang="' + esc(b.lang) + '"' : '') + '><code>' + esc(b.code) + '</code></pre>');
        i += 1; continue;
      }
      if (/^\s*$/.test(line)) { i += 1; continue; }
      if (/^#{1,4}\s+/.test(line)) {
        const m = line.match(/^(#{1,4})\s+(.*)$/);
        html.push('<h' + m[1].length + '>' + inlineMd(m[2]) + '</h' + m[1].length + '>');
        i += 1; continue;
      }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { html.push('<hr />'); i += 1; continue; }
      if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:\-|]+\|\s*$/.test(lines[i + 1])) {
        const headCells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) { rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())); i += 1; }
        let t = '<table><thead><tr>' + headCells.map((c) => '<th>' + inlineMd(c) + '</th>').join('') + '</tr></thead><tbody>';
        t += rows.map((r) => '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('');
        t += '</tbody></table>';
        html.push(t); continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1; }
        html.push('<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>'); continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const buf = [];
        while (i < lines.length) {
          const l = lines[i];
          if (ordered && /^\s*\d+[.)]\s+/.test(l)) { buf.push(l.replace(/^\s*\d+[.)]\s*/, '')); i += 1; continue; }
          if (!ordered && /^\s*[-*+]\s+/.test(l)) { buf.push(l.replace(/^\s*[-*+]\s*/, '')); i += 1; continue; }
          if (/^\s{2,}/.test(l)) { buf[buf.length - 1] += '\n' + l.trim(); i += 1; continue; }
          break;
        }
        html.push('<' + (ordered ? 'ol' : 'ul') + '>' + buf.map((it) => '<li>' + inlineMd(it) + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>'); continue;
      }
      const buf = [line]; i += 1;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s+|\s*(---+|\*\*\*+|___+)\s*$|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(lines[i]) && !isTableRow(lines[i])) {
        buf.push(lines[i]); i += 1;
      }
      html.push('<p>' + inlineMd(buf.join(' ')) + '</p>');
    }
    return html.join('');
  }
  window.MDView = { mdToHtml, inlineMd, esc };
})();
