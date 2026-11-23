/** The schematic's netlist as pin semantics: KiCad XML netlist -> parts with pin names, types and nets. */

export interface NetPin {
  name: string;
  type: string;
  net: string;
  /** Pins on this net (1 = nothing else is connected). */
  nodes: number;
}

export interface Comp {
  ref: string;
  value: string;
  footprint: string;
  lib: string;
  part: string;
  desc: string;
  fields: Record<string, string>;
  /** Pad -> pin, in netlist order. */
  pins: Map<string, NetPin>;
}

interface XNode {
  tag: string;
  attrs: Record<string, string>;
  kids: XNode[];
  /** Text before the first child element (ElementTree's `.text`). */
  text: string;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENT[e] ?? m;
  });

export function parseXml(text: string): XNode {
  const root: XNode = { tag: "#root", attrs: {}, kids: [], text: "" };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1]!;
    if (m[6] !== undefined || m[1] !== undefined) {
      const t = m[6] !== undefined ? unescapeXml(m[6]) : m[1]!;
      if (top.kids.length === 0) top.text += t;
    } else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = unescapeXml(a[2] ?? a[3] ?? "");
      const node: XNode = { tag: m[3], attrs, kids: [], text: "" };
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root.kids[0] ?? root;
}

function* iter(n: XNode, tag: string): Generator<XNode> {
  for (const k of n.kids) {
    if (k.tag === tag) yield k;
    yield* iter(k, tag);
  }
}
const child = (n: XNode, tag: string) => n.kids.find((k) => k.tag === tag);
const childText = (n: XNode, tag: string) => child(n, tag)?.text ?? "";

export function loadNetlist(xml: string): Map<string, Comp> {
  const root = parseXml(xml);
  const comps = new Map<string, Comp>();
  for (const c of iter(root, "comp")) {
    const fields: Record<string, string> = {};
    for (const x of iter(c, "field")) fields[x.attrs["name"] ?? ""] = x.text;
    const lib = child(c, "libsource");
    const ref = c.attrs["ref"] ?? "";
    comps.set(ref, {
      ref,
      value: childText(c, "value"),
      footprint: childText(c, "footprint"),
      lib: lib?.attrs["lib"] ?? "",
      part: lib?.attrs["part"] ?? "",
      desc: lib?.attrs["description"] ?? "",
      fields,
      pins: new Map(),
    });
  }
  for (const n of iter(root, "net")) {
    const nodes = [...iter(n, "node")];
    for (const nd of nodes) {
      const c = comps.get(nd.attrs["ref"] ?? "");
      if (!c) continue;
      const pin = nd.attrs["pin"] ?? "";
      let name = nd.attrs["pinfunction"] ?? "";
      if (name.endsWith("_" + pin)) name = name.slice(0, name.length - (pin.length + 1)); // KiCad appends _<pad> when a pin name repeats
      name = name.replace(/@\d+$/, "");
      if (name.toUpperCase() === pin.toUpperCase()) name = pin; // a pin named by its own pad number is generic
      c.pins.set(pin, { name, type: nd.attrs["pintype"] ?? "", net: n.attrs["name"] ?? "", nodes: nodes.length });
    }
  }
  return comps;
}

export function lcsc(c: Comp): string {
  for (const k of ["LCSC", "LCSC Part", "LCSC_Part", "JLC", "JLCPCB", "lcsc", "LCSC#", "JLC Part"]) {
    const v = (c.fields[k] ?? "").trim();
    if (/^C\d{3,9}$/.test(v)) return v;
  }
  return "";
}
