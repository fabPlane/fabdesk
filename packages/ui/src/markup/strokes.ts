/** High-contrast mark colour: readable on copper, silk, and dark 3D backgrounds. */
export const MARK_COLOR = "#ff3d2e";
export const MARK_HALO = "#ffffff";
export const MARK_WIDTH = 3;
export const MARK_HALO_WIDTH = 5.5;

export type MarkupTool = "pen" | "arrow";
export type MarkupPoint = { x: number; y: number };

export type PenStroke = {
  id: string;
  tool: "pen";
  points: MarkupPoint[];
};

export type ArrowStroke = {
  id: string;
  tool: "arrow";
  from: MarkupPoint;
  to: MarkupPoint;
};

export type MarkupStroke = PenStroke | ArrowStroke;

export interface StrokeModel {
  strokes: MarkupStroke[];
}

export type Box = { x: number; y: number; w: number; h: number };

export function emptyStrokes(): StrokeModel {
  return { strokes: [] };
}

export function addStroke(model: StrokeModel, stroke: MarkupStroke): StrokeModel {
  return { strokes: [...model.strokes, stroke] };
}

export function undoStroke(model: StrokeModel): StrokeModel {
  if (model.strokes.length === 0) return model;
  return { strokes: model.strokes.slice(0, -1) };
}

export function clearStrokes(model: StrokeModel): StrokeModel {
  return model.strokes.length === 0 ? model : emptyStrokes();
}

export function extendPen(stroke: PenStroke, point: MarkupPoint): PenStroke {
  const last = stroke.points.at(-1);
  if (last && last.x === point.x && last.y === point.y) return stroke;
  return { ...stroke, points: [...stroke.points, point] };
}

export function replaceStroke(model: StrokeModel, stroke: MarkupStroke): StrokeModel {
  if (model.strokes.length === 0) return addStroke(model, stroke);
  return { strokes: [...model.strokes.slice(0, -1), stroke] };
}

/** Axis-aligned bounds of every stroke in overlay CSS pixels, padded by the halo width. */
export function strokeBounds(strokes: readonly MarkupStroke[]): Box | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (p: MarkupPoint) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const stroke of strokes) {
    if (stroke.tool === "pen") {
      for (const p of stroke.points) visit(p);
    } else {
      visit(stroke.from);
      visit(stroke.to);
      for (const p of arrowHead(stroke.from, stroke.to)) visit(p);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const pad = MARK_HALO_WIDTH;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function arrowHead(from: MarkupPoint, to: MarkupPoint, size = 14): [MarkupPoint, MarkupPoint, MarkupPoint] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const leftX = to.x - ux * size + -uy * size * 0.45;
  const leftY = to.y - uy * size + ux * size * 0.45;
  const rightX = to.x - ux * size + uy * size * 0.45;
  const rightY = to.y - uy * size + -ux * size * 0.45;
  return [to, { x: leftX, y: leftY }, { x: rightX, y: rightY }];
}
