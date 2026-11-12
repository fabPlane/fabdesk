/**
 * Merge one router result onto a copy of a native project and score it (port of `score_route.py` and
 * `apply_netclasses.py`): the board's own rules re-applied, KiCad DRC with refilled zones, then A1-A9 against the
 * board's requirements. The ranking figures are open connections, A8 pair nets and A7 width nets.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { checkAcceptance, type AcceptanceResult, type DrcInput } from "../accept";
import { parseBoard } from "../board";
import { readJsonOrNull } from "../files";
import type { Acceptance, Requirements } from "../requirements";
import { REQUIREMENT_FILES } from "../requirements";
import { addNewCopper, nameCopperNets, numericNetCopper, replaceCopper, type MergeStats } from "./text";
import { sesImport } from "./ses";

export async function readRequirementsDir(dir: string): Promise<Requirements> {
  const [acceptance, circuit, mechanical, heights] = await Promise.all(
    (["acceptance", "circuit", "mechanical", "heights"] as const).map((k) => readJsonOrNull<never>(join(dir, REQUIREMENT_FILES[k]))),
  );
  if (!acceptance || !circuit || !mechanical || !heights) throw new Error(`requirements incomplete in ${dir} (acceptance, circuit, mechanical, heights .json)`);
  return { acceptance, circuit, mechanical, heights } as Requirements;
}

const SKIP = new Set(["tm", "acceptance.json", "import.json", "score.json"]);
/** Names a board copy leaves out (the toolkit's `ignore_patterns('tm', 'acceptance*.json', 'import.json', 'score.json')`). */
export const scoreCopyFilter = (name: string) => !(SKIP.has(name) || /^acceptance.*\.json$/.test(name));
/** Names a seed's copy leaves out. */
export const seedCopyFilter = (name: string) => !(/\.kicad_prl$/.test(name) || /^acceptance.*\.json$/.test(name) || ["score.json", "import.json", "tm"].includes(name) || name.startsWith("tm-"));

export async function copyDir(src: string, dst: string, keep: (name: string) => boolean): Promise<void> {
  await cp(src, dst, { recursive: true, filter: (s) => s === src || keep(basename(s)) });
}

/**
 * Apply the acceptance's rules and net classes to a `.kicad_pro` copy and write its `.kicad_dru` (power widths, neck
 * proxy, scoped rules). A board whose acceptance keeps its native rules is left alone.
 */
export async function applyNetclasses(proPath: string, acc: Acceptance): Promise<string> {
  const mr = acc.manufacturing_rules;
  if (mr.native_project_rules) return `native project rules kept (${basename(proPath)})`;
  const pro = JSON.parse(await readFile(proPath, "utf8")) as Record<string, any>;
  const rules = ((pro["board"] ??= {}).design_settings ??= {}).rules ??= {};
  const d = mr.adopted.default_class;
  rules.min_track_width = mr.adopted.min_track_width;
  rules.min_clearance = mr.adopted.min_clearance;
  const clearance = acc.net_classes.class_clearance;
  const classes: unknown[] = [{ name: "Default", clearance: d.clearance, track_width: d.track_width, via_diameter: d.via_diameter, via_drill: d.via_drill, diff_pair_width: d.track_width, diff_pair_gap: 0.2 }];
  const patterns: unknown[] = [];
  for (const [name, c] of Object.entries(acc.net_classes.classes)) {
    classes.push({ name, clearance, track_width: c.track_width, via_diameter: d.via_diameter, via_drill: d.via_drill, diff_pair_width: c.diff_pair_width ?? c.track_width, diff_pair_gap: c.diff_pair_gap ?? 0.2 });
    const nets = c.nets?.length ? c.nets : (c.pairs ?? []).flat();
    for (const n of nets) patterns.push({ netclass: name, pattern: n });
  }
  (pro["net_settings"] ??= {}).classes = classes;
  pro["net_settings"].netclass_patterns = patterns;
  await writeFile(proPath, JSON.stringify(pro, null, 2) + "\n");

  const wr = acc.net_classes.router_width_rules;
  const text = ["(version 1)"];
  for (const [name, c] of Object.entries(acc.net_classes.classes)) {
    if (!name.startsWith("PWR_")) continue;
    const w = c.track_width!;
    text.push(`(rule "${name} outer width"\n  (condition "A.NetClass == '${name}'")\n  (layer outer)\n  (constraint track_width (min ${w}mm) (opt ${w}mm)))`);
    const iw = c.inner_track_width;
    if (iw === null || iw === undefined)
      text.push(`(rule "${name} outer only"\n  (condition "A.NetClass == '${name}'")\n  (layer inner)\n  (constraint disallow track))`);
    else text.push(`(rule "${name} inner width"\n  (condition "A.NetClass == '${name}'")\n  (layer inner)\n  (constraint track_width (min ${iw}mm) (opt ${iw}mm)))`);
  }
  for (const [name, c] of Object.entries(acc.net_classes.classes))
    if (name.startsWith("PWR_"))
      text.push(`(rule "${name} neck in courtyard"\n  (condition "A.NetClass == '${name}' && A.intersectsCourtyard('*')")\n  (layer outer)\n  (constraint track_width (min ${wr.neck_floor_mm}mm) (opt ${c.track_width}mm)))`);
  for (const r of (mr.scoped_rules ?? []) as Array<{ name: string; condition: string; constraint: string }>)
    text.push(`(rule "${r.name}"\n  (condition "${r.condition}")\n  (constraint ${r.constraint}))`);
  await writeFile(proPath.replace(/\.kicad_pro$/, ".kicad_dru"), text.join("\n") + "\n");
  return `${classes.length} classes, ${patterns.length} net patterns; ${text.length - 1} rules`;
}

export type MergeMode =
  | { kind: "tm"; source: string; routed: string; replace: boolean }
  | { kind: "ses"; ses: string }
  | { kind: "as-is" };

export interface Score {
  summary: AcceptanceResult["summary"];
  open: number;
  open_capped: boolean;
  drc_errors: unknown;
  below_board_min_width: number;
  A7_nets_failing: number;
  A7_undersize_mm: number;
  A8_nets_failing: number;
  import: MergeStats;
}

/** What scoring needs from the host. */
export interface ScoreHost {
  /** KiCad DRC with refilled zones (and schematic parity when asked). */
  drc(board: string, outFile: string, parity: boolean): Promise<DrcInput>;
  /** Schematic parity costs most of a DRC run and routing cannot change it; off unless a stage asks. */
  parity?: boolean;
}

/** Fields compared run to run (the toolkit's `flow.score_of`). */
export interface ScoreFigures {
  open: number | null;
  A7: number | null;
  A8: number | null;
  drc: unknown;
  capped: boolean | null;
  dir: string;
}

export async function scoreRoute(host: ScoreHost, req: Requirements, stem: string, base: string, out: string, mode: MergeMode): Promise<Score> {
  await copyDir(base, out, scoreCopyFilter);
  const board = join(out, `${stem}.kicad_pcb`);
  let stats: MergeStats;
  if (mode.kind === "as-is") stats = { mode: "as-is" };
  else if (mode.kind === "ses") {
    const r = sesImport(await readFile(board, "utf8"), await readFile(mode.ses, "utf8"));
    await writeFile(board, r.text);
    stats = { mode: "ses", ...r.stats };
  } else {
    const native = await readFile(board, "utf8");
    const routed = nameCopperNets(await readFile(mode.routed, "utf8")).text;
    const r = mode.replace ? replaceCopper(native, routed) : addNewCopper(native, nameCopperNets(await readFile(mode.source, "utf8")).text, routed);
    await writeFile(board, r.text);
    stats = r.stats;
  }
  const merged = await readFile(board, "utf8");
  const numeric = numericNetCopper(merged);
  if (numeric) throw new Error(`${numeric} copper items name their net by number after the merge; scoring would match none of them`);
  await writeFile(join(out, "import.json"), JSON.stringify(stats));
  await applyNetclasses(join(out, `${stem}.kicad_pro`), req.acceptance);
  const drcFile = join(out, "acceptance.drc.json");
  const drc = await host.drc(board, drcFile, host.parity === true);
  const result = checkAcceptance(parseBoard(await readFile(board, "utf8")), req, drc, { parityChecked: host.parity === true, boardPath: board });
  await writeFile(join(out, "acceptance.json"), JSON.stringify(result, null, 1) + "\n");
  const r = result.results;
  const widths = drc.violations
    .filter((v) => v.rule === "track_width")
    .flatMap((v) => {
      const m = /actual ([\d.]+)/.exec(v.description);
      return m ? [Number(m[1])] : [];
    });
  const undersize = Object.values((r.A7_widths["undersize_length_mm"] ?? {}) as Record<string, number>).reduce((s, v) => s + v, 0);
  const unconnected = Number(r.A1_connectivity["unconnected"]);
  const score: Score = {
    summary: result.summary,
    open: unconnected,
    open_capped: unconnected >= 499, // kicad-cli lists at most 499 unconnected items
    drc_errors: r.A2_drc["errors"] ?? null,
    below_board_min_width: widths.filter((w) => w < 0.123 - 1e-4).length,
    A7_nets_failing: Number(r.A7_widths["nets_failing"]),
    A7_undersize_mm: Math.round(undersize * 100) / 100,
    A8_nets_failing: Number(r.A8_pairs["nets_failing"]),
    import: stats,
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "score.json"), JSON.stringify(score, null, 1) + "\n");
  return score;
}

export async function scoreOf(dir: string): Promise<ScoreFigures | null> {
  const s = await readJsonOrNull<Score>(join(dir, "score.json"));
  if (!s) return null;
  return { open: s.open ?? null, A7: s.A7_nets_failing ?? null, A8: s.A8_nets_failing ?? null, drc: s.drc_errors ?? null, capped: s.open_capped ?? null, dir };
}

/** Rank key: fewer open connections, then A8 pair nets, then A7 width nets. */
export function rankKey(s: ScoreFigures): [number, number, number] {
  return [s.open ?? 1e9, s.A8 || 0, s.A7 || 0];
}
export function cmpScore(a: ScoreFigures, b: ScoreFigures): number {
  const x = rankKey(a), y = rankKey(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
