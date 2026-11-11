import { create } from "zustand";

export type PartBox = { x: number; y: number; width: number; height: number };
export type SelectablePart = { ref: string; uuid: string; unit?: number; box: PartBox };
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
function geometry(node: Node[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const key of ["start", "end", "mid", "center"]) { const p = point(child(node, key)); if (p) out.push(p); }
  for (const pts of children(node, "pts")) for (const xy of children(pts, "xy")) { const p = point(xy); if (p) out.push(p); }
  const at = point(child(node, "at")), size = point(child(node, "size"));
  if (at && node[0] === "pad") {
    const angle = Number(child(node, "at")?.[3] ?? 0) * Math.PI / 180, c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const w = size ? (size.x * c + size.y * s) / 2 : .5, h = size ? (size.x * s + size.y * c) / 2 : .5;
    out.push({ x: at.x - w, y: at.y - h }, { x: at.x + w, y: at.y + h });
  } else if (at && node[0] === "pin") out.push(at);
  const center = point(child(node, "center")), end = point(child(node, "end"));
  const radius = Number(child(node, "radius")?.[1] ?? (center && end ? Math.hypot(end.x - center.x, end.y - center.y) : NaN));
  if (center && Number.isFinite(radius)) out.push({ x: center.x - radius, y: center.y - radius }, { x: center.x + radius, y: center.y + radius });
  return out;
}
export function pcbSelectionParts(text: string): SelectablePart[] {
  const root = parse(text, "kicad_pcb"), parts: SelectablePart[] = [];
  for (const fp of [...children(root, "footprint"), ...children(root, "module")]) {
    const ref = property(fp, "Reference") || String(children(fp, "fp_text").find(n => n[1] === "reference")?.[2] ?? "");
    const at = point(child(fp, "at")); if (!ref || !at || ref.startsWith("#")) continue;
    const angle = -Number(child(fp, "at")?.[3] ?? 0) * Math.PI / 180;
    const pts = fp.filter((n): n is Node[] => Array.isArray(n) && ["pad", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly"].includes(String(n[0]))).flatMap(geometry);
    const box = bounds(pts.map(p => ({ x: at.x + p.x * Math.cos(angle) - p.y * Math.sin(angle), y: at.y + p.x * Math.sin(angle) + p.y * Math.cos(angle) })));
    if (box) parts.push({ ref, uuid: value(fp, "uuid") || value(fp, "tstamp"), box });
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
    const points = units.flatMap(n => n.filter((v): v is Node[] => Array.isArray(v) && ["rectangle", "polyline", "circle", "arc", "pin"].includes(String(v[0]))).flatMap(geometry));
    const mirror = value(sym, "mirror");
    const box = bounds(points.map(p => { const x = p.x * (mirror === "y" ? -1 : 1), y = p.y * (mirror === "x" ? -1 : 1); return { x: at.x + x * Math.cos(angle) - y * Math.sin(angle), y: at.y - x * Math.sin(angle) - y * Math.cos(angle) }; }));
    if (box) parts.push({ ref, uuid: value(sym, "uuid"), unit, box });
  }
  const seen = new Set<string>(), ambiguous = new Set<string>();
  for (const part of parts) { const key = JSON.stringify([part.ref, part.unit]); if (seen.has(key)) ambiguous.add(part.ref); seen.add(key); }
  return parts.filter(part => !ambiguous.has(part.ref));
}
export function hitSelectionPart(parts: SelectablePart[], point: { x: number; y: number }): SelectablePart | null {
  return parts.filter(({ box: b }) => point.x >= b.x && point.y >= b.y && point.x <= b.x + b.width && point.y <= b.y + b.height).sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0] ?? null;
}
