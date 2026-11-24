import type { PhotoOutline } from "@fabdesk/protocol";

export type BinaryMask = {
  width: number;
  height: number;
  /** 1 = board, 0 = background. */
  pixels: Uint8Array;
};

/**
 * Fit a simplified polygon to the largest foreground blob in a binary silhouette.
 * Coordinates are in pixel space unless `mmPerPx` is given.
 */
export function fitOutlineFromMask(mask: BinaryMask, mmPerPx = 1, epsilonPx = 1.5): PhotoOutline {
  const blob = largestBlob(mask);
  if (!blob) {
    return {
      polygon: [
        { x: 0, y: 0 },
        { x: mask.width * mmPerPx, y: 0 },
        { x: mask.width * mmPerPx, y: mask.height * mmPerPx },
        { x: 0, y: mask.height * mmPerPx },
      ],
      source: "bbox",
    };
  }
  const ring = traceContour(mask, blob.seed);
  const simplified = ramerDouglasPeucker(ring, epsilonPx);
  const closed = simplified.length >= 3 ? simplified : boundingBox(blob);
  return {
    polygon: closed.map((p) => ({ x: round1(p.x * mmPerPx), y: round1(p.y * mmPerPx) })),
    source: "silhouette",
  };
}

/** Threshold a grayscale buffer (0=black) into a board mask. Darker than `cut` is board. */
export function maskFromGray(
  width: number,
  height: number,
  pixels: Uint8Array,
  cut = 200,
): BinaryMask {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = (pixels[i] ?? 255) < cut ? 1 : 0;
  return { width, height, pixels: out };
}

function largestBlob(mask: BinaryMask): { seed: { x: number; y: number }; area: number } | null {
  const seen = new Uint8Array(mask.pixels.length);
  let best: { seed: { x: number; y: number }; area: number } | null = null;
  const { width, height, pixels } = mask;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!pixels[i] || seen[i]) continue;
      const area = flood(mask, seen, x, y);
      if (!best || area > best.area) best = { seed: { x, y }, area };
    }
  }
  return best;
}

function flood(mask: BinaryMask, seen: Uint8Array, sx: number, sy: number): number {
  const stack = [sx, sy];
  let area = 0;
  const { width, height, pixels } = mask;
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const i = y * width + x;
    if (seen[i] || !pixels[i]) continue;
    seen[i] = 1;
    area += 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  return area;
}

/** Moore-neighborhood contour walk starting at a foreground pixel. */
function traceContour(mask: BinaryMask, seed: { x: number; y: number }): Array<{ x: number; y: number }> {
  const start = leftmostOnBlob(mask, seed);
  const dirs = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ] as const;
  const points: Array<{ x: number; y: number }> = [];
  let x = start.x;
  let y = start.y;
  let dir = 6;
  const key = (px: number, py: number, d: number) => `${px},${py},${d}`;
  const seen = new Set<string>();
  for (let n = 0; n < mask.width * mask.height; n++) {
    points.push({ x, y });
    const mark = key(x, y, dir);
    if (seen.has(mark) && points.length > 3) break;
    seen.add(mark);
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (dir + 6 + k) % 8;
      const nx = x + dirs[nd]![0];
      const ny = y + dirs[nd]![1];
      if (isOn(mask, nx, ny)) {
        x = nx;
        y = ny;
        dir = nd;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (x === start.x && y === start.y && points.length > 3) break;
  }
  return points;
}

function leftmostOnBlob(mask: BinaryMask, seed: { x: number; y: number }): { x: number; y: number } {
  let x = seed.x;
  const y = seed.y;
  while (isOn(mask, x - 1, y)) x -= 1;
  return { x, y };
}

function isOn(mask: BinaryMask, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.pixels[y * mask.width + x] === 1;
}

function boundingBox(blob: { seed: { x: number; y: number } }): Array<{ x: number; y: number }> {
  const { x, y } = blob.seed;
  return [
    { x, y },
    { x: x + 1, y },
    { x: x + 1, y: y + 1 },
    { x, y: y + 1 },
  ];
}

export function ramerDouglasPeucker(
  points: Array<{ x: number; y: number }>,
  epsilon: number,
): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points.slice();
  let maxDist = 0;
  let index = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i]!, first, last);
    if (d > maxDist) {
      index = i;
      maxDist = d;
    }
  }
  if (maxDist > epsilon) {
    const left = ramerDouglasPeucker(points.slice(0, index + 1), epsilon);
    const right = ramerDouglasPeucker(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function perpDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
