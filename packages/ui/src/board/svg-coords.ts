/** SVG viewBox helpers for board pins. */

export type SvgBox = { x: number; y: number; width: number; height: number };
export type SvgPoint = { x: number; y: number };

export function parseSvgViewBox(svg: string): SvgBox | null {
  const match = svg.match(
    /viewBox=["']\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*["']/,
  );
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const width = Number(match[3]);
  const height = Number(match[4]);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function clientPointToSvg(
  box: SvgBox,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): SvgPoint | null {
  if (!rect.width || !rect.height) return null;
  return {
    x: box.x + ((clientX - rect.left) / rect.width) * box.width,
    y: box.y + ((clientY - rect.top) / rect.height) * box.height,
  };
}

export function svgPointToPercent(box: SvgBox, point: SvgPoint): { left: number; top: number } | null {
  if (!box.width || !box.height) return null;
  return {
    left: ((point.x - box.x) / box.width) * 100,
    top: ((point.y - box.y) / box.height) * 100,
  };
}
