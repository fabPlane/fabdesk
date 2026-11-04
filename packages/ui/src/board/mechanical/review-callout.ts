export type ReviewPoint = { x: number; y: number };
export type ReviewRect = ReviewPoint & { width: number; height: number };

type CalloutInput = {
  target: ReviewPoint;
  viewport: { width: number; height: number };
  label: { width: number; height: number };
  obstacles?: readonly ReviewRect[];
  margin?: number;
  gap?: number;
};

export type ReviewCallout = {
  label: ReviewRect;
  /** The actual projected point. Never clamp this to another part of the scene. */
  target: ReviewPoint;
  /** A point on the label edge for the other end of a straight SVG leader. */
  anchor: ReviewPoint;
};

const finite = (...values: number[]) => values.every(Number.isFinite);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const contains = (rect: ReviewRect, point: ReviewPoint) =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.width &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.height;

function overlaps(a: ReviewRect, b: ReviewRect, padding: number) {
  return (
    a.x < b.x + b.width + padding &&
    a.x + a.width > b.x - padding &&
    a.y < b.y + b.height + padding &&
    a.y + a.height > b.y - padding
  );
}

/** Slab intersection includes edge contact: a leader must not run through a control. */
function crosses(from: ReviewPoint, to: ReviewPoint, rect: ReviewRect) {
  let start = 0;
  let end = 1;
  for (const [origin, delta, min, max] of [
    [from.x, to.x - from.x, rect.x, rect.x + rect.width],
    [from.y, to.y - from.y, rect.y, rect.y + rect.height],
  ] as const) {
    if (delta === 0) {
      if (origin < min || origin > max) return false;
    } else {
      const a = (min - origin) / delta;
      const b = (max - origin) / delta;
      start = Math.max(start, Math.min(a, b));
      end = Math.min(end, Math.max(a, b));
      if (start > end) return false;
    }
  }
  return true;
}

function edgeAnchor(target: ReviewPoint, label: ReviewRect): ReviewPoint {
  // Keep the connector away from rounded corners so it meets the visible border.
  const inset = Math.min(8, label.width / 2, label.height / 2);
  const x = clamp(target.x, label.x + inset, label.x + label.width - inset);
  const y = clamp(target.y, label.y + inset, label.y + label.height - inset);
  const points = [
    { x: label.x, y },
    { x: label.x + label.width, y },
    { x, y: label.y },
    { x, y: label.y + label.height },
  ];
  return points.reduce((best, point) =>
    Math.hypot(point.x - target.x, point.y - target.y) <
    Math.hypot(best.x - target.x, best.y - target.y)
      ? point
      : best,
  );
}

/**
 * Place a label in free canvas space and retain a leader to the exact projected part.
 * All inputs and outputs are canvas-local CSS pixels, including occupied UI rectangles.
 * A hidden/offscreen target or a crowded viewport returns null rather than a misleading pin.
 */
export function placeReviewCallout({
  target,
  viewport,
  label: size,
  obstacles = [],
  margin = 12,
  gap = 24,
}: CalloutInput): ReviewCallout | null {
  if (
    !finite(
      target.x,
      target.y,
      viewport.width,
      viewport.height,
      size.width,
      size.height,
      margin,
      gap,
    ) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    size.width <= 0 ||
    size.height <= 0 ||
    margin < 0 ||
    gap < 0 ||
    viewport.width < size.width + margin * 2 ||
    viewport.height < size.height + margin * 2 ||
    !contains({ x: 0, y: 0, ...viewport }, target)
  )
    return null;

  const occupied = obstacles.filter(
    (rect) => finite(rect.x, rect.y, rect.width, rect.height) && rect.width > 0 && rect.height > 0,
  );
  if (occupied.some((rect) => contains(rect, target))) return null;

  const maxX = viewport.width - margin - size.width;
  const maxY = viewport.height - margin - size.height;
  // Rectangle edges and the preferred placements form a small, deterministic candidate set.
  // Trying both axes lets the label escape a sidebar without changing the target position.
  const xs = [
    target.x + gap,
    target.x - gap - size.width,
    target.x - size.width / 2,
    margin,
    maxX,
    ...occupied.flatMap((rect) => [rect.x - margin - size.width, rect.x + rect.width + margin]),
  ];
  const ys = [
    target.y - size.height / 2,
    target.y - gap - size.height,
    target.y + gap,
    margin,
    maxY,
    ...occupied.flatMap((rect) => [rect.y - margin - size.height, rect.y + rect.height + margin]),
  ];
  let best: ReviewCallout | null = null;
  let distance = Infinity;
  for (const x of new Set(xs.map((value) => clamp(value, margin, maxX))))
    for (const y of new Set(ys.map((value) => clamp(value, margin, maxY)))) {
      const label = { x, y, ...size };
      if (occupied.some((rect) => overlaps(label, rect, margin))) continue;
      const nearestX = clamp(target.x, x, x + size.width);
      const nearestY = clamp(target.y, y, y + size.height);
      if (contains(label, target) || Math.hypot(nearestX - target.x, nearestY - target.y) < gap)
        continue;
      const anchor = edgeAnchor(target, label);
      if (occupied.some((rect) => crosses(target, anchor, rect))) continue;
      const length = Math.hypot(anchor.x - target.x, anchor.y - target.y);
      if (length < distance) {
        distance = length;
        best = { label, target: { ...target }, anchor };
      }
    }
  return best;
}
