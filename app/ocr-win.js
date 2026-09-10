#!/usr/bin/env node
/*
 * ocr-win.js — Windows 自带 OCR（WinRT Windows.Media.Ocr）的本地封装
 *
 * 设计原则：
 *   1. 零依赖、不出本机：不调用任何在线 OCR 服务（原 scripts/ocr/ocr_stdlib.py 走的是
 *      OCR.space 在线接口，会把图片上传到第三方，与「数据不出本机」冲突，故不用于资料入库）
 *   2. 只依赖 Windows 10/11 自带的 Windows PowerShell 5.1 与系统 OCR 语言包
 *   3. 不通过管道取输出（避免编码问题）：PowerShell 把结果写临时文件，Node 再读
 *
 * 踩坑记录（不要改回简单写法）：
 *   - PowerShell 里 WinRT 异步对象表现为 System.__ComObject，直接 .AsTask() 会报
 *     "不包含名为 AsTask 的方法"，必须用反射调用 System.WindowsRuntimeSystemExtensions.AsTask<T>
 *   - Windows.Globalization.Language 必须先以 WindowsRuntime 类型加载，否则传回 WinRT 方法时
 *     无法从 __ComObject 转换，TryCreateFromLanguage 会失败
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff']);
const OCR_TIMEOUT_MS = 120000;
const BT = String.fromCharCode(96); // 反引号：WinRT 泛型名 IAsyncOperation`1 需要

let _status = null; // 缓存：{ available, lang, reason }

function powershellExe() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const cands = [
    path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(sys, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function tmpName(ext) {
  return path.join(os.tmpdir(), 'academy-ocr-' + crypto.randomBytes(6).toString('hex') + (ext ? '.' + ext : ''));
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function unlinkQuiet(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
}

/* Windows OCR 输出会逐字插空格（"人 工 智 能"），这里合并回连续中文 */
function tidyOcrText(text) {
  let s = String(text || '').replace(/\r\n?/g, '\n');
  const CJK = '\\u4e00-\\u9fa5\\u3000-\\u303f\\uff00-\\uffef';
  s = s.replace(new RegExp('([' + CJK + '])\\s+(?=[' + CJK + '])', 'g'), '$1');
  s = s.replace(/([0-9A-Za-z])\s+(?=[\u4e00-\u9fa5])/g, '$1');
  s = s.replace(/([\u4e00-\u9fa5])\s+(?=[0-9A-Za-z])/g, '$1');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function runPs(scriptText, timeoutMs) {
  return new Promise((resolve) => {
    const exe = powershellExe();
    if (!exe) { resolve({ ok: false, error: '未找到 Windows PowerShell（需要 Windows 10/11）' }); return; }
    const psFile = tmpName('ps1');
    fs.writeFileSync(psFile, '\uFEFF' + scriptText, 'utf8'); // UTF-8 BOM，保证 -File 正确读取
    let done = false;
    const finish = (r) => { if (done) return; done = true; unlinkQuiet(psFile); resolve(r); };
    let child;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (e) { finish({ ok: false, error: e.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ ok: false, error: 'OCR 超时' }); }, timeoutMs || OCR_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    child.on('close', () => { clearTimeout(timer); finish({ ok: true }); });
  });
}

const PS_HELPER = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
  '[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null',
  'function Await-Op($op, $resultType) {',
  "  $m = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + '" + BT + "' + '1' } | Select-Object -First 1",
  '  $t = $m.MakeGenericMethod($resultType).Invoke($null, [object[]]@($op))',
  '  return $t.GetAwaiter().GetResult()',
  '}',
  'function Get-OcrLanguage {',
  '  $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages',
  '  if (-not $langs) { return $null }',
  "  foreach ($p in @('zh-Hans-CN','zh-CN','zh-Hans','zh-Hant','zh')) {",
  "    foreach ($l in $langs) { if ($l.LanguageTag -like ($p + '*')) { return $l } }",
  '  }',
  '  return $langs[0]',
  '}',
].join('\n');

async function ocrStatus(force) {
  if (_status && !force) return _status;
  if (process.platform !== 'win32') {
    _status = { available: false, lang: '', reason: '仅 Windows 10/11 支持本地 OCR' };
    return _status;
  }
  if (!powershellExe()) {
    _status = { available: false, lang: '', reason: '未找到 Windows PowerShell' };
    return _status;
  }
  const out = tmpName('txt');
  const script = PS_HELPER + [
    "$out = '" + out.replace(/'/g, "''") + "'",
    'try {',
    '  $lang = Get-OcrLanguage',
    '  if (-not $lang) { throw "no ocr language pack" }',
    "  [System.IO.File]::WriteAllText($out, 'OK|' + $lang.LanguageTag, [System.Text.UTF8Encoding]::new($false))",
    '} catch {',
    "  [System.IO.File]::WriteAllText($out, 'ERR|' + $_.Exception.Message, [System.Text.UTF8Encoding]::new($false))",
    '}',
  ].join('\n');
  await runPs(script, 60000);
  const res = readIfExists(out);
  unlinkQuiet(out);
  if (res.indexOf('OK|') === 0) {
    _status = { available: true, lang: res.slice(3).trim(), reason: '' };
  } else {
    _status = { available: false, lang: '', reason: (res.replace(/^ERR\|/, '').trim() || '系统 OCR 不可用（可能需要安装中文识别包）') };
  }
  return _status;
}

async function ocrImageBuffer(buf, ext) {
  const e = String(ext || 'png').toLowerCase();
  if (!IMAGE_EXT.has(e)) return { text: '', error: '不支持的图片类型：.' + e };
  const st = await ocrStatus();
  if (!st.available) return { text: '', error: st.reason || '系统 OCR 不可用' };

  const imgFile = tmpName(e);
  const out = tmpName('txt');
  try { fs.writeFileSync(imgFile, buf); } catch (err) { return { text: '', error: '写入临时文件失败：' + err.message }; }

  const script = PS_HELPER + [
    "$img = '" + imgFile.replace(/'/g, "''") + "'",
    "$out = '" + out.replace(/'/g, "''") + "'",
    'try {',
    '  $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($img)) ([Windows.Storage.StorageFile])',
    '  $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
    '  $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '  $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '  $lang = Get-OcrLanguage',
    '  if (-not $lang) { throw "no ocr language pack" }',
    '  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)',
    '  if (-not $engine) { throw "cannot create ocr engine" }',
    '  $res = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    '  [System.IO.File]::WriteAllText($out, $res.Text, [System.Text.UTF8Encoding]::new($false))',
    "  [System.IO.File]::WriteAllText($out + '.lang', $lang.LanguageTag, [System.Text.UTF8Encoding]::new($false))",
    '} catch {',
    "  [System.IO.File]::WriteAllText($out, '', [System.Text.UTF8Encoding]::new($false))",
    "  [System.IO.File]::WriteAllText($out + '.err', $_.Exception.Message, [System.Text.UTF8Encoding]::new($false))",
    '}',
  ].join('\n');

  const r = await runPs(script, OCR_TIMEOUT_MS);
  const raw = readIfExists(out);
  const lang = readIfExists(out + '.lang').trim();
  const err = readIfExists(out + '.err').trim();
  unlinkQuiet(imgFile);
  unlinkQuiet(out);
  unlinkQuiet(out + '.lang');
  unlinkQuiet(out + '.err');
  if (!r.ok) return { text: '', error: r.error };
  const text = tidyOcrText(raw);
  if (!text) return { text: '', error: err || 'OCR 没识别出文字（图片可能太模糊，或缺少中文识别包）', lang };
  return { text, lang, error: '' };
}

module.exports = { ocrImageBuffer, ocrStatus, IMAGE_EXT };
