import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const ss = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = ss * ss;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const U = 18;
const dist = (x, y) => Math.hypot(x * U - U / 2, y * U - U / 2);
const ring = (d, r, w) => Math.abs(d - r) <= w / 2;
const black = (on) => [0, 0, 0, on ? 1 : 0];

const trayShapes = {
  idle: (x, y) => {
    const d = dist(x, y);
    return black(ring(d, 6.6, 1.5) || d <= 2.6);
  },
  speaking: (x, y) => {
    const d = dist(x, y);
    return black(ring(d, 7.4, 1.3) || d <= 4.6);
  },
  muted: (x, y) => {
    const d = dist(x, y);
    const px = x * U - U / 2;
    const py = y * U - U / 2;
    const slash = Math.abs(px + py) / Math.SQRT2 <= 0.9 && d <= 8.2;
    const gap = Math.abs(px + py) / Math.SQRT2 <= 2.1;
    return black(slash || (!gap && ring(d, 6.6, 1.5)));
  },
};

mkdirSync("assets", { recursive: true });
for (const [name, shape] of Object.entries(trayShapes)) {
  const base = name === "idle" ? "trayTemplate" : `tray-${name}Template`;
  writeFileSync(`assets/${base}.png`, png(18, shape));
  writeFileSync(`assets/${base}@2x.png`, png(36, shape));
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function appIcon(x, y) {
  const cx = x - 0.5;
  const cy = y - 0.5;
  const d = Math.hypot(cx, cy);
  const bg = d <= 0.5 ? mix([22, 24, 36], [10, 11, 18], d * 2) : null;
  if (d > 0.5) return [0, 0, 0, 0];
  const r = 0.3;
  if (d <= r) {
    const t = Math.min(1, Math.max(0, (x - 0.2 + (y - 0.2)) / 1.2));
    let c = mix([124, 242, 212], [111, 140, 255], t);
    const v = Math.hypot(x - 0.65, y - 0.7);
    c = mix([185, 140, 255], c, Math.min(1, v / 0.25));
    const hl = Math.max(0, 1 - Math.hypot(x - 0.4, y - 0.38) / 0.12);
    c = mix(c, [255, 255, 255], hl * 0.85);
    return [...c, 1];
  }
  const glow = Math.max(0, 1 - (d - r) / 0.16);
  return [...mix(bg, [124, 242, 212], glow * 0.45), 1];
}

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", png(1024, appIcon));
console.log("icons written");
