import { BoardShape, mm as toNm, toVector2, toMm } from "@fp-pcb/client";
import { BoardLayer } from "@fp-pcb/proto";
import { ToolError } from "@fabdesk/tools";

/** Resize a complete native rectangle by cloning its primitives, preserving every non-geometry field. */
export function resizeNativeOutlineShapes(edges: BoardShape[], widthMm: number, heightMm: number) {
  if (![widthMm, heightMm].every(Number.isFinite) || widthMm < .000001 || heightMm < .000001 || widthMm > 1000 || heightMm > 1000)
    throw new ToolError("Outline dimensions must be between 0.000001 and 1000 mm.", "invalid_args");
  if (![1, 4].includes(edges.length) || new Set(edges.map(edge => edge.id)).size !== edges.length || edges.some(edge => edge.layerId !== BoardLayer.BL_Edge_Cuts))
    throw new ToolError("Select the complete native rectangular Edge.Cuts boundary.", "precondition");
  if (edges.some(edge => edge.locked)) throw new ToolError("Unlock the outline edges in KiCad before resizing.", "precondition");
  if (edges.length === 1 ? edges[0]!.kind !== "rectangle" : edges.some(edge => edge.kind !== "segment"))
    throw new ToolError("Only one native rectangle or four axis-aligned segments can use width/height resizing.", "precondition");
  for (const edge of edges) {
    const geometry = edge.proto.shape?.geometry;
    const complete = geometry?.case === "rectangle" ? geometry.value.topLeft && geometry.value.bottomRight : geometry?.case === "segment" ? geometry.value.start && geometry.value.end : false;
    if (!complete) throw new ToolError("The native outline has incomplete endpoint coordinates.", "precondition");
  }
  const points = edges.flatMap(edge => [edge.start, edge.end]);
  if (points.some(point => !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)))
    throw new ToolError("The outline coordinates exceed exact native precision.", "precondition");
  const minX = Math.min(...points.map(point => point.x)), minY = Math.min(...points.map(point => point.y));
  const maxX = Math.max(...points.map(point => point.x)), maxY = Math.max(...points.map(point => point.y));
  if (maxX <= minX || maxY <= minY) throw new ToolError("The existing outline has no usable width or height.", "precondition");
  if (edges.length === 4) {
    const corners = new Map<string, number>(), segments = new Set<string>();
    for (const edge of edges) {
      const a = edge.start, b = edge.end;
      if ((a.x === b.x) === (a.y === b.y) || [a, b].some(point => ![minX, maxX].includes(point.x) || ![minY, maxY].includes(point.y)))
        throw new ToolError("The segments do not form an axis-aligned rectangle.", "precondition");
      const keys = [a, b].map(point => `${point.x},${point.y}`);
      for (const key of keys) corners.set(key, (corners.get(key) ?? 0) + 1);
      segments.add(keys.sort().join("|"));
    }
    if (corners.size !== 4 || [...corners.values()].some(count => count !== 2) || segments.size !== 4)
      throw new ToolError("The outline contains duplicate or disconnected segments.", "precondition");
  }
  const nextMaxX = minX + toNm(widthMm), nextMaxY = minY + toNm(heightMm);
  if (![nextMaxX, nextMaxY].every(Number.isSafeInteger)) throw new ToolError("The resized outline exceeds exact native precision.", "invalid_args");
  const transform = (point: { x: number; y: number }) => toVector2({ x: point.x === minX ? minX : nextMaxX, y: point.y === minY ? minY : nextMaxY });
  const updates = edges.map(edge => {
    const copy = edge.clone(), geometry = copy.proto.shape!.geometry;
    if (geometry.case === "rectangle") {
      geometry.value.topLeft = transform(edge.start); geometry.value.bottomRight = transform(edge.end);
    } else if (geometry.case === "segment") {
      geometry.value.start = transform(edge.start); geometry.value.end = transform(edge.end);
    }
    return copy;
  });
  return { updates, changed: nextMaxX !== maxX || nextMaxY !== maxY, bounds: { minX: toMm(minX), minY: toMm(minY), maxX: toMm(nextMaxX), maxY: toMm(nextMaxY) } };
}

/** A locked ancestor group protects its members even when the primitive's own lock is clear. */
export function nativeGroupLocksAny(ids: string[], groups: Array<{ id: string; items: string[]; locked: boolean }>): boolean {
  const members = new Set(ids);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const group of groups) {
      if (!group.items.some(id => members.has(id))) continue;
      if (group.locked) return true;
      if (!members.has(group.id)) { members.add(group.id); expanded = true; }
    }
  }
  return false;
}
