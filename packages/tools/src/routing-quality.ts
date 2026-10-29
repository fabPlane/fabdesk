/** Saved-board copper facts. Lengths use the accept_lib start/end chord convention, including arcs. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_FILES, writeJson } from "./fs";

type Node = string | Node[];
export type PairDefinition = {
  p: string;
  n: string;
  widthMm?: number | undefined;
  gapMm?: number | undefined;
  skewToleranceMm?: number | undefined;
  source?: "native netclass" | "native diff-pair rule" | "identified by name";
};
export type NetFacts = {
  net: string;
  minWidthMm: number | null;
  dominantWidthMm: number | null;
  lengthMm: number;
  viaCount: number;
  layers: string[];
  widthsMm: number[];
  viaSizes: Array<{ diameterMm: number; drillMm: number }>;
};
type Copper = {
  signature: string;
  id: string;
  net: string;
  layer: string[];
  locked: boolean;
  width?: number;
  length: number;
  diameter?: number;
  drill?: number;
};
export type CopperBoard = { revision: string; nets: string[]; copper: Copper[] };
export type Quality = {
  pairRouting?: import("@fabdesk/protocol").PairRouting;
  nets: NetFacts[];
  pairs: Array<{
    p: string;
    n: string;
    identification: "declared" | "native netclass" | "native diff-pair rule" | "identified by name";
    lengthPMm: number;
    lengthNMm: number;
    skewMm: number;
    viasP: number;
    viasN: number;
  }>;
  reference: NetFacts[];
  lengthConvention: string;
};
const round = (n: number) => Math.round(n * 1000) / 1000;
const children = (n: Node[], key: string) =>
  n.filter((v): v is Node[] => Array.isArray(v) && v[0] === key);
const child = (n: Node[], key: string) => children(n, key)[0] ?? [];
const number = (n: Node[], key: string, i = 1) => Number(child(n, key)[i] ?? 0);
const str = (n: Node[], key: string, i = 1) => String(child(n, key)[i] ?? "");

function sexpressions(text: string): Node[] {
  const stack: Node[][] = [[]];
  for (const token of text.match(/\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+/g) ?? []) {
    if (token === "(") {
      const n: Node[] = [];
      stack.at(-1)!.push(n);
      stack.push(n);
    } else if (token === ")") {
      if (stack.length < 2) throw new Error("unbalanced PCB");
      stack.pop();
    } else stack.at(-1)!.push(token.startsWith('"') ? (JSON.parse(token) as string) : token);
  }
  if (stack.length !== 1) throw new Error("unbalanced native file");
  return stack[0]!;
}
export function copperBoard(text: string): CopperBoard {
  const root = sexpressions(text)[0];
  if (!Array.isArray(root)) throw new Error("invalid PCB");
  if (root[0] !== "kicad_pcb") throw new Error("expected kicad_pcb");
  const names = new Map(children(root, "net").map((n) => [String(n[1]), String(n[2] ?? n[1])]));
  const netOf = (n: Node[]) => {
    const v = child(n, "net");
    const last = String(v.at(-1) ?? "");
    return names.get(last) ?? last;
  };
  const allNets = new Set(names.values());
  const walk = (n: Node[]) => {
    if (child(n, "net").length) allNets.add(netOf(n));
    for (const v of n) if (Array.isArray(v)) walk(v);
  };
  walk(root);
  const copper = [
    ...children(root, "segment"),
    ...children(root, "arc"),
    ...children(root, "via"),
  ].map((n, i): Copper => {
    const via = n[0] === "via";
    const signature = JSON.stringify({
      net: netOf(n),
      kind: n[0],
      layer: child(n, "layer").slice(1),
      layers: child(n, "layers").slice(1),
      start: child(n, "start").slice(1).map(Number),
      end: child(n, "end").slice(1).map(Number),
      mid: child(n, "mid").slice(1).map(Number),
      at: child(n, "at").slice(1).map(Number),
      width: number(n, "width"),
      size: number(n, "size"),
      drill: number(n, "drill"),
    });
    return {
      signature,
      id: str(n, "uuid") || str(n, "tstamp") || `anonymous-${i}`,
      net: netOf(n),
      layer: via ? child(n, "layers").slice(1).map(String) : [str(n, "layer")],
      locked: n.includes("locked") || (child(n, "locked").length > 0 && str(n, "locked") !== "no"),
      length: via
        ? 0
        : Math.hypot(
            number(n, "end", 1) - number(n, "start", 1),
            number(n, "end", 2) - number(n, "start", 2),
          ),
      ...(via
        ? { diameter: number(n, "size"), drill: number(n, "drill") }
        : { width: number(n, "width") }),
    };
  });
  return {
    revision: createHash("sha256").update(text).digest("hex"),
    nets: [...allNets].filter(Boolean).sort(),
    copper,
  };
}

/** Native layer table, independent of an assembly parent's board defaults. */
export function routingCopperLayers(text: string): string[] {
  const root = sexpressions(text)[0];
  if (!Array.isArray(root) || root[0] !== "kicad_pcb") throw new Error("expected native PCB");
  const names = child(root, "layers").slice(1).flatMap(row => Array.isArray(row) && typeof row[1] === "string" && /^(?:F|B|In\d+)\.Cu$/.test(row[1]) ? [row[1]] : []);
  if (names.length < 2 || names.length > 32 || names.length % 2 !== 0 || new Set(names).size !== names.length || !names.includes("F.Cu") || !names.includes("B.Cu")) throw new Error("Native copper layers could not be verified for routing playback.");
  return ["F.Cu", ...names.filter(name => name !== "F.Cu" && name !== "B.Cu").sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0])), "B.Cu"];
}
export async function readCopper(dir: string) {
  return copperBoard(await readFile(join(dir, PROJECT_FILES.boardPcb), "utf8"));
}
export function netFacts(board: CopperBoard, nets = board.nets): NetFacts[] {
  return [...new Set(nets)].sort().map((net) => {
    const items = board.copper.filter((c) => c.net === net),
      tracks = items.filter((c) => c.width !== undefined),
      vias = items.filter((c) => c.diameter !== undefined);
    const weighted = new Map<number, number>();
    for (const t of tracks) weighted.set(t.width!, (weighted.get(t.width!) ?? 0) + t.length);
    const widthsMm = [...weighted.keys()].sort((a, b) => a - b);
    const dominantWidthMm =
      [...weighted].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
    const sizes = new Map(
      vias.map((v) => [`${v.diameter}/${v.drill}`, { diameterMm: v.diameter!, drillMm: v.drill! }]),
    );
    return {
      net,
      minWidthMm: widthsMm[0] ?? null,
      dominantWidthMm,
      lengthMm: round(tracks.reduce((s, t) => s + t.length, 0)),
      viaCount: vias.length,
      layers: [...new Set(items.flatMap((c) => c.layer))].sort(),
      widthsMm,
      viaSizes: [...sizes.values()].sort(
        (a, b) => a.diameterMm - b.diameterMm || a.drillMm - b.drillMm,
      ),
    };
  });
}
export function quality(
  board: CopperBoard,
  nets: string[],
  declared: PairDefinition[] = [],
  reference: NetFacts[] = [],
): Quality {
  const seen = new Set(declared.flatMap((p) => [p.p, p.n]));
  const pairs: Array<
    PairDefinition & {
      identification:
        | "declared"
        | "native netclass"
        | "native diff-pair rule"
        | "identified by name";
    }
  > = declared.map((p) => ({ ...p, identification: p.source ?? "declared" }));
  for (const p of board.nets) {
    if (seen.has(p)) continue;
    for (const [positive, negative] of [
      ["DP", "DN"],
      ["_P", "_N"],
      ["+", "-"],
    ]) {
      if (!p.endsWith(positive!)) continue;
      const n = p.slice(0, -positive!.length) + negative!;
      if (board.nets.includes(n) && !seen.has(n)) {
        pairs.push({ p, n, identification: "identified by name" });
        seen.add(p);
        seen.add(n);
        break;
      }
    }
  }
  const scope = new Set(nets);
  const scopedPairs = pairs.filter((p) => scope.has(p.p) || scope.has(p.n));
  const facts = netFacts(board, [...nets, ...scopedPairs.flatMap((p) => [p.p, p.n])]);
  const byNet = new Map(facts.map((n) => [n.net, n]));
  return {
    nets: facts,
    pairs: scopedPairs
      .filter((p) => byNet.has(p.p) && byNet.has(p.n))
      .map((p) => {
        const a = byNet.get(p.p)!,
          b = byNet.get(p.n)!;
        return {
          p: p.p,
          n: p.n,
          identification: p.identification,
          lengthPMm: a.lengthMm,
          lengthNMm: b.lengthMm,
          skewMm: round(Math.abs(a.lengthMm - b.lengthMm)),
          viasP: a.viaCount,
          viasN: b.viaCount,
        };
      }),
    reference,
    lengthConvention: "planar start/end chord sum (including arcs), mm; no via barrel length",
  };
}
const referencePath = (dir: string) => join(dir, ".fabdesk", "removed-copper.json");
type Reference = { version: 1; revision: string; nets: NetFacts[] };
async function readReference(dir: string): Promise<Reference | null> {
  try {
    return JSON.parse(await readFile(referencePath(dir), "utf8")) as Reference;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function referenceFacts(dir: string, revision: string) {
  const r = await readReference(dir);
  return r?.revision === revision ? r.nets : [];
}
export async function recordRemoval(dir: string, before: CopperBoard, after: CopperBoard) {
  const remaining = new Set(after.copper.map((c) => c.id));
  const removed = before.copper.filter((c) => !remaining.has(c.id));
  if (!removed.length) {
    const prior = await referenceFacts(dir, before.revision);
    if (prior.length)
      await writeJson(referencePath(dir), { version: 1, revision: after.revision, nets: prior });
    return null;
  }
  const nets = [...new Set(removed.map((c) => c.net))].filter(Boolean);
  const prior = await referenceFacts(dir, before.revision);
  const baseline = new Map(prior.map((n) => [n.net, n]));
  for (const n of netFacts(before, nets)) if (!baseline.has(n.net)) baseline.set(n.net, n);
  await writeJson(referencePath(dir), {
    version: 1,
    revision: after.revision,
    nets: [...baseline.values()],
  });
  return {
    nets: netFacts({ ...before, copper: removed }, nets),
    reference: netFacts(before, nets),
    path: ".fabdesk/removed-copper.json",
  };
}
export async function consumeReference(
  dir: string,
  beforeRevision: string,
  afterRevision: string,
  completed: string[],
) {
  const nets = (await referenceFacts(dir, beforeRevision)).filter(
    (n) => !completed.includes(n.net),
  );
  await writeJson(referencePath(dir), { version: 1, revision: afterRevision, nets });
}
export function qualityText(q: Quality, maxBytes = 1800) {
  const ref = new Map(q.reference.map((n) => [n.net, n]));
  const lines =
    q.pairRouting?.pairs.map(
      (p) =>
        `${p.p}/${p.n}: ${p.status}; capability ${q.pairRouting!.capability}${p.reason ? `; ${p.reason}` : ""}`,
    ) ?? [];
  for (const p of q.pairs) {
    const a = ref.get(p.p),
      b = ref.get(p.n);
    lines.push(
      `${p.p}/${p.n} (${p.identification}): skew ${a && b ? `${round(Math.abs(a.lengthMm - b.lengthMm))} → ` : ""}${p.skewMm} mm; vias ${a && b ? `${a.viaCount}/${b.viaCount} → ` : ""}${p.viasP}/${p.viasN}`,
    );
  }
  lines.push(
    ...q.nets.map((n) => {
      const r = ref.get(n.net);
      return `${n.net}: width ${r ? `${r.minWidthMm} → ` : ""}${n.minWidthMm} mm (dominant ${n.dominantWidthMm}); length ${n.lengthMm} mm; vias ${n.viaCount}; layers ${n.layers.join(",")}`;
    }),
  );
  let out = "Routing quality:\n";
  for (const line of lines) {
    if (Buffer.byteLength(out + line) > maxBytes - 100) {
      out += "Full detail in quality.json.";
      break;
    }
    out += line + "\n";
  }
  return out.trimEnd();
}

export type QualityWarning = { kind: "narrowing" | "skew"; text: string };
export function compareQuality(
  before: Quality,
  after: Quality,
  opens: { before: number; after: number },
  outside: number,
) {
  const warnings: QualityWarning[] = [];
  const lines = [
    `Opens: ${opens.before} → ${opens.after}${opens.after ? `; partial, ${opens.after} opens left` : "; complete"}.`,
    `Copper outside request changed: ${outside}.`,
  ];
  const beforeNets = new Map(before.nets.map((n) => [n.net, n]));
  const reference = new Map(before.reference.map((n) => [n.net, n]));
  for (const net of after.nets) {
    const old = beforeNets.get(net.net);
    const baselineWidth =
      Math.max(old?.minWidthMm ?? 0, reference.get(net.net)?.minWidthMm ?? 0) || null;
    const narrowed =
      baselineWidth != null && net.minWidthMm != null && net.minWidthMm < baselineWidth - 0.000001;
    lines.push(
      `${net.net}: minimum width ${baselineWidth ?? "none"} → ${net.minWidthMm ?? "none"} mm${narrowed ? "; WARNING narrowing" : ""}.`,
    );
    if (narrowed)
      warnings.push({
        kind: "narrowing",
        text: `${net.net}: existing minimum width ${baselineWidth} → ${net.minWidthMm} mm`,
      });
  }
  for (const pair of after.pairs) {
    const old = before.pairs.find((p) => p.p === pair.p && p.n === pair.n)!;
    const rp = reference.get(pair.p),
      rn = reference.get(pair.n);
    const limit = rp && rn ? round(Math.abs(rp.lengthMm - rn.lengthMm)) : old.skewMm;
    const hasReference =
      rp && rn ? rp.lengthMm > 0 && rn.lengthMm > 0 : old.lengthPMm > 0 && old.lengthNMm > 0;
    const worse =
      pair.identification !== "identified by name" && hasReference && pair.skewMm > limit + 0.001;
    lines.push(
      `${pair.p}/${pair.n}: skew ${old.skewMm} → ${pair.skewMm} mm${rp && rn ? ` (before edit ${limit})` : ""}; vias ${old.viasP}/${old.viasN} → ${pair.viasP}/${pair.viasN}${worse ? "; WARNING increased skew" : ""}.`,
    );
    if (worse)
      warnings.push({
        kind: "skew",
        text: `${pair.p}/${pair.n}: skew ${pair.skewMm} mm exceeds reference ${limit} mm`,
      });
  }
  return { opens, outsideScopeItems: outside, warnings, text: lines.join("\n") };
}

/** KiCad net-name wildcards are strings, not filesystem paths: * and ? cross / too. */
export function netPatternMatches(pattern: string, net: string) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(net);
}
function pairClassName(name: string, pair: PairDefinition) {
  if (/(?:^|[^a-z])(?:diff(?:erential)?|pairs?)(?:$|[^a-z])/i.test(name)) return true;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const stem = pair.p
    .split("/")
    .at(-1)!
    .replace(/(?:_P|\+|P)$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return (
    !["default", "power", "signal", "signals"].includes(key) &&
    key.length >= 2 &&
    stem.includes(key)
  );
}
/** Only explicit pair intent supplies dimensions; fields saved on every KiCad class do not. */
export async function projectPairs(
  dir: string,
  board: CopperBoard,
  declared: PairDefinition[] = [],
): Promise<PairDefinition[]> {
  const named = quality(board, board.nets, declared).pairs;
  let settings: any;
  try {
    settings = JSON.parse(await readFile(join(dir, PROJECT_FILES.boardPro), "utf8"))?.net_settings;
  } catch {
    /* Older native boards may have no project sidecar; names remain measurable. */
  }
  const classes: Array<{
    name: string;
    diff_pair_width?: number;
    diff_pair_gap?: number;
    priority?: number;
  }> = settings?.classes ?? [];
  let rules: Node[] = [];
  try {
    const text = await readFile(join(dir, "board.kicad_dru"), "utf8");
    rules = sexpressions(
      text.replace(/"(?:[^"\\]|\\.)*"|#[^\n]*/g, (token) => (token.startsWith("#") ? "" : token)),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const forNet = (net: string, pair: PairDefinition) => {
    const exact = settings?.netclass_assignments?.[net];
    const assignments: string[] = exact ? (Array.isArray(exact) ? exact : [exact]) : [];
    const targeted = new Set<string>();
    for (const p of settings?.netclass_patterns ?? []) {
      if (netPatternMatches(p.pattern, net)) assignments.push(p.netclass);
      // A broad assignment (*) is not a pair signal. Require a literal from the pair stem.
      const literal = p.pattern
        .split("/")
        .at(-1)!
        .replace(/[*?]/g, "")
        .replace(/[^a-z0-9]/gi, "");
      const stem = pair.p
        .split("/")
        .at(-1)!
        .replace(/(?:_P|\+|P)$/, "")
        .replace(/[^a-z0-9]/gi, "");
      if (
        literal &&
        stem.includes(literal) &&
        netPatternMatches(p.pattern, pair.p) &&
        netPatternMatches(p.pattern, pair.n)
      )
        targeted.add(p.netclass);
    }
    // Require pair intent in addition to assignment; KiCad writes pair dimensions on Power too.
    return classes
      .filter(
        (c) =>
          assignments.includes(c.name) && (pairClassName(c.name, pair) || targeted.has(c.name)),
      )
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
  };
  return named.map((pair) => {
    const explicit = declared.find((p) => p.p === pair.p && p.n === pair.n);
    if (explicit) return explicit;
    const pc = forNet(pair.p, pair),
      nc = forNet(pair.n, pair),
      width = pc?.diff_pair_width ?? nc?.diff_pair_width,
      gap = pc?.diff_pair_gap ?? nc?.diff_pair_gap;
    // Recognize unconditioned rules and simple KiCad net-name/class selectors. Complex
    // expressions remain KiCad's responsibility; never guess that they apply to a pair.
    const nativeRule = children(rules, "rule").some((rule) => {
      if (!children(rule, "constraint").some((c) => String(c[1]).startsWith("diff_pair_")))
        return false;
      const condition = str(rule, "condition");
      if (!condition) return true;
      const selector = /^A\.(NetName|NetClass)\s*==\s*'([^']*)'$/.exec(condition);
      if (!selector) return false;
      if (selector[1] === "NetName")
        return [pair.p, pair.n].every((net) => netPatternMatches(selector[2]!, net));
      return [pair.p, pair.n].every((net) => {
        const exact = settings?.netclass_assignments?.[net];
        const assignments: string[] = exact ? [exact].flat() : [];
        for (const p of settings?.netclass_patterns ?? [])
          if (netPatternMatches(p.pattern, net)) assignments.push(p.netclass);
        if (!assignments.length) assignments.push("Default");
        return assignments.includes(selector[2]!);
      });
    });
    return {
      p: pair.p,
      n: pair.n,
      source:
        width !== undefined || gap !== undefined
          ? ("native netclass" as const)
          : nativeRule
            ? ("native diff-pair rule" as const)
            : ("identified by name" as const),
      ...(width !== undefined && width > 0 ? { widthMm: width } : {}),
      ...(gap !== undefined ? { gapMm: gap } : {}),
    };
  });
}

/** Keep public summaries bounded without cutting a UTF-8 codepoint; JSON retains full detail. */
export function boundedQualityText(text: string, maxBytes = 1800) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = "\nFull detail in quality.json.";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  let out = "",
    bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > budget) break;
    out += char;
    bytes += size;
  }
  return out + suffix;
}
