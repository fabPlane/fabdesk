/**
 * Turn a KiCad netlist (`kicad-cli sch export netlist --format kicadsexpr`) into fabdesk's
 * `circuit.netlist.json`, so an existing KiCad schematic can go through circuit_build, circuit_place
 * and route_run.
 *
 *   bun scripts/import-kicad-netlist.ts design.net --out circuit.netlist.json \
 *     --lib pcbgolf='${KIPRJMOD}/pcbgolf.pretty' --board 70 55
 *
 * `--lib nickname=uri` registers a footprint library (repeatable; a project-local `.pretty` goes next
 * to the netlist in the project). `--keep-dnp` keeps components marked do-not-populate (dropped by
 * default, with their nets pruned). `--board W H` sets the outline in mm; `--rules clearance,track,via,drill`
 * the Default net class in mm.
 *
 * Net names are copied as KiCad wrote them, except that brace escapes such as `{slash}` (a label with
 * a `/` in it) become `_`: the KiCad fork fails its project save with `basic_string` on a board
 * whose net names carry braces, and circuit_build refuses them for that reason.
 */
import type { NetlistFile } from "@fabdesk/protocol";

type Sexpr = string | Sexpr[];

/** A small s-expression reader: lists, bare atoms and double-quoted strings with backslash escapes. */
export function parseSexpr(text: string): Sexpr {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const atom = (): Sexpr => {
    if (text[i] === '"') {
      let j = i + 1;
      let out = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        out += text[j++];
      }
      i = j + 1;
      return out;
    }
    let j = i;
    while (j < text.length && !/[\s()]/.test(text[j]!)) j++;
    const a = text.slice(i, j);
    i = j;
    return a;
  };
  const list = (): Sexpr => {
    i++;
    const out: Sexpr[] = [];
    ws();
    while (i < text.length && text[i] !== ")") {
      out.push(text[i] === "(" ? list() : atom());
      ws();
    }
    i++;
    return out;
  };
  ws();
  if (text[i] !== "(") throw new Error("not an s-expression");
  return list();
}

const isList = (v: Sexpr): v is Sexpr[] => Array.isArray(v);
const child = (l: Sexpr[], name: string): Sexpr[] | undefined =>
  l.find((x): x is Sexpr[] => isList(x) && x[0] === name);
const children = (l: Sexpr[], name: string): Sexpr[][] =>
  l.filter((x): x is Sexpr[] => isList(x) && x[0] === name);
const str = (l: Sexpr[] | undefined, name: string): string | undefined => {
  const v = child(l ?? [], name)?.[1];
  return typeof v === "string" ? v : undefined;
};

export type ImportOptions = {
  keepDnp?: boolean;
  libraries?: Array<{ nickname: string; uri: string }>;
  board?: { widthMm: number; heightMm: number };
  rules?: {
    clearanceMm?: number;
    trackWidthMm?: number;
    viaDiameterMm?: number;
    viaDrillMm?: number;
  };
};

export type ImportSummary = {
  components: number;
  nets: number;
  nodes: number;
  dropped: { dnp: string[]; noFootprint: string[]; singleNodeNets: string[] };
  renamed: Array<{ from: string; to: string }>;
};

/**
 * The escapes KiCad writes for characters a label cannot carry literally (`{slash}`, `{colon}`, …)
 * become `_`; any brace left over after that becomes `_` too, since `circuit_build` refuses every
 * `{`/`}` when the board carries rules. Collisions are resolved by `uniqueNetNames`.
 */
export function sanitizeNetName(name: string): string {
  return name.replace(/\{[a-z]+\}/gi, "_").replace(/[{}]/g, "_");
}

/**
 * Sanitized names for every raw net name, in order. A net whose name needs no rewrite keeps it; a
 * rewritten one that would land on a name already taken (by an untouched net or an earlier
 * rewrite) gets the first free `_2`, `_3`, … suffix, so two nets never merge silently.
 */
export function uniqueNetNames(raw: readonly string[]): string[] {
  const taken = new Set(raw.filter((name) => sanitizeNetName(name) === name));
  return raw.map((name) => {
    const clean = sanitizeNetName(name);
    if (clean === name) return name;
    let candidate = clean;
    for (let n = 2; taken.has(candidate); n++) candidate = `${clean}_${n}`;
    taken.add(candidate);
    return candidate;
  });
}

export function importKicadNetlist(
  text: string,
  opts: ImportOptions = {},
): { file: NetlistFile; summary: ImportSummary } {
  const root = parseSexpr(text);
  if (!isList(root) || root[0] !== "export")
    throw new Error("not a KiCad netlist (expected `(export …)`)");
  const skipped = {
    dnp: [] as string[],
    noFootprint: [] as string[],
    singleNodeNets: [] as string[],
  };
  const components: NetlistFile["netlist"]["components"] = [];
  for (const comp of children(child(root, "components") ?? [], "comp")) {
    const ref = str(comp, "ref");
    if (!ref) continue;
    const dnp = children(comp, "property").some((p) => str(p, "name") === "dnp");
    if (dnp && !opts.keepDnp) {
      skipped.dnp.push(ref);
      continue;
    }
    const footprint = str(comp, "footprint") ?? "";
    if (!footprint) {
      skipped.noFootprint.push(ref);
      continue;
    }
    const fields: Record<string, string> = {};
    for (const f of children(child(comp, "fields") ?? [], "field")) {
      const name = str(f, "name");
      const value = f[2];
      if (
        name &&
        typeof value === "string" &&
        value &&
        !["Footprint", "Datasheet", "Description"].includes(name)
      )
        fields[name] = value;
    }
    const libsource = child(comp, "libsource");
    components.push({
      ref,
      value: str(comp, "value") ?? "",
      footprint,
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(libsource && str(libsource, "lib") && str(libsource, "part")
        ? { libSource: { lib: str(libsource, "lib")!, part: str(libsource, "part")! } }
        : {}),
    });
  }
  const refs = new Set(components.map((c) => c.ref));
  const renamed: ImportSummary["renamed"] = [];
  const nets: NetlistFile["netlist"]["nets"] = [];
  const rawNets = children(child(root, "nets") ?? [], "net");
  const names = uniqueNetNames(rawNets.map((net) => str(net, "name") ?? ""));
  for (const [i, net] of rawNets.entries()) {
    const raw = str(net, "name") ?? "";
    const name = names[i]!;
    if (name !== raw) renamed.push({ from: raw, to: name });
    const nodes = children(net, "node")
      .map((n) => ({ ref: str(n, "ref") ?? "", pin: str(n, "pin") ?? "" }))
      .filter((n) => n.ref && n.pin && refs.has(n.ref));
    if (nodes.length < 2) {
      skipped.singleNodeNets.push(name);
      continue;
    }
    const code = Number(str(net, "code"));
    nets.push({ name, ...(Number.isFinite(code) ? { code } : {}), nodes });
  }
  const design = child(root, "design");
  const file: NetlistFile = {
    netlist: {
      components,
      nets,
      ...(design
        ? {
            design: {
              ...(str(design, "source") ? { source: str(design, "source")! } : {}),
              ...(str(design, "tool") ? { tool: str(design, "tool")! } : {}),
            },
          }
        : {}),
    },
    ...(opts.board || opts.rules
      ? { board: { ...(opts.board ?? {}), ...(opts.rules ? { rules: opts.rules } : {}) } }
      : {}),
    ...(opts.libraries?.length
      ? { libraries: opts.libraries.map((l) => ({ kind: "footprint" as const, ...l })) }
      : {}),
  };
  return {
    file,
    summary: {
      components: components.length,
      nets: nets.length,
      nodes: nets.reduce((n, x) => n + x.nodes.length, 0),
      dropped: skipped,
      renamed,
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const input = args.find(
    (a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"),
  );
  if (!input)
    throw new Error(
      "usage: bun scripts/import-kicad-netlist.ts <design.net> [--out file] [--lib nick=uri]… [--board W H] [--rules c,t,v,d] [--keep-dnp]",
    );
  const values = (name: string) =>
    args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1] ?? ""] : []));
  const libraries = values("lib").map((v) => {
    const [nickname, ...rest] = v.split("=");
    if (!nickname || !rest.length) throw new Error(`--lib expects nickname=uri, got ${v}`);
    return { nickname, uri: rest.join("=") };
  });
  const boardIdx = args.indexOf("--board");
  const board =
    boardIdx >= 0
      ? { widthMm: Number(args[boardIdx + 1]), heightMm: Number(args[boardIdx + 2]) }
      : undefined;
  const rulesRaw = values("rules")[0];
  const rules = rulesRaw
    ? (([c, t, v, d]) => ({
        ...(c ? { clearanceMm: c } : {}),
        ...(t ? { trackWidthMm: t } : {}),
        ...(v ? { viaDiameterMm: v } : {}),
        ...(d ? { viaDrillMm: d } : {}),
      }))(rulesRaw.split(",").map(Number))
    : undefined;
  const { file, summary } = importKicadNetlist(await Bun.file(input).text(), {
    keepDnp: args.includes("--keep-dnp"),
    libraries,
    ...(board ? { board } : {}),
    ...(rules ? { rules } : {}),
  });
  const out = values("out")[0] ?? "circuit.netlist.json";
  await Bun.write(out, `${JSON.stringify(file, null, 1)}\n`);
  console.log(
    `${out}: ${summary.components} components, ${summary.nets} nets, ${summary.nodes} nodes`,
  );
  if (summary.dropped.dnp.length) console.log(`dropped DNP: ${summary.dropped.dnp.join(", ")}`);
  if (summary.dropped.noFootprint.length)
    console.log(`dropped (no footprint): ${summary.dropped.noFootprint.join(", ")}`);
  if (summary.dropped.singleNodeNets.length)
    console.log(`dropped ${summary.dropped.singleNodeNets.length} nets with fewer than two nodes`);
  for (const r of summary.renamed)
    console.log(`renamed net ${r.from} → ${r.to} (KiCad escape; the fork cannot save it)`);
}
