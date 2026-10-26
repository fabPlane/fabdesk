import type { PixelBuffer } from "./types";

const CLEAR = 256;
const EOI = 257;

function quantize(data: Uint8ClampedArray): { index: Uint8Array; palette: Uint8Array } {
  // 6-level RGB cube (216 colours) plus a reserved transparent slot at 0 when alpha is low.
  const index = new Uint8Array(data.length / 4);
  const palette = new Uint8Array(256 * 3);
  let slot = 1;
  const map = new Map<number, number>();
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const a = data[i + 3] ?? 255;
    if (a < 16) {
      index[p] = 0;
      continue;
    }
    const r = Math.round((data[i] ?? 0) / 51) * 51;
    const g = Math.round((data[i + 1] ?? 0) / 51) * 51;
    const b = Math.round((data[i + 2] ?? 0) / 51) * 51;
    const key = (r << 16) | (g << 8) | b;
    let idx = map.get(key);
    if (idx === undefined) {
      if (slot > 255) idx = 1;
      else {
        idx = slot++;
        palette[idx * 3] = r;
        palette[idx * 3 + 1] = g;
        palette[idx * 3 + 2] = b;
        map.set(key, idx);
      }
    }
    index[p] = idx;
  }
  return { index, palette };
}

function lzw(indices: Uint8Array, minCode: number): Uint8Array {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let next = eoi + 1;
  const dict = new Map<string, number>();
  const reset = () => {
    dict.clear();
    codeSize = minCode + 1;
    next = eoi + 1;
  };
  reset();
  const bits: number[] = [];
  let acc = 0;
  let nbits = 0;
  const emit = (code: number) => {
    acc |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) {
      bits.push(acc & 255);
      acc >>= 8;
      nbits -= 8;
    }
  };
  emit(clear);
  let w = String(indices[0] ?? 0);
  for (let i = 1; i < indices.length; i++) {
    const k = String(indices[i] ?? 0);
    const wk = `${w},${k}`;
    if (dict.has(wk)) w = wk;
    else {
      emit(w.includes(",") ? (dict.get(w) ?? 0) : Number(w));
      if (next < 4096) {
        dict.set(wk, next++);
        // Delay the width bump by one code so a decoder that installs entry N
        // at the current size is still reading that size when N === 2^codeSize.
        if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      } else {
        emit(clear);
        reset();
      }
      w = k;
    }
  }
  emit(w.includes(",") ? (dict.get(w) ?? 0) : Number(w));
  emit(eoi);
  if (nbits) bits.push(acc & 255);
  void CLEAR;
  void EOI;
  return Uint8Array.from(bits);
}

function subblocks(data: Uint8Array): Uint8Array {
  const chunks: number[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const n = Math.min(255, data.length - i);
    chunks.push(n);
    for (let j = 0; j < n; j++) chunks.push(data[i + j]!);
  }
  chunks.push(0);
  return Uint8Array.from(chunks);
}

/** Stream frames into a looping GIF89a. `delayCs` is centiseconds per frame. */
export class GifEncoder {
  private readonly parts: Uint8Array[] = [];
  private started = false;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly delayCs: number,
    private readonly transparent: boolean,
  ) {}

  addFrame(frame: PixelBuffer): void {
    if (frame.width !== this.width || frame.height !== this.height) {
      throw new Error(`GIF frame size ${frame.width}x${frame.height} does not match ${this.width}x${this.height}`);
    }
    if (!this.started) {
      this.started = true;
      const header = new Uint8Array(13);
      header.set(new TextEncoder().encode("GIF89a"));
      const hv = new DataView(header.buffer);
      hv.setUint16(6, this.width, true);
      hv.setUint16(8, this.height, true);
      header[10] = 0x80 | 0x70 | 7; // global table, 8-bit
      header[11] = 0;
      header[12] = 0;
      this.parts.push(header);
      this.parts.push(quantize(frame.data).palette);
      this.parts.push(Uint8Array.of(0x21, 0xff, 0x0b, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 0x03, 0x01, 0, 0, 0));
    }
    const q = quantize(frame.data);
    const gce = new Uint8Array(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 4;
    gce[3] = this.transparent ? 0x01 : 0x00;
    new DataView(gce.buffer).setUint16(4, this.delayCs, true);
    gce[6] = this.transparent ? 0 : 0;
    gce[7] = 0;
    this.parts.push(gce);
    const desc = new Uint8Array(10);
    desc[0] = 0x2c;
    const dv = new DataView(desc.buffer);
    dv.setUint16(1, 0, true);
    dv.setUint16(3, 0, true);
    dv.setUint16(5, this.width, true);
    dv.setUint16(7, this.height, true);
    desc[9] = 0x80 | 7; // local colour table, 256 entries
    this.parts.push(desc);
    this.parts.push(q.palette);
    this.parts.push(Uint8Array.of(8));
    this.parts.push(subblocks(lzw(q.index, 8)));
  }

  finish(): Uint8Array {
    if (!this.started) throw new Error("no frames to encode");
    this.parts.push(Uint8Array.of(0x3b));
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Encode frames as a looping GIF89a. `delayCs` is centiseconds per frame. */
export function encodeGif(frames: PixelBuffer[], delayCs: number, transparent: boolean): Uint8Array {
  if (!frames.length) throw new Error("no frames to encode");
  const enc = new GifEncoder(frames[0]!.width, frames[0]!.height, delayCs, transparent);
  for (const frame of frames) enc.addFrame(frame);
  return enc.finish();
}
