// Draws the extension icons (icons/icon16|48|128.png): the Watch Tracker mark, three bars on a verdigris rounded square,
// the same shape as .mark in lib/theme.css. No dependencies and fully deterministic (same bytes every run).
//   node tools/make-icons.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BG = [10, 107, 98], FG = [255, 255, 255]; // --accent #0a6b62 on --accent-ink
const SS = 4; // supersampling per axis, for smooth edges at 16 px

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// Is (x, y) inside a rounded rectangle? Coordinates are fractions of the icon size.
const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x, cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
function draw(size) {
  const pad = 0.2, inner = 1 - 2 * pad, gap = 0.07, bw = (inner - 2 * gap) / 3, heights = [0.45, 1, 0.7], bottom = 1 - pad;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let pxl = 0; pxl < size; pxl++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (pxl + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
      if (!inRound(x, y, 0, 0, 1, 1, 0.22)) continue;
      bg++;
      for (let i = 0; i < 3; i++) { const x0 = pad + i * (bw + gap); if (inRound(x, y, x0, bottom - heights[i] * inner, x0 + bw, bottom, Math.min(0.04, bw / 2))) { fg++; break; } }
    }
    const n = SS * SS, a = bg / n, f = bg ? fg / bg : 0, o = (py * size + pxl) * 4;
    for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - f) + FG[c] * f);
    px[o + 3] = Math.round(a * 255);
  }
  return png(size, px);
}

for (const size of [16, 48, 128]) fs.writeFileSync(path.join(ROOT, "icons", `icon${size}.png`), draw(size));
console.log("wrote icons/icon16.png, icon48.png, icon128.png");
