import { blendRect, drawText, fillRect, measureText } from "./font";
import type { FramePose, PixelBuffer, ProductSpecs } from "./types";

const TITLE: [number, number, number, number] = [248, 246, 240, 255];
const INK: [number, number, number, number] = [22, 24, 28, 255];
const MUTED: [number, number, number, number] = [70, 74, 80, 255];
const DARK: [number, number, number, number] = [16, 18, 22, 230];
const LIGHT_INK: [number, number, number, number] = [244, 241, 234, 255];

export function paintCaptions(buf: PixelBuffer, pose: FramePose, specs: ProductSpecs): void {
  if (pose.cardKind === "none" || pose.card <= 0) {
    paintLowerThird(buf, specs.name);
    return;
  }
  const alpha = Math.round(255 * pose.card);
  fillRect(buf.data, buf.width, buf.height, 0, 0, buf.width, buf.height, [16, 18, 22, alpha]);
  if (pose.cardKind === "title") {
    const scale = buf.width >= 1000 ? 5 : 3;
    const { width } = measureText(specs.name.toUpperCase(), scale);
    drawText(
      buf.data,
      buf.width,
      buf.height,
      specs.name.toUpperCase(),
      (buf.width - width) / 2,
      buf.height * 0.42,
      scale,
      TITLE,
    );
    const sub = "PRODUCT VIDEO";
    const subScale = Math.max(2, scale - 2);
    const sw = measureText(sub, subScale).width;
    drawText(buf.data, buf.width, buf.height, sub, (buf.width - sw) / 2, buf.height * 0.42 + 7 * scale + 16, subScale, MUTED);
    return;
  }
  const scale = buf.width >= 1000 ? 4 : 3;
  const titleW = measureText(specs.name.toUpperCase(), scale).width;
  drawText(buf.data, buf.width, buf.height, specs.name.toUpperCase(), (buf.width - titleW) / 2, buf.height * 0.28, scale, TITLE);
  let y = buf.height * 0.28 + 7 * scale + 24;
  const lineScale = Math.max(2, scale - 1);
  for (const line of specs.lines.slice(0, 6)) {
    const w = measureText(line.toUpperCase(), lineScale).width;
    drawText(buf.data, buf.width, buf.height, line.toUpperCase(), (buf.width - w) / 2, y, lineScale, LIGHT_INK);
    y += 7 * lineScale + 10;
  }
}

function paintLowerThird(buf: PixelBuffer, name: string): void {
  if (!name) return;
  const scale = buf.width >= 1000 ? 3 : 2;
  const pad = 16;
  const { width, height } = measureText(name.toUpperCase(), scale);
  const x = pad;
  const y = buf.height - height - pad * 2;
  blendRect(buf.data, buf.width, buf.height, x - 10, y - 10, width + 20, height + 20, DARK);
  drawText(buf.data, buf.width, buf.height, name.toUpperCase(), x, y, scale, TITLE);
}

export function paintSolidCard(buf: PixelBuffer, specs: ProductSpecs, kind: "title" | "specs"): void {
  paintCaptions(buf, { camera: { eye: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fovY: 1 }, explode: 0, card: 1, cardKind: kind }, specs);
}
