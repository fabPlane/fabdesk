/**
 * QR codes for the pairing payload, shared by the desktop (inline SVG) and the daemon CLI
 * (half-block characters in a terminal). Pure: no DOM, no network, no native module.
 *
 * The modules come from `qrcode-generator` (dependency-free, ships with the desktop already);
 * this package owns the rendering, which that library does fixed-size and light-only. The input
 * is always a `fabdesk://pair?…` URL we just built, never anything from outside.
 */
import qrcode from "qrcode-generator";

/** Modules of quiet zone the QR spec asks for around the symbol. */
export const QUIET = 4;

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number;
  /** `true` is a dark module. Row-major, `modules[row][col]`. */
  modules: boolean[][];
}

/**
 * Type 0 = pick the smallest version that fits; error level "M" tolerates a phone camera at an
 * angle without doubling the symbol the way "H" would.
 */
export function qrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col++) line.push(qr.isDark(row, col));
    modules.push(line);
  }
  return { size, modules };
}

/** Scales to its box (`width="100%"`) and stays black-on-white whatever the theme, as scanners expect. */
export function qrSvg(text: string): string {
  const { size, modules } = qrMatrix(text);
  const box = size + QUIET * 2;
  const path: string[] = [];
  modules.forEach((line, row) =>
    line.forEach((dark, col) => {
      if (dark) path.push(`M${col + QUIET} ${row + QUIET}h1v1h-1z`);
    }),
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="100%" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">`,
    `<rect width="${box}" height="${box}" fill="#fff"/>`,
    `<path d="${path.join("")}" fill="#000"/>`,
    `</svg>`,
  ].join("");
}

/**
 * Two module rows per text line using the half-block characters, so a version-3 symbol fits in
 * ~20 lines. Light modules are drawn as blocks and dark ones left as the terminal background:
 * on the dark terminals people run, that gives the black-on-white polarity scanners like best,
 * and on a light one the symbol is inverted, which every current phone camera also reads.
 * `invert` swaps the two for a terminal known to be light. The quiet zone is drawn, not assumed.
 */
export function qrTerminal(text: string, opts: { invert?: boolean; quiet?: number } = {}): string {
  const { size, modules } = qrMatrix(text);
  const quiet = opts.quiet ?? 2;
  const box = size + quiet * 2;
  // `light(row, col)`: whether the cell shows as a block (a light module, in the default polarity).
  const light = (row: number, col: number): boolean => {
    const r = row - quiet;
    const c = col - quiet;
    const dark = r >= 0 && r < size && c >= 0 && c < size ? modules[r]![c]! : false;
    return opts.invert ? dark : !dark;
  };
  const lines: string[] = [];
  for (let row = 0; row < box; row += 2) {
    let line = "";
    for (let col = 0; col < box; col++) {
      const top = light(row, col);
      // An odd-height box ends on a half line; below it is the terminal's own background.
      const bottom = row + 1 < box ? light(row + 1, col) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
