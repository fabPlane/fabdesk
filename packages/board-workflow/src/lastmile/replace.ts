/**
 * The per-block loop of the toolkit's `tools/route_region.py --replace GROUP`: rip every track and via with a point in
 * the floorplan groups' regions (all nets: the parts move, so nothing in the region may stay), prune what the rip left
 * hanging, re-place those groups inside their regions with everything else locked (the floorplan block passes,
 * TraceMaker's placer), gate (every part placed, nothing else moved, native courtyard DRC clean), then route. The last
 * mile routes with its KRT plan (`after-cut`: the cut pairs again as pairs, then the rest), as a nudge does; the
 * toolkit's TraceMaker / fastroute CLI pass is not reused.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBoard } from "../board";
import { topLevelSpans } from "../sexpr";
import type { LayoutHost } from "../layout/ctx";
import {
  claimedParts,
  gatherParts,
  groupRefs,
  pinParts,
  placeGroup,
  beyondBox,
  selectGroups,
  singlePadParts,
  stagingRegion,
  tracemakerPlacer,
  type Blocks,
  type Floorplan,
  type GroupPassRecord,
  type Region,
} from "../layout/floorplan";
import { nativeCourtyard } from "../layout/place";
import { copyBoardFolder } from "./bench";
import { cutSpans, pruneDanglingExact } from "./rip";

const inside = (x: number, y: number, regions: Region[]) => regions.some((r) => r[0] <= x && x <= r[2] && r[1] <= y && y <= r[3]);

/**
 * route_region's rip: every segment, via and arc with a point (start, end, at, mid) inside a region is removed, all
 * nets, then dangling copper is pruned on the whole board. Returns the board, the counts and the nets cut.
 */
export function regionRip(text: string, regions: Region[]): { text: string; removed: { segment: number; via: number; arc: number; pruned: number }; nets: string[] } {
  const removed = { segment: 0, via: 0, arc: 0, pruned: 0 };
  const spans: Array<{ start: number; end: number }> = [];
  const nets = new Set<string>();
  for (const kind of ["segment", "via", "arc"] as const)
    for (const s of topLevelSpans(text, kind)) {
      const it = text.slice(s.start, s.end);
      const pts = [...it.matchAll(/\((?:start|end|at|mid) ([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      if (pts.some(([x, y]) => inside(x, y, regions))) {
        spans.push(s);
        removed[kind]++;
        nets.add(/\(net "([^"]*)"\)/.exec(it)?.[1] ?? "");
      }
    }
  const cut = cutSpans(text, spans);
  const p = pruneDanglingExact(cut);
  removed.pruned = p.pruned;
  return { text: p.text, removed, nets: [...nets].filter(Boolean).sort() };
}

export interface ReplaceRecord {
  groups: string[];
  regions: Region[];
  removed: { segment: number; via: number; arc: number; pruned: number };
  placement: { groups: GroupPassRecord[]; ok: boolean; native_courtyard: Record<string, number> | null };
  /** Nets the router must route again (cut by the rip, or on a moved part): rip.json `nets` for `@cut-pairs`. */
  nets: string[];
}

export interface ReplaceOptions {
  /** Board folder to start from (not changed). */
  cur: string;
  /** Board folder written: the ripped, re-placed board with rip.json and replace.json. */
  out: string;
  pcb: string;
  floorplan: Floorplan;
  blocks: Blocks;
  groups: string[];
  fixed: RegExp;
  seed?: number;
  /** Courtyard clearance for groups that set none (default the floorplan's). */
  clearance?: number;
}

/**
 * Rip the groups' regions and re-place the groups (route_region --replace without its route). Throws when a group is
 * unknown; a failed gate is in `placement.ok` / `placement.native_courtyard` (the board is then not to be routed).
 */
export async function replaceGroups(host: LayoutHost, o: ReplaceOptions): Promise<ReplaceRecord> {
  const groups = selectGroups(o.floorplan, o.groups);
  if (!groups.length) throw new Error(`replace: unknown group in ${o.groups.join(",")} (the floorplan has ${o.floorplan.groups.map((g) => g.name).join(", ")})`);
  const regions = groups.map((g) => g.region);
  const placer = await tracemakerPlacer(host);
  await mkdir(o.out, { recursive: true });
  await copyBoardFolder(o.cur, o.out);
  const board = join(o.out, o.pcb);
  const rip = regionRip(await readFile(board, "utf8"), regions);
  let text = rip.text;
  const single = singlePadParts(text, o.fixed);
  const claimed = claimedParts(o.floorplan);
  const all = groups.flatMap((g) => groupRefs(g, o.blocks, single, claimed, o.fixed));
  const beyond = beyondBox(text);
  text = gatherParts(text, all, stagingRegion(text)); // staged off the board so the groups do not block each other
  for (const g of groups) text = pinParts(text, g.pinned ?? {}); // all pinned poses first
  await writeFile(board, text);
  const tm = join(o.out, ".lastmile", "place");
  await mkdir(tm, { recursive: true });
  const recs: GroupPassRecord[] = [];
  for (const g of groups) {
    const rec = await placeGroup(host, {
      board, tm, tag: g.name, group: g, refs: groupRefs(g, o.blocks, single, claimed, o.fixed),
      clearance: g.courtyard_clearance_mm ?? o.clearance ?? o.floorplan.courtyard_clearance_mm, time: 30, seed: o.seed ?? 1, fixed: o.fixed, placer, beyond,
    });
    recs.push(rec);
    if (!rec.ok) break;
  }
  const ok = recs.length === groups.length && recs.every((r) => r.ok);
  const courtyard = ok ? await nativeCourtyard(host, board, join(tm, "placement-drc.json")) : null;
  const moved = new Set(all);
  const partNets = parseBoard(await readFile(board, "utf8")).pads.filter((p) => moved.has(p.ref) && p.net).map((p) => p.net);
  const rec: ReplaceRecord = { groups: groups.map((g) => g.name), regions, removed: rip.removed, placement: { groups: recs, ok, native_courtyard: courtyard }, nets: [...new Set([...rip.nets, ...partNets])].sort() };
  await writeFile(join(o.out, "replace.json"), JSON.stringify(rec, null, 1) + "\n");
  await writeFile(join(o.out, "rip.json"), JSON.stringify({ src: o.cur, removed: rip.removed.segment + rip.removed.via + rip.removed.arc, pruned: rip.removed.pruned, nets: rec.nets, windows: regions, open_before: [] }, null, 1) + "\n");
  return rec;
}
