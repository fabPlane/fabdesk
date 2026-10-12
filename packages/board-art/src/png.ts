import { inflateSync, deflateSync } from "node:zlib";
import type { RgbaImage } from "./types";

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  while (pos + 12 <= bytes.length) {
    const len = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4] ?? 0, bytes[pos + 5] ?? 0, bytes[pos + 6] ?? 0, bytes[pos + 7] ?? 0);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      if (data[10] !== 0 || data[12] !== 0) throw new Error("unsupported PNG compression/interlace");
      if (bitDepth !== 8) throw new Error("only 8-bit PNG is supported");
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (width < 1 || height < 1) throw new Error("invalid PNG size");
  const compressed = concat(idat);
  const raw = new Uint8Array(inflateSync(compressed));
  const bpp = bytesPerPixel(colorType);
  const stride = width * bpp;
  const rows: Uint8Array[] = [];
  let off = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[off] ?? 0;
    const row = raw.subarray(off + 1, off + 1 + stride);
    off += 1 + stride;
    const recon = unfilter(filter, row, prev, bpp);
    rows.push(recon);
    prev = new Uint8Array(recon);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < width; x++) writeRgba(rgba, (y * width + x) * 4, row, x * bpp, colorType, palette);
  }
  return { width, height, data: rgba };
}

export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunks = [PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  return concat(chunks);
}

function bytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`unsupported PNG color type ${colorType}`);
  }
}

function writeRgba(
  out: Uint8Array,
  dest: number,
  row: Uint8Array,
  src: number,
  colorType: number,
  palette: Uint8Array | undefined,
): void {
  if (colorType === 6) {
    out[dest] = row[src] ?? 0;
    out[dest + 1] = row[src + 1] ?? 0;
    out[dest + 2] = row[src + 2] ?? 0;
    out[dest + 3] = row[src + 3] ?? 255;
    return;
  }
  if (colorType === 2) {
    out[dest] = row[src] ?? 0;
    out[dest + 1] = row[src + 1] ?? 0;
    out[dest + 2] = row[src + 2] ?? 0;
    out[dest + 3] = 255;
    return;
  }
  if (colorType === 0) {
    const v = row[src] ?? 0;
    out[dest] = v;
    out[dest + 1] = v;
    out[dest + 2] = v;
    out[dest + 3] = 255;
    return;
  }
  if (colorType === 4) {
    const v = row[src] ?? 0;
    out[dest] = v;
    out[dest + 1] = v;
    out[dest + 2] = v;
    out[dest + 3] = row[src + 1] ?? 255;
    return;
  }
  const idx = (row[src] ?? 0) * 3;
  out[dest] = palette?.[idx] ?? 0;
  out[dest + 1] = palette?.[idx + 1] ?? 0;
  out[dest + 2] = palette?.[idx + 2] ?? 0;
  out[dest + 3] = 255;
}

function unfilter(filter: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? (out[i - bpp] ?? 0) : 0;
    const b = prev[i] ?? 0;
    const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
    const x = row[i] ?? 0;
    let v = x;
    if (filter === 1) v = x + a;
    else if (filter === 2) v = x + b;
    else if (filter === 3) v = x + ((a + b) >> 1);
    else if (filter === 4) v = x + paeth(a, b, c);
    else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    out[i] = v & 255;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crcSrc = out.subarray(4, 8 + data.length);
  writeU32(out, 8 + data.length, crc32(crcSrc));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function readU32(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
}

function writeU32(b: Uint8Array, i: number, v: number): void {
  b[i] = (v >>> 24) & 255;
  b[i + 1] = (v >>> 16) & 255;
  b[i + 2] = (v >>> 8) & 255;
  b[i + 3] = v & 255;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = (CRC_TABLE[(crc ^ (data[i] ?? 0)) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
