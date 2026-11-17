/**
 * Seeded placement with the KiCadRoutingTools placer, every seed gated natively (port of `krt_place.py`):
 * fixed parts locked, KRT places each seed, the poses go back onto a copy of the native project, and KiCad's own
 * courtyard DRC and a fixed-parts-unmoved test decide which seeds may go on to routing.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copyDir, seedCopyFilter } from "./score";
import { FlowError, requireEngine, type LayoutHost } from "./ctx";
import { krtCheckFloorplan, krtCheckGroups, krtMakeUnplaced, krtPaths, krtPlaceSimple, placerSummary } from "./engines";
import type { Keepout } from "./spec";
import { convertTransforms, footprintSpans, lockFootprints, lockedRefs, pose, transferPoses } from "./text";
import { pathExists } from "./fsx";

export function parseSeeds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-");
    for (let i = Number(a); i <= Number(b ?? a); i++) out.push(i);
  }
  return out;
}

const COURTYARD = new Set(["courtyards_overlap", "npth_inside_courtyard", "pth_inside_courtyard"]);

/**
 * Courtyard findings from native DRC, as `{type: count}`. An overlap between two fixed parts is the design's own and
 * no placement can change it, so it is not counted when `fixed` is given.
 */
export async function nativeCourtyard(host: LayoutHost, board: string, report: string, fixed?: Set<string>): Promise<Record<string, number>> {
  const rows = await host.courtyardDrc(board, report);
  const counts: Record<string, number> = {};
  for (const v of rows) {
    if (!COURTYARD.has(v.rule)) continue;
    const refs = v.items.map((i) => (i.description.split("Footprint ").slice(1).join("Footprint ") || i.description).split(" ")[0]!);
    if (fixed && refs.length && refs.every((r) => fixed.has(r))) continue;
    counts[v.rule] = (counts[v.rule] ?? 0) + 1;
  }
  return counts;
}

export interface SeedRecord {
  placer?: Record<string, unknown>;
  error?: string;
  courtyard?: Record<string, number>;
  fixed_moved?: string[];
  gate?: boolean;
  route_wall_s?: number;
  score?: unknown;
}
export interface PlaceRecord {
  groups: string;
  placer_args: string;
  seeds: Record<string, SeedRecord>;
  locked_fixed?: string[];
  templates?: string[];
  keepouts?: string;
  prep_and_place_wall_s?: number;
}

export interface PlaceOptions {
  placed: string;
  out: string;
  stem: string;
  groups: string;
  seeds: string;
  fixed: RegExp;
  jobs: number;
  templates?: string[];
  keepouts?: Keepout[];
  clusteredSeeds?: string;
  placerArgs?: string;
  timeoutMs?: number;
}

/** Run the placer for the seeds and gate each; writes `<out>/place.json`. Throws FlowError when the placer's inputs are rejected. */
export async function placeKrt(host: LayoutHost, o: PlaceOptions): Promise<PlaceRecord> {
  const k = krtPaths(await requireEngine(host, "krt"));
  const kdir = join(o.out, "krt");
  await mkdir(kdir, { recursive: true });
  await copyFile(o.groups, join(o.out, "groups.json"));
  const rec: PlaceRecord = { groups: o.groups, placer_args: o.placerArgs ?? "", seeds: {} };
  const nativePath = join(o.placed, `${o.stem}.kicad_pcb`);
  let text = await readFile(nativePath, "utf8");
  const nativeSpans = footprintSpans(text);
  const fixedRefs = [...nativeSpans.keys()].filter((r) => o.fixed.test(r)).sort();
  // Lock every connector/switch/mechanical part, not only the mechanical anchors: place_simple moves anything left unlocked.
  text = lockFootprints(text, fixedRefs);
  rec.locked_fixed = fixedRefs;
  await writeFile(join(kdir, "native-locked.kicad_pcb"), text);
  await writeFile(join(kdir, `${o.stem}.kicad_pcb`), convertTransforms(text).text);
  for (const stem of [o.stem, "fixed"])
    for (const ext of ["kicad_pro", "kicad_dru"]) if (await pathExists(join(o.placed, `${o.stem}.${ext}`))) await copyFile(join(o.placed, `${o.stem}.${ext}`), join(kdir, `${stem}.${ext}`));
  const t0 = Date.now();
  const run = (cmd: string[], log: string, timeoutMs?: number) =>
    host.spawn(cmd, { cwd: k.plugins, log: join(kdir, log), ...(timeoutMs ? { timeoutMs } : {}), ...(host.signal ? { signal: host.signal } : {}), ...(host.onPid ? { onPid: host.onPid } : {}) });
  const fixedBoard = join(kdir, "fixed.kicad_pcb");
  await run([...k.python, krtMakeUnplaced(k), join(kdir, `${o.stem}.kicad_pcb`), fixedBoard, "--keep-locked"], "unplace.log");
  await run([...k.python, krtCheckFloorplan(k), fixedBoard, "--emit-intent", join(kdir, "intent.json")], "intent.log");
  const intentPath = join(kdir, "intent.json");
  if (o.templates?.length || o.keepouts?.length) {
    const intent = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, unknown[]>;
    if (o.templates?.length) {
      (intent["templates"] ??= []).push(...(await Promise.all(o.templates.map(async (t) => JSON.parse(await readFile(t, "utf8"))))));
      rec.templates = o.templates;
    }
    if (o.keepouts?.length) {
      (intent["keepouts"] ??= []).push(...o.keepouts.map(({ note: _n, ...ko }) => ko));
      rec.keepouts = join(o.out, "keepouts.json");
    }
    await writeFile(intentPath, JSON.stringify(intent, null, 1));
  }
  const groupsCheck = await run([...k.python, krtCheckGroups(k), fixedBoard, "--groups", o.groups], "groups.log");
  if (groupsCheck.code) throw new FlowError(`check_groups failed: ${join(kdir, "groups.log")}`);
  const cmd = [
    ...k.python, krtPlaceSimple(k), fixedBoard, join(kdir, "s{seed}.kicad_pcb"), "--groups", o.groups, "--intent", intentPath,
    "--seeds", o.seeds, "--jobs", String(o.jobs), "--json", join(kdir, "s{seed}.json"), ...(o.placerArgs ?? "").split(/\s+/).filter(Boolean),
    ...(o.clusteredSeeds ? ["--clustered-seeds", o.clusteredSeeds] : []),
  ];
  await run(cmd, "place.log", o.timeoutMs);
  rec.prep_and_place_wall_s = Math.round((Date.now() - t0) / 100) / 10;

  const fixedText = await readFile(fixedBoard, "utf8");
  const locked = lockedRefs(fixedText);
  const groups = (JSON.parse(await readFile(o.groups, "utf8")) as { groups: Array<{ refs: string[] }> }).groups;
  const movable = groups.flatMap((g) => g.refs).filter((r) => !locked.has(r)).sort();
  const native = await readFile(nativePath, "utf8");
  for (const sd of parseSeeds(o.seeds)) {
    const board = join(kdir, `s${sd}.kicad_pcb`);
    const logPath = join(kdir, `s${sd}.log`);
    const r: SeedRecord = (rec.seeds[String(sd)] = { placer: (await pathExists(logPath)) ? placerSummary(await readFile(logPath, "utf8")) : {} });
    if (!(await pathExists(board))) {
      r.error = "placer wrote no board";
      continue;
    }
    const d = join(o.out, `s${sd}`, "placed");
    await copyDir(o.placed, d, seedCopyFilter);
    try {
      const placedText = await readFile(board, "utf8");
      const target = join(d, `${o.stem}.kicad_pcb`);
      await writeFile(target, transferPoses(await readFile(target, "utf8"), placedText, movable).text);
    } catch (e) {
      r.error = `transfer: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    const target = join(d, `${o.stem}.kicad_pcb`);
    r.courtyard = await nativeCourtyard(host, target, join(d, "courtyard-drc.json"), new Set(fixedRefs));
    const after = await readFile(target, "utf8");
    const fa = footprintSpans(after);
    r.fixed_moved = fixedRefs.filter((ref) => {
      const a = fa.get(ref)!, b = nativeSpans.get(ref)!;
      const pa = pose(after.slice(a[0], a[1])), pb = pose(native.slice(b[0], b[1]));
      return pa.some((v, i) => v !== pb[i]);
    });
    r.gate = !Object.keys(r.courtyard).length && !r.fixed_moved.length;
    host.log?.(JSON.stringify({ seed: sd, gate: r.gate, courtyard: r.courtyard, fixed_moved: r.fixed_moved, cost: r.placer?.["wire"] }));
  }
  await writeFile(join(o.out, "place.json"), JSON.stringify(rec, null, 1) + "\n");
  return rec;
}
