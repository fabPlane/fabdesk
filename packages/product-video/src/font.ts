/**
 * 5×7 bitmap font for caption cards. Each glyph is 7 row masks (5 bits, bit 0 = left).
 * Rows are stored separately so we never shift past JS's 32-bit bitwise width (5×7 = 35).
 */
type Glyph = readonly number[];

function g(...rows: string[]): Glyph {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (let y = 0; y < 7; y++) {
    const row = rows[y] ?? "";
    let bits = 0;
    for (let x = 0; x < 5; x++) if (row[x] === "#") bits |= 1 << x;
    out[y] = bits;
  }
  return out;
}

const EMPTY: Glyph = [0, 0, 0, 0, 0, 0, 0];

const GLYPHS: Record<string, Glyph> = {
  " ": EMPTY,
  "-": g("     ", "     ", "     ", " ### ", "     ", "     ", "     "),
  ".": g("     ", "     ", "     ", "     ", "     ", "     ", "  #  "),
  "/": g("    #", "   # ", "   # ", "  #  ", " #   ", " #   ", "#    "),
  ":": g("     ", "  #  ", "     ", "     ", "     ", "  #  ", "     "),
  "+": g("     ", "  #  ", "  #  ", "#####", "  #  ", "  #  ", "     "),
  "×": g("     ", "#   #", " # # ", "  #  ", " # # ", "#   #", "     "),
  "0": g(" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "),
  "1": g("  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "),
  "2": g(" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"),
  "3": g(" ### ", "#   #", "    #", "  ## ", "    #", "#   #", " ### "),
  "4": g("   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "),
  "5": g("#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "),
  "6": g(" ### ", "#    ", "#    ", "#### ", "#   #", "#   #", " ### "),
  "7": g("#####", "    #", "   # ", "  #  ", "  #  ", "  #  ", "  #  "),
  "8": g(" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "),
  "9": g(" ### ", "#   #", "#   #", " ####", "    #", "    #", " ### "),
  A: g(" ### ", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"),
  B: g("#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "),
  C: g(" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "),
  D: g("#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "),
  E: g("#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"),
  F: g("#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "),
  G: g(" ### ", "#   #", "#    ", "# ###", "#   #", "#   #", " ### "),
  H: g("#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"),
  I: g(" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "),
  J: g("  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "),
  K: g("#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"),
  L: g("#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"),
  M: g("#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"),
  N: g("#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"),
  O: g(" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "),
  P: g("#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "),
  Q: g(" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"),
  R: g("#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"),
  S: g(" ### ", "#   #", "#    ", " ### ", "    #", "#   #", " ### "),
  T: g("#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "),
  U: g("#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "),
  V: g("#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "),
  W: g("#   #", "#   #", "#   #", "# # #", "# # #", "## ##", "#   #"),
  X: g("#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"),
  Y: g("#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "),
  Z: g("#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"),
};

export function glyphBits(ch: string): Glyph {
  return GLYPHS[ch.toUpperCase()] ?? EMPTY;
}

export function measureText(text: string, scale: number): { width: number; height: number } {
  return { width: text.length * (5 * scale + scale), height: 7 * scale };
}

export function drawText(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  text: string,
  x0: number,
  y0: number,
  scale: number,
  rgba: [number, number, number, number],
): void {
  let x = Math.round(x0);
  const y = Math.round(y0);
  for (const ch of text) {
    const rows = glyphBits(ch);
    for (let gy = 0; gy < 7; gy++) {
      const bits = rows[gy] ?? 0;
      for (let gx = 0; gx < 5; gx++) {
        if (((bits >> gx) & 1) === 0) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = x + gx * scale + dx;
            const py = y + gy * scale + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const i = (py * width + px) * 4;
            data[i] = rgba[0];
            data[i + 1] = rgba[1];
            data[i + 2] = rgba[2];
            data[i + 3] = rgba[3];
          }
        }
      }
    }
    x += 5 * scale + scale;
  }
}

export function fillRect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * width + px) * 4;
      data[i] = rgba[0];
      data[i + 1] = rgba[1];
      data[i + 2] = rgba[2];
      data[i + 3] = rgba[3];
    }
  }
}

export function blendRect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: [number, number, number, number],
): void {
  const a = rgba[3] / 255;
  if (a <= 0) return;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const i = (py * width + px) * 4;
      data[i] = Math.round((data[i] ?? 0) * (1 - a) + rgba[0] * a);
      data[i + 1] = Math.round((data[i + 1] ?? 0) * (1 - a) + rgba[1] * a);
      data[i + 2] = Math.round((data[i + 2] ?? 0) * (1 - a) + rgba[2] * a);
      data[i + 3] = 255;
    }
  }
}
