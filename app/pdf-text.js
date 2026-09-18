#!/usr/bin/env node
/* -----------------------------------------------
 * Academy 辩论教练 · PDF 文本提取器（基于 pdfjs-dist）
 *
 * 为什么是「重写」而不是「修 bug」：
 *   原实现是手写的纯 Node 提取器（zlib 解压内容流 + 正则抠 Tj/TJ）。
 *   它只能读「单字节编码 + 内嵌 ToUnicode 表」的简单 PDF。而中文 PDF 绝大多数
 *   使用 **CID 字体（/Type0 + /Identity-H）**，字符串里存的是字形编号（GID）而不是
 *   Unicode 码点 —— 必须查 CMap / ToUnicode 才能还原。手写实现没做这层映射，
 *   于是把 GID 直接当码点解释，出来的就是纯乱码（实测《辩论提高小册子》：
 *   抽出 98298 字，CJK 占比 0%）。这不是编码没设对，是解码层的缺失。
 *   同一份实现还会在部分大型 PDF 上抛 RangeError（正则灾难性回溯）整份失败。
 *
 *   结论：解析 PDF 是有标准、有大量边界情况的事，交给专门的库（pdfjs-dist，
 *   Mozilla 出品、Apache-2.0、与 DSH 预览同一个库），不再自己实现。
 *
 * 本文件对外只暴露 extractPdfText()，返回 Promise<{text,pages,totalPages,truncated}|{error}>。
 * 任何失败都以 {error} 形式返回，绝不抛异常、绝不返回乱码。
 * ----------------------------------------------- */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const VENDOR = path.join(__dirname, 'vendor', 'pdfjs');

/* 解析上限：与 server.js 的 LIB_MAX_TEXT 口径一致，另外防止超大 PDF 卡死。
   705 页 / 10MB 的《反驳大全》实测约 1.6 秒、47 万字，所以这些阈值很宽裕。 */
const MAX_CHARS = 600000;
const MAX_PAGES = 2000;
const TIMEOUT_MS = 180000;

/* pdfjs 在 Node 下会抱怨可选的渲染依赖（@napi-rs/canvas / DOMMatrix / Path2D）。
   我们只用它做文本提取，这些告警完全无害，但会污染服务端日志、让人误以为出故障。
   它们发生在 **import 求值期**，早于任何 setVerbosityLevel 调用，所以只能在导入
   那一小段窗口里过滤。过滤是**白名单式**的：只吞掉下面这几个已知无害的前缀，
   其余任何输出原样透传 —— 绝不静默真实的报错。 */
const BENIGN_WARN_RE = /^Warning: (?:Cannot load "@napi-rs\/canvas"|Cannot polyfill `(?:DOMMatrix|Path2D)`|Incorrect 'loca' table|Not enough space in glyfs|TT: undefined function)/;

/* 注意：必须是**异步**版本。import() 立刻返回 promise，模块体是在之后的微任务里
   才求值的 —— 用同步的 try/finally 会在模块体执行前就把 console 还原回去，
   结果一条都过滤不掉（这个坑踩过一次，别再改回同步版）。 */
function quietImport(spec) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const filter = (stream) => (...args) => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (BENIGN_WARN_RE.test(first)) return;
    return stream.apply(console, args);
  };
  console.log = filter(orig.log);
  console.warn = filter(orig.warn);
  console.error = filter(orig.error);
  return import(spec).finally(() => {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  });
}

let _pdfjsPromise = null;
/** 懒加载 pdfjs（首次调用约 500KB 代码，启动时不付这个成本）。失败则重置以便重试。 */
function loadPdfjs() {
  if (!_pdfjsPromise) {
    const entry = pathToFileURL(path.join(VENDOR, 'pdf.mjs')).href;
    _pdfjsPromise = quietImport(entry).then((m) => {
      // 之后运行期的告警（损坏字体表之类）由全局 verbosity 兜住
      try { m.setVerbosityLevel(0); } catch (_) {}
      return m;
    }).catch((e) => {
      _pdfjsPromise = null;
      throw new Error('PDF 解析引擎加载失败（app/vendor/pdfjs 缺失或损坏）：' + (e && e.message ? e.message : e));
    });
  }
  return _pdfjsPromise;
}

/* 字形还原：PDF 里常见的三种「长得像汉字但不是汉字」的码点，统一折回标准汉字。
   只针对这三个区段做 NFKC，**不动全角标点** —— 整串 NFKC 会把「，」变成「,」，
   中文资料会变得很别扭，所以刻意避开。 */
const COMPAT_RE = /[\u2E80-\u2FDF\uF900-\uFAFF]/g;
function foldCompatGlyphs(s) {
  return s.replace(COMPAT_RE, (ch) => {
    const n = ch.normalize('NFKC');
    return n && n !== '\uFFFD' ? n : ch;
  });
}

/** 清掉 PDF 里常见的控制字符（实测出现过 \u0001），保留换行与制表 */
function stripControl(s) {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function tidyText(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 页宽换行：pdfjs 用 hasEOL 标记「这一行到这里结束」，
   照着它断行才保得住段落结构；只把 item.str 顺次拼接会把整篇挤成一行。 */
function pageText(content) {
  const items = (content && content.items) || [];
  let out = '';
  for (const it of items) {
    if (!it || typeof it.str !== 'string') continue;
    out += it.str;
    if (it.hasEOL) out += '\n';
  }
  return out;
}

/**
 * 从 PDF 二进制提取纯文本。
 * @param {Buffer|Uint8Array} buf
 * @param {{maxChars?:number, maxPages?:number}} [opts]
 * @returns {Promise<{text:string, pages:number, totalPages:number, truncated:boolean}|{error:string}>}
 */
async function extractPdfText(buf, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : MAX_CHARS;
  const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : MAX_PAGES;

  if (!buf || !buf.length) return { error: '没有收到 PDF 内容' };
  if (buf.length < 5 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== '%PDF') {
    return { error: '这不是有效的 PDF 文件（缺少 %PDF 文件头）' };
  }

  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (e) {
    return { error: e.message };
  }

  let task = null;
  const timer = setTimeout(() => { try { if (task) task.destroy(); } catch (_) {} }, TIMEOUT_MS);
  timer.unref && timer.unref();

  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      // CMap / 标准字体都从随包分发的 vendor 目录读，不联网
      cMapUrl: pathToFileURL(path.join(VENDOR, 'cmaps') + path.sep).href,
      cMapPacked: true,
      standardFontDataUrl: pathToFileURL(path.join(VENDOR, 'standard_fonts') + path.sep).href,
      // 只做文本提取，不做渲染：关掉字体与 eval，收紧攻击面
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // 0 = 只报错。否则 Node 下会刷一堆「缺 @napi-rs/canvas / DOMMatrix」的
      // 无害警告（那是渲染路径的东西，我们不用），看着像出了问题。
      verbosity: 0,
    });
    const doc = await task.promise;

    const totalPages = doc.numPages || 0;
    const limitPages = Math.min(totalPages, maxPages);
    let text = '';
    let pages = 0;
    let truncated = false;

    for (let i = 1; i <= limitPages; i++) {
      if (text.length >= maxChars) { truncated = true; break; }
      let page;
      try {
        page = await doc.getPage(i);
      } catch (_) {
        continue;   // 单页坏了不该毁掉整份资料
      }
      try {
        const content = await page.getTextContent();
        text += pageText(content) + '\n';
      } catch (_) {
        /* 该页取不到文本，跳过 */
      } finally {
        try { page.cleanup(); } catch (_) {}
      }
      pages++;
    }

    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    if (limitPages < totalPages) truncated = true;

    const cleaned = tidyText(stripControl(foldCompatGlyphs(text)));
    if (!cleaned) {
      return {
        error: '这份 PDF 里没有文字层（多半是扫描件 / 图片版）。两个办法：'
          + '① 用 WPS 或 Word 打开它，另存为 .docx 再传；'
          + '② 把页面截图成图片直接传，系统会自动 OCR 识别文字。',
      };
    }
    return { text: cleaned, pages, totalPages, truncated };
  } catch (e) {
    const name = (e && (e.name || '')) || '';
    const msg = (e && e.message) || String(e);
    if (/password/i.test(name) || /password/i.test(msg)) {
      return { error: '这份 PDF 有密码保护，请先去密码后再传' };
    }
    if (/InvalidPDF|Invalid PDF/i.test(name + ' ' + msg)) {
      return { error: 'PDF 文件已损坏或格式不受支持' };
    }
    return { error: 'PDF 解析失败：' + msg };
  } finally {
    clearTimeout(timer);
    try { if (task) await task.destroy(); } catch (_) {}
  }
}

module.exports = { extractPdfText, MAX_CHARS, MAX_PAGES, VENDOR };
