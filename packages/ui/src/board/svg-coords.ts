import { commentMillimetrePoint, type CommentAnchor } from "@fabdesk/protocol";

/** SVG viewBox helpers for board pins. */

export type SvgBox = { x: number; y: number; width: number; height: number };
export type SvgPoint = { x: number; y: number };
type ClientBox = { left: number; top: number; width: number; height: number };

/** Keyboard selection targets the visible drawing, never an off-screen sheet center. */
export function visibleSvgCenter(box: SvgBox, drawing: ClientBox, viewport: ClientBox): SvgPoint | null {
  if (![...Object.values(drawing), ...Object.values(viewport)].every(Number.isFinite) || drawing.width <= 0 || drawing.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const left = Math.max(drawing.left, viewport.left), top = Math.max(drawing.top, viewport.top);
  const right = Math.min(drawing.left + drawing.width, viewport.left + viewport.width);
  const bottom = Math.min(drawing.top + drawing.height, viewport.top + viewport.height);
  if (right <= left || bottom <= top) return null;
  return clientPointToSvg(box, drawing, (left + right) / 2, (top + bottom) / 2);
}

/** Enough of an SVG element to read viewBox or fall back to getBBox. */
export type SvgBoxSource = {
  viewBox: { baseVal: { x: number; y: number; width: number; height: number } };
  getBBox: () => { x: number; y: number; width: number; height: number };
};

export function svgElementBox(el: SvgBoxSource | null | undefined): SvgBox | null {
  if (!el) return null;
  const box = el.viewBox.baseVal;
  if (box.width && box.height && Number.isFinite(box.x) && Number.isFinite(box.y)) {
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  try {
    const bounds = el.getBBox();
    if (!bounds.width || !bounds.height) return null;
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  } catch {
    return null;
  }
}

export function resolveSvgBox(svg: string, el?: SvgBoxSource | null): SvgBox | null {
  return parseSvgViewBox(svg) ?? svgElementBox(el);
}

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

/** Never project an unknown legacy SVG origin onto a verified native PCB frame. */
export function commentPointForDrawing(anchor: CommentAnchor, nativePcbCoordinates: boolean): SvgPoint | null {
  if (anchor.view === "pcb") {
    if (nativePcbCoordinates) return commentMillimetrePoint(anchor);
    if (anchor.coordinateSystem === "kicad-pcb-mm" || (anchor.x === undefined && anchor.xMm !== undefined)) return null;
  }
  return anchor.x !== undefined && anchor.y !== undefined ? { x: anchor.x, y: anchor.y } : null;
}
