import { kid, kids, parseSexpr, type SNode } from "../sexpr";
import { footprintSpans } from "./text";

/** Conservative comparison of copper/drill geometry. Unknown pad settings stay in the signature. */
export function footprintCopperSignature(text: string, ref: string): string {
  const span = footprintSpans(text).get(ref);
  if (!span) throw Error(`No footprint ${ref}`);
  const fp = parseSexpr(text.slice(span.start, span.end));
  const omit = new Set(["uuid", "tstamp", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "property", "render_cache"]);
  const copperLayer = (value: unknown) => typeof value === "string" && /(?:^|\.)Cu$/.test(value);
  const canon = (node: SNode): unknown => {
    const key = String(node[0]);
    if (omit.has(key)) return null;
    if (key === "net") return [key, String(node.at(-1))];
    let atoms = node.filter((n): n is string => typeof n === "string").map(n => /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(n) ? Number(n) : n);
    if (key === "layers") atoms = ["layers", ...atoms.slice(1).filter(copperLayer).sort()];
    if (key === "at" && atoms.length === 3) atoms.push(0);
    let children = node.filter(Array.isArray).map(n => canon(n as SNode)).filter(n => n !== null);
    if (key === "pts") {
      if (children.length > 1 && JSON.stringify(children[0]) === JSON.stringify(children.at(-1))) children = children.slice(0, -1);
    } else children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [...atoms, ...children];
  };
  const geometry = fp.filter(Array.isArray).filter(n => {
    const key = String(n[0]);
    return key === "pad" && (kids(n as SNode, "layers").some(l => l.slice(1).some(copperLayer)) || n[2] === "np_thru_hole") || key === "zone" || key.startsWith("fp_") && copperLayer(kid(n as SNode, "layer")?.[1]);
  }).map(n => canon(n as SNode));
  geometry.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ pose: canon(kid(fp, "transform") ?? kid(fp, "at") ?? ["at", "0", "0"]), side: kid(fp, "layer")?.[1], geometry });
}
