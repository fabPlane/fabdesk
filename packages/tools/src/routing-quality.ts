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
  id: string;
  net: string;
  layer: string[];
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
    identification: "declared" | "identified by name";
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

export function copperBoard(text: string): CopperBoard {
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
  if (stack.length !== 1 || !Array.isArray(stack[0]![0])) throw new Error("invalid PCB");
  const root = stack[0]![0] as Node[];
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
    return {
      id: str(n, "uuid") || str(n, "tstamp") || `anonymous-${i}`,
      net: netOf(n),
      layer: via ? child(n, "layers").slice(1).map(String) : [str(n, "layer")],
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
  const pairs: Array<PairDefinition & { identification: "declared" | "identified by name" }> =
    declared.map((p) => ({ ...p, identification: "declared" }));
  for (const p of board.nets) {
    if (seen.has(p)) continue;
    for (const [positive, negative] of [
      ["_DP", "_DN"],
      ["_P", "_N"],
      ["+", "-"],
      ["P", "N"],
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
  const facts = netFacts(board, [
    ...nets,
    ...pairs.filter((p) => nets.includes(p.p) || nets.includes(p.n)).flatMap((p) => [p.p, p.n]),
  ]);
  const byNet = new Map(facts.map((n) => [n.net, n]));
  return {
    nets: facts,
    pairs: pairs
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
