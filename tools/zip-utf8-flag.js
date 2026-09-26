/*
 * zip-utf8-flag.js — 给 zip 里「名字含非 ASCII 但未设 UTF-8 标志(bit 11)」的条目补上标志
 *
 * 背景（2026-09-26，第二台机器安装实测翻车）：
 *   bsdtar (tar -a -cf) 打出的 zip，中文文件名存的是 UTF-8 字节但**没设语言编码标志**。
 *   这种条目的名字解码依赖机器的 ANSI 代码页：
 *     - 新 .NET Framework（开发机 4.8）能解对 → 本机装不出来问题；
 *     - 旧 in-box .NET（用户机 4.6.x）按 GBK 解，UTF-8 字节是非法 GBK 序列，
 *       解码替换成 '?' → '?' 是路径非法字符 → ZipFile.ExtractToDirectory 抛
 *       「路径中具有非法字符。」——安装向导在「正在解压程序文件…」一步崩掉。
 *   补上 bit 11 后，所有解压器都按 UTF-8 解，行为全平台一致。
 *
 * 用法：
 *   const { fixZipUtf8Flags } = require('./zip-utf8-flag.js');
 *   fixZipUtf8Flags(zipPath);                 // 原地修补，返回修补数
 * 或 CLI：node tools/zip-utf8-flag.js <zip路径>
 *
 * 实现：解析 EOCD → 走中心目录 → 名字含高位字节且是合法 UTF-8 的条目，
 *       中心目录与本地头两处都置位 0x800。名字不是合法 UTF-8 的不动（避免把
 *       真 GBK 名的 zip 改成双重乱码），只报告。
 */
'use strict';
const fs = require('fs');

function isProbablyValidUtf8(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return true;
    } catch { return false; }
}

function fixZipUtf8Flags(zipPath) {
    const buf = fs.readFileSync(zipPath);

    // 找 EOCD（PK\x05\x06，最多扫末尾 64KB + 22）
    let eocd = -1;
    const scanFrom = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= scanFrom; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 EOCD，不是 zip 或已损坏：' + zipPath);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const totalEntries = buf.readUInt16LE(eocd + 10);

    let scanned = 0, patched = 0, invalidUtf8 = 0;
    const samples = [];

    // 中心目录：sig(4) ver(2) verNeed(2) flags@+8(2) method(2) time(2) date(2) crc(4)
    //           csize(4) usize(4) nameLen@+28(2) extraLen@+30(2) commentLen@+32(2)
    //           disk(2) iattr(2) eattr(4) localOffset@+42(4) name@+46
    let off = cdOffset;
    const cdEnd = cdOffset + cdSize;
    while (off + 46 <= cdEnd) {
        if (buf.readUInt32LE(off) !== 0x02014b50) break;
        const flagsOff = off + 8;
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOffset = buf.readUInt32LE(off + 42);
        const name = buf.slice(off + 46, off + 46 + nameLen);

        scanned++;
        let need = false;
        for (let i = 0; i < name.length; i++) { if (name[i] >= 0x80) { need = true; break; } }
        if (need && !(buf.readUInt16LE(flagsOff) & 0x800)) {
            if (isProbablyValidUtf8(name)) {
                buf.writeUInt16LE(buf.readUInt16LE(flagsOff) | 0x800, flagsOff);
                patched++;
                if (samples.length < 5) samples.push(name.toString('utf8'));
            } else {
                invalidUtf8++;
                if (samples.length < 5) samples.push('(非UTF-8名) ' + name.toString('latin1'));
            }
            // 本地头：sig(4) ver(2) flags@+6(2)
            if (buf.readUInt32LE(localOffset) === 0x04034b50) {
                const lf = localOffset + 6;
                if (isProbablyValidUtf8(name)) buf.writeUInt16LE(buf.readUInt16LE(lf) | 0x800, lf);
            }
        }
        off = off + 46 + nameLen + extraLen + commentLen;
    }

    if (patched > 0) fs.writeFileSync(zipPath, buf);
    return { scanned, patched, invalidUtf8, totalEntries, samples };
}

module.exports = { fixZipUtf8Flags };

if (require.main === module) {
    const target = process.argv[2];
    if (!target) { console.error('用法: node tools/zip-utf8-flag.js <zip路径>'); process.exit(1); }
    const t0 = Date.now();
    const r = fixZipUtf8Flags(target);
    console.log('条目扫描: ' + r.scanned + '/' + r.totalEntries +
        '，补 UTF-8 标志: ' + r.patched +
        (r.invalidUtf8 ? '，非 UTF-8 名未动: ' + r.invalidUtf8 : '') +
        '，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
    if (r.samples.length) console.log('样例:\n  ' + r.samples.join('\n  '));
}
