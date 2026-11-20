import { create } from "zustand";

export type PartBox = { x: number; y: number; width: number; height: number };
export type SelectablePart = { ref: string; value?: string; uuid: string; unit?: number; box: PartBox; hull?: { x: number; y: number }[] };
export type PartScope = { endpoint: string; projectId: string; sourceId?: string; manifestSha256?: string };
export const partScopeKey = (scope: PartScope) => JSON.stringify([scope.endpoint, scope.projectId, scope.sourceId ?? null, scope.manifestSha256 ?? null]);
export const usePartSelection = create<{ selection: { scope: string; ref: string } | null; select: (scope: string, ref: string) => void; clear: (scope: string) => void }>(set => ({
  selection: null,
  select: (scope, ref) => set({ selection: { scope, ref } }),
  clear: scope => set(state => state.selection?.scope === scope ? { selection: null } : {}),
}));

type Node = string | Node[];
const children = (node: Node[], key: string) => node.filter((v): v is Node[] => Array.isArray(v) && v[0] === key);
const child = (node: Node[], key: string) => children(node, key)[0];
const value = (node: Node[], key: string) => String(child(node, key)?.[1] ?? "");
const property = (node: Node[], key: string) => String(children(node, "property").find(v => v[1] === key)?.[2] ?? "");
/** Bounded, browser-safe native reader. Never evaluate file content or traverse library symbols as placed parts. */
function parse(text: string, kind: string): Node[] {
  if (text.length > 20_000_000) throw new Error("Design is too large for component selection.");
  const stack: Node[][] = [[]], tokens = /\s*("(?:\\.|[^"\\])*"|[()]|[^\s()"]+)\s*/gy;
  let offset = 0, count = 0;
  while (offset < text.length) {
    tokens.lastIndex = offset; const match = tokens.exec(text);
    if (!match) { if (!text.slice(offset).trim()) break; throw new Error("Malformed native design."); }
    offset = tokens.lastIndex; const token = match[1]!;
    if (++count > 2_000_000) throw new Error("Design exceeds the selection limit.");
    if (token === "(") { if (stack.length > 128) throw new Error("Native design nesting exceeds the selection limit."); const node: Node[] = []; stack.at(-1)!.push(node); stack.push(node); }
    else if (token === ")") { if (stack.length === 1) throw new Error("Malformed native design."); stack.pop(); }
    else stack.at(-1)!.push(token.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, "$1") : token);
  }
  const root = stack[0]![0];
  if (stack.length !== 1 || stack[0]!.length !== 1 || !Array.isArray(root) || root[0] !== kind) throw new Error("Malformed native design.");
  return root;
}
const point = (node: Node[] | undefined) => node && Number.isFinite(Number(node[1])) && Number.isFinite(Number(node[2])) ? { x: Number(node[1]), y: Number(node[2]) } : null;
function bounds(points: { x: number; y: number }[]): PartBox | null {
  if (!points.length) return null;
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  if (![x, y, right, bottom].every(Number.isFinite)) return null;
  return { x: x - .4, y: y - .4, width: right - x + .8, height: bottom - y + .8 };
}
type Point = { x: number; y: number };
/** Native component envelope, without the rectangular hit-test padding. */
export function componentHull(points: readonly Point[]): Point[] {
  const sorted = [...new Map(points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).map(p => [`${p.x}/${p.y}`, p])).values()].sort((a,b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (a: Point, b: Point, c: Point) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const half = (points: Point[]) => { const result: Point[] = []; for (const p of points) { while (result.length > 1 && cross(result[result.length-2]!, result[result.length-1]!, p) <= 0) result.pop(); result.push(p); } return result; };
  return [...half(sorted).slice(0,-1), ...half([...sorted].reverse()).slice(0,-1)];
}
function geometry(node: Node[], transform: (p: Point) => Point = p => p): Point[] {
  const out: { x: number; y: number }[] = [];
  for (const key of ["start", "end", "mid", "center"]) { const p = point(child(node, key)); if (p) out.push(p); }
  for (const pts of children(node, "pts")) for (const xy of children(pts, "xy")) { const p = point(xy); if (p) out.push(p); }
  const start = point(child(node, "start")), end = point(child(node, "end"));
  if (start && end && ["fp_rect", "rectangle"].includes(String(node[0]))) out.push({ x: start.x, y: end.y }, { x: end.x, y: start.y });
  const at = point(child(node, "at"));
  if (at && node[0] === "pin") out.push(at);
  const center = point(child(node, "center"));
  const radius = Number(child(node, "radius")?.[1] ?? (center && end ? Math.hypot(end.x - center.x, end.y - center.y) : NaN));
  if (center && Number.isFinite(radius) && ["fp_circle", "circle"].includes(String(node[0]))) {
    const c = transform(center);
    return [{ x: c.x - radius, y: c.y - radius }, { x: c.x + radius, y: c.y + radius }];
  }
  const transformed = out.map(transform);
  const mid = point(child(node, "mid"));
  if (start && mid && end && ["fp_arc", "arc"].includes(String(node[0]))) {
    const a = transform(start), b = transform(mid), c = transform(end);
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) > 1e-12) {
      const a2 = a.x ** 2 + a.y ** 2, b2 = b.x ** 2 + b.y ** 2, c2 = c.x ** 2 + c.y ** 2;
      const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
      const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
      const tau = Math.PI * 2, norm = (n: number) => (n % tau + tau) % tau;
      const from = Math.atan2(a.y - y, a.x - x), to = Math.atan2(c.y - y, c.x - x);
      const ccw = norm(to - from), forward = norm(Math.atan2(b.y - y, b.x - x) - from) <= ccw + 1e-9;
      const sweep = forward ? ccw : norm(from - to), r = Math.hypot(a.x - x, a.y - y);
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) if (norm(forward ? angle - from : from - angle) <= sweep + 1e-9) transformed.push({ x: x + r * Math.cos(angle), y: y + r * Math.sin(angle) });
    }
  }
  return transformed;
}
export function pcbSelectionParts(text: string): SelectablePart[] {
  const root = parse(text, "kicad_pcb"), parts: SelectablePart[] = [];
  for (const fp of [...children(root, "footprint"), ...children(root, "module")]) {
    const ref = property(fp, "Reference") || String(children(fp, "fp_text").find(n => n[1] === "reference")?.[2] ?? "");
    const transform = child(fp, "transform"), at = point(transform ? child(transform, "translate") : child(fp, "at"));
    if (!ref || !at || ref.startsWith("#")) continue;
    const angle = -Number(transform ? child(transform, "rotate")?.[1] ?? 0 : child(fp, "at")?.[3] ?? 0) * Math.PI / 180;
    const toBoard = (p: Point) => ({ x: at.x + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: at.y + p.x * Math.sin(angle) + p.y * Math.cos(angle) });
    const pts = fp.filter((n): n is Node[] => Array.isArray(n) && ["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"].includes(String(n[0]))).flatMap(n => geometry(n, toBoard));
    for (const pad of children(fp, "pad")) {
      const local = point(child(pad, "at")), size = point(child(pad, "size"));
      if (!local || !size) continue;
      // Saved pad positions are footprint-local; pad orientations are board-absolute.
      const a = -Number(child(pad, "at")?.[3] ?? 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
      const center = toBoard(local), offset = point(child(child(pad, "drill") ?? [], "offset"));
      if (offset) { center.x += offset.x * Math.cos(a) - offset.y * Math.sin(a); center.y += offset.x * Math.sin(a) + offset.y * Math.cos(a); }
      const radius = pad[3] === "oval" ? Math.min(size.x, size.y) / 2 : pad[3] === "roundrect" ? Math.min(size.x, size.y) * Math.max(0, Math.min(.5, Number(child(pad, "roundrect_rratio")?.[1] ?? 0))) : 0;
      const w = pad[3] === "circle" ? size.x / 2 : (size.x / 2 - radius) * c + (size.y / 2 - radius) * sn + radius;
      const h = pad[3] === "circle" ? size.y / 2 : (size.x / 2 - radius) * sn + (size.y / 2 - radius) * c + radius;
      pts.push({ x: center.x - w, y: center.y - h }, { x: center.x + w, y: center.y + h });
    }
    const box = bounds(pts);
    const partValue = property(fp, "Value") || String(children(fp, "fp_text").find(n => n[1] === "value")?.[2] ?? "");
    if (box) parts.push({ ref, ...(partValue ? { value: partValue } : {}), uuid: value(fp, "uuid") || value(fp, "tstamp"), box, hull: componentHull(pts) });
  }
  // Duplicate references have no safe counterpart in another view.
  const counts = new Map<string, number>();
  for (const part of parts) counts.set(part.ref, (counts.get(part.ref) ?? 0) + 1);
  return parts.filter(p => counts.get(p.ref) === 1);
}
export function schematicSelectionParts(text: string, sheetIdentity: string, rootText: string): SelectablePart[] {
  const root = parse(text, "kicad_sch"), rootUuid = value(parse(rootText, "kicad_sch"), "uuid");
  const instance = `/${[rootUuid, ...sheetIdentity.split("/").slice(1)].join("/")}`;
  const libraries = children(child(root, "lib_symbols") ?? [], "symbol"), parts: SelectablePart[] = [];
  for (const sym of children(root, "symbol")) {
    const annotations = children(sym, "instances").flatMap(n => children(n, "project").flatMap(n => children(n, "path"))).filter(n => n[1] === instance);
    if (annotations.length > 1) continue;
    const ref = annotations.length ? value(annotations[0]!, "reference") : property(sym, "Reference");
    // A reused sheet without a matching annotation must never borrow another instance's reference.
    if (!annotations.length && child(sym, "instances")) continue;
    const at = point(child(sym, "at")), lib = libraries.find(n => n[1] === value(sym, "lib_id"));
    if (!ref || ref.startsWith("#") || !at || !lib) continue;
    const unit = Number(value(sym, "unit") || 1), angle = Number(child(sym, "at")?.[3] ?? 0) * Math.PI / 180;
    const units = children(lib, "symbol").filter(n => { const m = /_(\d+)_\d+$/.exec(String(n[1])); return m && (Number(m[1]) === 0 || Number(m[1]) === unit); });
    const mirror = value(sym, "mirror");
    const toSheet = (p: Point) => { const x = p.x * (mirror === "y" ? -1 : 1), y = p.y * (mirror === "x" ? -1 : 1); return { x: at.x + x * Math.cos(angle) - y * Math.sin(angle), y: at.y - x * Math.sin(angle) - y * Math.cos(angle) }; };
    const points = units.flatMap(n => n.filter((v): v is Node[] => Array.isArray(v) && ["rectangle", "polyline", "circle", "arc", "pin"].includes(String(v[0]))).flatMap(n => geometry(n, toSheet)));
    const box = bounds(points);
    const body = units.flatMap(n => n.filter((v): v is Node[] => Array.isArray(v) && ["rectangle", "polyline", "circle", "arc"].includes(String(v[0]))).flatMap(n => geometry(n, toSheet)));
    const partValue = property(sym, "Value");
    if (box) parts.push({ ref, ...(partValue ? { value: partValue } : {}), uuid: value(sym, "uuid"), unit, box, hull: componentHull(body.length >= 3 ? body : points) });
  }
  const seen = new Set<string>(), ambiguous = new Set<string>();
  for (const part of parts) { const key = JSON.stringify([part.ref, part.unit]); if (seen.has(key)) ambiguous.add(part.ref); seen.add(key); }
  return parts.filter(part => !ambiguous.has(part.ref));
}
export function hitSelectionPart(parts: SelectablePart[], point: { x: number; y: number }): SelectablePart | null {
  return parts.filter(({ box: b }) => point.x >= b.x && point.y >= b.y && point.x <= b.x + b.width && point.y <= b.y + b.height).sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0] ?? null;
}
