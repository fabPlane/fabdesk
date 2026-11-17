/**
 * The toolkit's candidate flows as plan keys: `copper` (flow/copper_plan.py), `hole` (flow/mechanical_hole.py) and
 * `stack` (flow/stack_plan.py). Impact previews them on the source board; apply runs them in the candidate (stack's
 * board half first, hole and copper after the moves), so they go through the same proof, diff and adopt as the others.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { readBoard } from "../board";
import { kid, kids, parseSexpr } from "../sexpr";
import { copperNets, copperPlan, sha256, type CopperLedger, type CopperSpec } from "./copper";
import type { EditEnv } from "./env";
import { holeEdit, projectLibFile, type HoleRecord } from "./hole";
import type { EditPlan } from "./plan";
import { EditStop } from "./sch";
import { dielectricsOf, stackAcceptance, stackBoard, stackViaNets } from "./stack";
import { footprintSpans } from "./text";

export interface CopperImpact {
  vias: Array<{ pad: string; net: string; at: [number, number] }>;
  removed: { explicit: number; single_layer_vias: number; leaf_tracks: number };
  nets: string[];
  note?: string;
}
export interface HoleImpact {
  ref: string;
  centre: [number, number];
  from: { shape: string; size: string; drill: string };
  to: [number, number];
  clearance_mm: number;
  library_file: string;
}
export interface StackImpact {
  classes_updated: string[];
  classes_split: Record<string, { from: string; nets?: string[]; pairs?: string[][] }>;
  acceptance_keys: string[];
  removed_paths: string[];
  dielectrics: Record<string, [string | null, number]>;
  remove_vias: Array<{ uuid: string; net: string; reason: string }>;
  copper_source: string | null;
}
export interface KeysImpact {
  copper?: CopperImpact;
  hole?: HoleImpact;
  stack?: StackImpact;
}

export interface StackLog {
  classes_updated: string[];
  classes_split: string[];
  removed_paths: string[];
  dielectrics: Record<string, number>;
  removed_vias: Array<{ uuid: string; net: string; reason: string }>;
  copper_source: string | null;
  changed_copper: boolean;
  /** Nets whose copper the plan changes on purpose (the removed vias' nets; with copper_source every net it changes). */
  nets: string[];
}
export interface CopperLog {
  added_vias: number;
  removed: { explicit: number; single_layer_vias: number; leaf_tracks: number };
  nets: string[];
}

const counts = (l: CopperLedger) => ({
  explicit: l.removed.filter((r) => r.kind === "explicit-item").length,
  single_layer_vias: l.removed.filter((r) => r.kind === "single-layer-via").length,
  leaf_tracks: l.removed.filter((r) => r.kind === "leaf-track").length,
});

/** `copper` without its guard (the pipeline checks source_sha256 against the source board, whatever ran before it). */
function guarded(spec: CopperSpec, sourceText: string): CopperSpec {
  if (spec.source_sha256 && sha256(sourceText) !== spec.source_sha256)
    throw new EditStop(`FAIL copper: Source revision mismatch (source_sha256 ${spec.source_sha256.slice(0, 12)}..., the board is ${sha256(sourceText).slice(0, 12)}...)`);
  const { source_sha256: _s, ...rest } = spec;
  return rest;
}

/** A project file named by the plan: inside the project, existing. */
export function projectFile(projectDir: string, rel: string, what: string): string {
  const p = resolve(projectDir, rel);
  if (relative(projectDir, p).startsWith("..") || !existsSync(p)) throw new EditStop(`FAIL ${what}: ${rel} is not a file in the project`);
  return p;
}

function libOf(env: EditEnv, text: string, ref: string): { path: string; rel: string; text: string } {
  const span = footprintSpans(text).get(ref);
  if (!span) throw new EditStop(`FAIL hole: ${ref}: not on the board`);
  const libId = /^\(footprint "([^"]+)"/.exec(text.slice(span.start, span.end))?.[1] ?? "";
  const path = projectLibFile(env.projectDir, libId);
  if (!path || !existsSync(path)) throw new EditStop(`FAIL hole: ${ref}'s library footprint ${libId} is not in a project library (fp-lib-table, \${KIPRJMOD}): the toolkit resizes the board and the library together`);
  return { path, rel: relative(env.projectDir, path), text: readFileSync(path, "utf8") };
}

/** Each net's tracks and vias, as a comparable signature (for the nets a copper_source changes). */
function netItems(text: string): Map<string, string> {
  const m = new Map<string, string[]>();
  const add = (n: string, s: string) => (m.get(n) ?? m.set(n, []).get(n)!).push(s);
  const b = readBoard(parseSexpr(text));
  for (const s of b.segments) add(s.net, `s ${s.a.join(",")} ${s.b.join(",")} ${s.w} ${s.layer}`);
  for (const v of b.vias) add(v.net, `v ${v.x},${v.y} ${v.size} ${v.layers.join(",")}`);
  return new Map([...m].map(([k, v]) => [k, v.sort().join(";")]));
}
function changedNets(a: string, b: string): string[] {
  const x = netItems(a), y = netItems(b);
  return [...new Set([...x.keys(), ...y.keys()])].filter((n) => n && x.get(n) !== y.get(n)).sort();
}

/** Impact of the new keys on the source board. EditStop messages become FAIL review lines. */
export function impactKeys(plan: EditPlan, env: EditEnv, review: string[]): KeysImpact {
  const out: KeysImpact = {};
  const text = env.pcbText;
  const tryIt = (f: () => void) => {
    try {
      f();
    } catch (e) {
      if (!(e instanceof EditStop)) throw e;
      review.push(e.message.startsWith("FAIL") || e.message.startsWith("STOP") ? e.message : `FAIL ${e.message}`);
    }
  };
  if (plan.stack)
    tryIt(() => {
      const s = plan.stack!;
      let board = text;
      if (s.copper_source) board = readFileSync(projectFile(env.projectDir, s.copper_source, "stack copper_source"), "utf8");
      const before = dielectricsOf(board);
      stackBoard(board, s);
      const acc = JSON.parse(JSON.stringify(env.req.acceptance)) as Record<string, unknown>;
      const r = stackAcceptance(acc, s);
      out.stack = {
        classes_updated: r.updated,
        classes_split: Object.fromEntries(Object.entries(s.split_classes ?? {}).map(([n, c]) => [n, { from: c.from, ...(c.nets ? { nets: c.nets } : {}), ...(c.pairs ? { pairs: c.pairs } : {}) }])),
        acceptance_keys: Object.keys(s.acceptance ?? {}),
        removed_paths: r.removed_paths,
        dielectrics: Object.fromEntries(Object.entries(s.dielectrics ?? {}).map(([k, d]) => [k, [before[k] ?? null, d.er]])),
        remove_vias: s.remove_vias ?? [],
        copper_source: s.copper_source ?? null,
      };
      for (const v of s.remove_vias ?? []) review.push(`stack: via ${v.uuid} on ${v.net} removed: ${v.reason}`);
      if (s.copper_source) review.push(`stack: the board is taken from ${s.copper_source} (its copper changes ${changedNets(text, board).length} net(s)); the proof judges that board`);
    });
  if (plan.hole)
    tryIt(() => {
      const h = plan.hole!;
      const lib = libOf(env, text, h.ref);
      const r = holeEdit(text, h, lib.text);
      const span = footprintSpans(text).get(h.ref)!;
      const fp = parseSexpr(text.slice(span.start, span.end));
      const pad = kids(fp, "pad")[0]!;
      out.hole = {
        ref: h.ref,
        centre: r.centre,
        from: { shape: String(pad[3] ?? ""), size: (kid(pad, "size") ?? []).slice(1).join(" "), drill: (kid(pad, "drill") ?? []).slice(1).join(" ") },
        to: h.size_mm,
        clearance_mm: h.clearance_mm ?? 0.25,
        library_file: lib.rel,
      };
    });
  if (plan.copper)
    tryIt(() => {
      const spec = guarded(plan.copper!, text);
      const r = copperPlan(text, spec, () => "00000000-0000-4000-8000-000000000000");
      const pads = readBoard(parseSexpr(text)).pads;
      out.copper = {
        vias: (spec.via_at_pad ?? []).map((v) => {
          const p = pads.find((q) => q.ref === v.ref && q.pad === String(v.pad))!;
          return { pad: `${v.ref}.${v.pad}`, net: p.net, at: [p.x, p.y] as [number, number] };
        }),
        removed: counts(r.ledger),
        nets: copperNets(text, spec, r.ledger),
        ...(plan.move?.length || plan.remove?.length || plan.add?.length || plan.swap?.length || plan.net?.length ? { note: "previewed on the source board; apply runs it after the plan's other board changes" } : {}),
      };
    });
  return out;
}

export function keysImpactLines(k: KeysImpact): string[] {
  const out: string[] = [];
  if (k.stack) {
    const s = k.stack;
    if (s.copper_source) out.push(`stack copper_source ${s.copper_source}`);
    for (const c of s.classes_updated) out.push(`stack class ${c} updated`);
    for (const [n, c] of Object.entries(s.classes_split)) out.push(`stack class ${n} split from ${c.from}: ${JSON.stringify(c.nets ?? c.pairs)}`);
    if (s.acceptance_keys.length) out.push(`stack acceptance merge: ${s.acceptance_keys.join(", ")}`);
    for (const p of s.removed_paths) out.push(`stack acceptance remove ${p}`);
    for (const [l, [a, b]] of Object.entries(s.dielectrics)) out.push(`stack ${l} epsilon_r ${a ?? "?"} -> ${b}`);
  }
  if (k.hole) {
    const h = k.hole;
    out.push(`hole  ${h.ref} at [${h.centre.join(", ")}]: ${h.from.shape} ${h.from.size} (drill ${h.from.drill}) -> ${h.to[0] === h.to[1] ? "circle" : "oval"} ${h.to.join(" x ")} mm, courtyard/keep-out margin ${h.clearance_mm}; library ${h.library_file}`);
  }
  if (k.copper) {
    const c = k.copper;
    for (const v of c.vias) out.push(`copper via at ${v.pad} (${v.net}) [${v.at.map((x) => Math.round(x * 1e6) / 1e6).join(", ")}], filled/capped F-B`);
    out.push(`copper removed: ${c.removed.explicit} named item(s), ${c.removed.single_layer_vias} one-layer via(s), ${c.removed.leaf_tracks} leaf track piece(s); nets ${JSON.stringify(c.nets)}${c.note ? ` (${c.note})` : ""}`);
  }
  return out;
}

/** Stack's board half, first in the candidate: copper_source, named via removals, dielectrics. */
export function applyStackBoard(text: string, plan: EditPlan, env: EditEnv): { text: string; log: Omit<StackLog, "classes_updated" | "classes_split" | "removed_paths"> } {
  const s = plan.stack!;
  let board = text;
  let nets = stackViaNets(s);
  if (s.copper_source) {
    board = readFileSync(projectFile(env.projectDir, s.copper_source, "stack copper_source"), "utf8");
    nets = [...new Set([...nets, ...changedNets(text, board)])].sort();
  }
  const r = stackBoard(board, s);
  return {
    text: r.text,
    log: { dielectrics: Object.fromEntries(Object.entries(s.dielectrics ?? {}).map(([k, d]) => [k, d.er])), removed_vias: r.removed_vias, copper_source: s.copper_source ?? null, changed_copper: !!(s.copper_source || s.remove_vias?.length), nets },
  };
}

/** Hole in the candidate: the board text and the library file (project-relative path and new text). */
export function applyHole(text: string, plan: EditPlan, env: EditEnv): { text: string; libRel: string; libText: string; centre: [number, number] } {
  const lib = libOf(env, text, plan.hole!.ref);
  const r = holeEdit(text, plan.hole!, lib.text);
  return { text: r.text, libRel: lib.rel, libText: r.lib, centre: r.centre };
}

export function holeRecord(plan: EditPlan, sourceText: string, candidateText: string, centre: [number, number], libRel: string): HoleRecord {
  const h = plan.hole!;
  return { source_sha256: sha256(sourceText), candidate_sha256: sha256(candidateText), ref: h.ref, centre_mm: centre, size_mm: h.size_mm, clearance_mm: h.clearance_mm ?? 0.25, copper_authored: 0, library_file: libRel };
}

/** Copper in the candidate, last: guard on the source board, then copper_plan on the edited text. */
export function applyCopper(text: string, plan: EditPlan, env: EditEnv): { text: string; ledger: CopperLedger; log: CopperLog } {
  const spec = guarded(plan.copper!, env.pcbText);
  const r = copperPlan(text, spec);
  return { text: r.text, ledger: r.ledger, log: { added_vias: r.ledger.added_vias.length, removed: counts(r.ledger), nets: copperNets(text, spec, r.ledger) } };
}

export { stackAcceptance };
