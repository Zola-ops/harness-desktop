// 生成 DSH-Z 应用图标（按 agnes 设计规格实现：深藏蓝圆角 + 电光蓝 Z 节点）
// 产物：assets/icon.png (512) + assets/trayTemplate.png (18, 黑白 template)
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
    raw[y * rowLen] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgbaFn(x, y);
      const off = y * rowLen + 1 + x * 4;
      raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

// ---- agnes 设计规格实现（512 画布） ----
const S = 512;
const R = 104;               // 圆角
const cx = S / 2, cy = S / 2;
// Z 布局（居中，宽 296 高 276）
const ZX = 108, ZY = 118;    // Z 区域左上
const ZW = 296, ZL = 276;    // 宽/高
const HALF = 20;             // 线条半宽
const NODE_R = 40;           // 节点半径
const GLOW_R = 78;           // 光晕半径
// 电光蓝 / 白
const BLUE = [59, 130, 246];
const LBLUE = [147, 197, 253];
const WHITE = [242, 246, 251];

// 点到线段距离
function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx - px, qy = y1 + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

// Z 线段
const SEGS = [
  [ZX, ZY, ZX + ZW, ZY],                 // 顶横
  [ZX + ZW, ZY, ZX, ZY + ZL],            // 斜线
  [ZX, ZY + ZL, ZX + ZW, ZY + ZL],       // 底横
];
// 节点位置（Z 端点 + 折点）
const NODES = [
  [ZX, ZY, true],          // 左上端点
  [ZX, ZY + ZL, true],     // 左下折点（大）
  [ZX + ZW, ZY + ZL, true],// 右下端点
];

const icon = png(S, S, (x, y) => {
  // 圆角方块
  const qx = Math.max(Math.abs(x - cx) - (cx - R), 0);
  const qy = Math.max(Math.abs(y - cy) - (cy - R), 0);
  const inside = qx * qx + qy * qy <= R * R;
  if (!inside) return [0, 0, 0, 0];
  // 径向渐变背景（深藏蓝 → 深蓝黑）
  const d = Math.hypot(x - cx, y - cy) / (S / 2);
  const t = Math.min(1, d * 0.85);
  const bg = [
    Math.round(10 + (6 - 10) * t),
    Math.round(22 + (15 - 22) * t),
    Math.round(40 + (30 - 40) * t),
  ];
  // 电光蓝光晕（左下折点发光）
  const n2 = NODES[1];
  const dN = Math.hypot(x - n2[0], y - n2[1]);
  if (dN < GLOW_R) {
    const glow = 1 - dN / GLOW_R;
    return [
      Math.round(bg[0] + (BLUE[0] - bg[0]) * glow * 0.55),
      Math.round(bg[1] + (BLUE[1] - bg[1]) * glow * 0.55),
      Math.round(bg[2] + (BLUE[2] - bg[2]) * glow * 0.6),
      255,
    ];
  }
  // Z 线条（白色）
  for (const [x1, y1, x2, y2] of SEGS) {
    if (segDist(x, y, x1, y1, x2, y2) <= HALF) return [...WHITE, 255];
  }
  // 节点（电光蓝，白描边）
  for (const [nx, ny] of NODES) {
    const dd = Math.hypot(x - nx, y - ny);
    if (dd <= NODE_R) {
      const edge = Math.abs(dd - NODE_R);
      if (edge <= 5) return [...WHITE, 255];
      return [...LBLUE, 255];
    }
  }
  return [...bg, 255];
});

fs.writeFileSync(path.join(outDir, 'icon.png'), icon);

// 托盘 template：18x18 白色 Z（template 用黑/白）
const TS = 18;
const TSEGS = [[4, 5, 14, 5], [14, 5, 4, 13], [4, 13, 14, 13]];
const tray = png(TS, TS, (x, y) => {
  let min = 99;
  for (const [x1, y1, x2, y2] of TSEGS) min = Math.min(min, segDist(x, y, x1, y1, x2, y2));
  return min <= 2 ? [0, 0, 0, 255] : [0, 0, 0, 0];
});
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), tray);

console.log('DSH-Z icons generated');
