/** Generates build/icon.png: a 512x512 rounded purple tile with a white "F". Placeholder until real artwork lands. */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "build", "icon.png");

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function inRoundedRect(x: number, y: number, r: number): boolean {
  const cx = Math.min(Math.max(x, r), SIZE - 1 - r);
  const cy = Math.min(Math.max(y, r), SIZE - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inGlyph(x: number, y: number): boolean {
  // Block "F": vertical stem plus two bars.
  const stem = x >= 176 && x < 236 && y >= 128 && y < 400;
  const top = x >= 176 && x < 356 && y >= 128 && y < 184;
  const mid = x >= 176 && x < 316 && y >= 240 && y < 292;
  return stem || top || mid;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = y * (SIZE * 4 + 1) + 1 + x * 4;
    if (!inRoundedRect(x, y, 96)) {
      raw.fill(0, i, i + 4);
      continue;
    }
    const t = y / SIZE;
    const [r, g, b] = inGlyph(x, y) ? [255, 255, 255] : [Math.round(124 - 30 * t), Math.round(58 + 20 * t), Math.round(237 - 40 * t)];
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = 255;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", new Uint8Array(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
