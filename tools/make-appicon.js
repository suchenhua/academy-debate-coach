'use strict';
/*
 * make-appicon.js — 生成零依赖的 Academy 辩论教练 应用图标（ICO，多尺寸）
 * 图标：蓝色圆角方块 + 白色对话气泡 + 三点输入中提示
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_ICO = path.join(ROOT, 'appicon.ico');
const OUT_FAVICON = path.join(ROOT, 'app', 'public', 'favicon.ico');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// 配色
const BG = [29, 78, 216, 255];    // 蓝色 #1D4ED8
const BG_EDGE = [30, 64, 175, 255];
const BUBBLE = [255, 255, 255, 255];
const DOT = [29, 78, 216, 255];

function roundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function triangle(x, y, ax, ay, bx, by, cx, cy) {
  const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const s2 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  const s3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  const pos = s1 >= 0 && s2 >= 0 && s3 >= 0;
  const neg = s1 <= 0 && s2 <= 0 && s3 <= 0;
  return pos || neg;
}

function render(size) {
  const px = new Float64Array(size * size * 4);
  const SS = 4; // 4x4 超采样抗锯齿
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let hitBg = 0, hitBubble = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxx + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const inBg = roundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22);
          if (!inBg) continue;
          hitBg++;
          const inBubble = roundedRect(x, y, 0.15, 0.19, 0.85, 0.63, 0.15) ||
            triangle(x, y, 0.27, 0.58, 0.47, 0.58, 0.31, 0.84);
          if (inBubble) hitBubble++;
        }
      }
      const total = SS * SS;
      const i = (py * size + pxx) * 4;
      const aBg = hitBg / total;
      const aBub = hitBubble / total;
      // 先画背景，再叠气泡，再叠三个圆点
      let r = BG[0], g = BG[1], b = BG[2], a = aBg;
      const mix = (src) => {
        r = r + (src[0] - r) * aBub;
        g = g + (src[1] - g) * aBub;
        b = b + (src[2] - b) * aBub;
      };
      if (aBub > 0) mix(BUBBLE);
      // 三个“正在输入”圆点（位于气泡内）
      const cy = 0.41, cxs = [0.32, 0.50, 0.68], cr = 0.048;
      for (let d = 0; d < 3; d++) {
        const dx = (pxx + 0.5) / size - cxs[d];
        const dy = (py + 0.5) / size - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const cov = Math.max(0, Math.min(1, (cr - dist) * size + 0.5));
        if (cov > 0) {
          r = r + (DOT[0] - r) * cov;
          g = g + (DOT[1] - g) * cov;
          b = b + (DOT[2] - b) * cov;
        }
      }
      px[i] = Math.max(0, Math.min(255, Math.round(r)));
      px[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      px[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      px[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  // XOR 位图：自下而上 BGRA
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = px[s + 2];
      xor[d + 1] = px[s + 1];
      xor[d + 2] = px[s];
      xor[d + 3] = px[s + 3];
    }
  }
  // AND 掩码：全 0（32bpp 下透明度由 alpha 决定）
  const andStride = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(andStride * size);
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(size, 4);
  bih.writeInt32LE(size * 2, 8);
  bih.writeUInt16LE(1, 12);
  bih.writeUInt16LE(32, 14);
  bih.writeUInt32LE(0, 16);
  bih.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([bih, xor, and]);
}

function buildIco() {
  const images = SIZES.map(render);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const entries = [];
  for (let i = 0; i < SIZES.length; i++) {
    const size = SIZES[i];
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += images[i].length;
  }
  return Buffer.concat([header, ...entries, ...images]);
}

const ico = buildIco();
fs.writeFileSync(OUT_ICO, ico);
fs.mkdirSync(path.dirname(OUT_FAVICON), { recursive: true });
fs.writeFileSync(OUT_FAVICON, ico);
console.log('icon written:', OUT_ICO, ico.length, 'bytes');
console.log('favicon written:', OUT_FAVICON);
