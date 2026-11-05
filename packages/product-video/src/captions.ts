import { blendRect, drawText, fillRect, measureText } from "./font";
import type { FramePose, PixelBuffer, ProductSpecs } from "./types";

const TITLE: [number, number, number, number] = [248, 246, 240, 255];
const INK: [number, number, number, number] = [22, 24, 28, 255];
const MUTED: [number, number, number, number] = [70, 74, 80, 255];
const DARK: [number, number, number, number] = [16, 18, 22, 230];
const LIGHT_INK: [number, number, number, number] = [244, 241, 234, 255];

/** Keep exported captions inside the frame, including long imported project names. */
function fitCaption(value: string, maxWidth: number, preferredScale: number): { text: string; scale: number; width: number; height: number } {
  let text = value.toUpperCase();
  const unitWidth = measureText(text, 1).width;
  const scale = Math.max(1, Math.min(preferredScale, Math.floor(maxWidth / Math.max(1, unitWidth))));
  const capacity = Math.max(0, Math.floor(maxWidth / measureText("M", scale).width));
  if (text.length > capacity) text = capacity > 3 ? `${text.slice(0, capacity - 3)}...` : ".".repeat(capacity);
  return { text, scale, ...measureText(text, scale) };
}

export function paintCaptions(buf: PixelBuffer, pose: FramePose, specs: ProductSpecs): void {
  if (pose.cardKind === "none" || pose.card <= 0) {
    paintLowerThird(buf, specs.name);
    return;
  }
  const alpha = Math.round(255 * pose.card);
  fillRect(buf.data, buf.width, buf.height, 0, 0, buf.width, buf.height, [16, 18, 22, alpha]);
  if (pose.cardKind === "title") {
    const { text, scale, width } = fitCaption(specs.name, buf.width - 64, buf.width >= 1000 ? 5 : 3);
    drawText(
      buf.data,
      buf.width,
      buf.height,
      text,
      (buf.width - width) / 2,
      buf.height * 0.42,
      scale,
      TITLE,
    );
    const sub = fitCaption("PRODUCT VIDEO", buf.width - 64, Math.max(2, scale - 2));
    drawText(buf.data, buf.width, buf.height, sub.text, (buf.width - sub.width) / 2, buf.height * 0.42 + 7 * scale + 16, sub.scale, MUTED);
    return;
  }
  const preferredScale = buf.width >= 1000 ? 4 : 3;
  const { text, scale, width: titleW } = fitCaption(specs.name, buf.width - 64, preferredScale);
  drawText(buf.data, buf.width, buf.height, text, (buf.width - titleW) / 2, buf.height * 0.28, scale, TITLE);
  let y = buf.height * 0.28 + 7 * scale + 24;
  const lineScale = Math.max(2, preferredScale - 1);
  for (const line of specs.lines.slice(0, 6)) {
    const fitted = fitCaption(line, buf.width - 64, lineScale);
    drawText(buf.data, buf.width, buf.height, fitted.text, (buf.width - fitted.width) / 2, y, fitted.scale, LIGHT_INK);
    y += 7 * lineScale + 10;
  }
}

function paintLowerThird(buf: PixelBuffer, name: string): void {
  if (!name) return;
  const pad = 16;
  const { text, scale, width, height } = fitCaption(name, buf.width - pad * 2 - 10, buf.width >= 1000 ? 3 : 2);
  const x = pad;
  const y = buf.height - height - pad * 2;
  blendRect(buf.data, buf.width, buf.height, x - 10, y - 10, width + 20, height + 20, DARK);
  drawText(buf.data, buf.width, buf.height, text, x, y, scale, TITLE);
}

export function paintSolidCard(buf: PixelBuffer, specs: ProductSpecs, kind: "title" | "specs"): void {
  paintCaptions(buf, { camera: { eye: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 }, fovY: 1 }, explode: 0, card: 1, cardKind: kind }, specs);
}
