export type OpeningShape = "rectangle" | "rounded";
export type ProfilePoint = [number, number];

/** Counterclockwise wall-face contour, centred at zero. Curves have <= 0.01 mm chord error. */
export function openingContour(
  width: number,
  height: number,
  shape: OpeningShape = "rectangle",
): ProfilePoint[] {
  const x = width / 2,
    y = height / 2;
  if (shape === "rectangle")
    return [
      [-x, -y],
      [x, -y],
      [x, y],
      [-x, y],
    ];
  const r = Math.min(x, y);
  const steps = Math.max(12, Math.ceil(Math.PI / (4 * Math.acos(Math.max(-1, 1 - 0.01 / r)))));
  const points: ProfilePoint[] = [];
  for (const [cx, cy, start] of [
    [x - r, y - r, 0],
    [-x + r, y - r, 90],
    [-x + r, -y + r, 180],
    [x - r, -y + r, 270],
  ]) {
    for (let i = 0; i <= steps; i++) {
      const a = ((start! + (i * 90) / steps) * Math.PI) / 180;
      const p: ProfilePoint = [cx! + r * Math.cos(a), cy! + r * Math.sin(a)];
      const last = points.at(-1);
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) points.push(p);
    }
  }
  if (Math.hypot(points[0]![0] - points.at(-1)![0], points[0]![1] - points.at(-1)![1]) < 1e-9)
    points.pop();
  return points;
}

/** Both profiles are convex; testing every required contour vertex catches clipped corners. */
export function openingContains(
  actual: { width: number; height: number; shape?: OpeningShape | undefined },
  required: { width: number; height: number; shape?: OpeningShape | undefined },
  offsetX = 0,
  offsetY = 0,
): boolean {
  const outer = openingContour(actual.width, actual.height, actual.shape);
  return openingContour(required.width, required.height, required.shape).every(([x, y]) =>
    outer.every((a, i) => {
      const b = outer[(i + 1) % outer.length]!;
      return (b[0] - a[0]) * (y + offsetY - a[1]) - (b[1] - a[1]) * (x + offsetX - a[0]) >= -1e-7;
    }),
  );
}
