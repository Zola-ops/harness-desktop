// 生成应用/托盘图标（纯 Node 标准库，无依赖）
//   assets/trayTemplate.png  18x18 黑色圆点（macOS template image，菜单栏自适应）
//   assets/icon.png          512x512 应用图标（深色圆角 + 渐变圆环）
'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(width, height, rgbaFn) {
  const rowLen = 1 + width * 4;
  const raw = Buffer.alloc(height * rowLen);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgbaFn(x, y);
      const off = y * rowLen + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

// 1) 托盘 template：18x18 黑色实心圆（居中，r=6）
fs.writeFileSync(
  path.join(outDir, 'trayTemplate.png'),
  png(18, 18, (x, y) => {
    const dx = x - 8.5, dy = y - 8.5;
    return Math.sqrt(dx * dx + dy * dy) <= 6 ? [0, 0, 0, 255] : [0, 0, 0, 0];
  })
);

// 2) 应用图标：512x512 深色圆角方块 + 青→紫渐变圆环（示意"harness"）
const S = 512;
const R = 108; // 圆角半径
const cx = S / 2, cy = S / 2;
const OUTER = 186, INNER = 118;
fs.writeFileSync(
  path.join(outDir, 'icon.png'),
  png(S, S, (x, y) => {
    // 圆角矩形裁剪
    const qx = Math.max(Math.abs(x - cx) - (cx - R), 0);
    const qy = Math.max(Math.abs(y - cy) - (cy - R), 0);
    const inside = qx * qx + qy * qy <= R * R && x >= 0 && y >= 0 && x < S && y < S;
    if (!inside) return [0, 0, 0, 0];
    // 背景：垂直微渐变
    const t = y / S;
    const bg = [17 + 10 * t, 20 + 12 * t, 24 + 14 * t];
    // 圆环
    const d = Math.hypot(x - cx, y - cy);
    if (d >= INNER && d <= OUTER) {
      const a = Math.atan2(y - cy, x - cx);
      const hue = (a / Math.PI) * 0.5 + 0.5;
      // 青 #4cc2ff -> 紫 #8b5cf6
      const r = Math.round(76 + (139 - 76) * hue);
      const g = Math.round(194 + (92 - 194) * hue);
      const b = Math.round(255 + (246 - 255) * hue);
      return [r, g, b, 255];
    }
    // 中心小点
    if (d <= 34) return [236, 242, 248, 255];
    return [bg[0], bg[1], bg[2], 255];
  })
);

console.log('icons generated in', outDir);
