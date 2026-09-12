/**
 * QR code for the pairing payload, as an inline SVG.
 *
 * `qrcode-generator` ships its own SVG output but it is fixed-size and light-only; the pairing
 * dialog wants something that scales to its box and survives a dark theme, so the modules are
 * walked directly. The input is always a `fabdesk://pair?…` URL this app just built, never
 * anything from outside.
 */
import qrcode from "qrcode-generator";

/** Modules of quiet zone the QR spec asks for around the symbol. */
const QUIET = 4;

export function qrSvg(text: string): string {
  // Type 0 = pick the smallest version that fits; "M" tolerates a phone camera at an angle.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + QUIET * 2;
  const path: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path.push(`M${col + QUIET} ${row + QUIET}h1v1h-1z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<path d="${path.join("")}" fill="#000"/>`,
    `</svg>`,
  ].join("");
}
