/**
 * Move and relocate edits (the toolkit's `edit_move`). A move is data in the plan (the agent decides the pose, or names a
 * part to sit next to); this computes everything else:
 *
 * - `to` is the new origin pose of `ref` (x, y, rotation; side kept). `carry` parts move rigidly with it; copper of nets
 *   whose every pad is on carried parts moves with them, so a block keeps its internal routing. `carry_auto` adds the
 *   named parts' net-local satellites. `near` picks the pose next to a part, a REF.PAD or a point.
 * - Fan-out: every other track/via/arc touching a moved part's old pads is removed, then dangling copper of those nets is
 *   pruned: only the connections leaving the block open.
 * - Landing: copper of other nets crossing the new pads is removed, and through vias inside the new courtyard.
 * - Parts whose courtyard (same side) or drilled pads (any side) collide with the new courtyards are displaced: each is
 *   re-seated on a 0.1 mm spiral round its own position, its fan-out cut the same way. Fixed parts are never displaced:
 *   the move stops (a STOP is a decision for the owner, not an error).
 * - A differential pair that loses any copper loses all of it so it is routed again as a pair.
 */
import { readBoard } from "../board";
import { keepoutBlocks, kid, kids, num, parseSexpr, removeSpans, type SNode } from "../sexpr";
import {
  itemHitsBox, localBox, onLayers, overlap, padList, routedItems, rotPt, transformItem, worldBox,
  type Box, type Pt, type RoutedItem,
} from "./geom";
import { g, mod, round } from "./fmt";
import { pruneDangling } from "./prune";
import { stop } from "./sch";
import { footprintSpans, setPose } from "./text";

export type Pose = [number, number, number];

export interface MoveSpec {
  ref: string;
  to?: Pose;
  near?: string | [number, number];
  carry?: string[];
  carry_auto?: string[];
  anchor?: boolean;
  basis?: string;
  side?: string;
  radius?: number;
  rotations?: "keep" | "any";
  make_room?: boolean;
}

export interface DisplaceSpec {
  radius?: number;
  clearance?: number;
  pad_clearance?: number;
  edge?: number;
  rotations?: "keep" | "any";
  near?: Record<string, [number, number]>;
  fixed_allowed?: Record<string, string>;
}

export interface MoveLedger {
  moved: Array<{ ref: string; from: Pose; to: Pose; fixed: boolean; anchor: boolean; basis: string | null | undefined }>;
  carried: Array<{ ref: string; with: string; from: Pose; to: Pose }>;
  near: Array<{ ref: string; from: Pose; to: Pose; shift_mm: number; why: string[] }>;
  displaced: Array<{ ref: string; from: Pose; to: Pose; shift_mm: number; why: string[] }>;
  cut_nets: string[];
  copper_removed: number;
  copper_moved: number;
  landing_removed_nets: string[];
  review: string[];
  carry_auto?: Record<string, string[]>;
  inherited_overlaps?: string[];
  fixed_displaced_with_reason: Record<string, string>;
  in_way: Record<string, string[]>;
  pruned: number;
  internal_nets_moved: string[];
  new_courtyards: Record<string, number[]>;
}

type Fx = (x: number, y: number) => Pt;
const key = (s: number, e: number) => `${s}:${e}`;
const num4 = (p: Pose): Pose => [round(p[0], 4), round(p[1], 4), p[2]];

export function rawFootprints(root: SNode): Map<string, SNode> {
  const out = new Map<string, SNode>();
  for (const fp of kids(root, "footprint")) {
    const props = new Map<string, string>();
    for (const p of kids(fp, "property")) props.set(String(p[1]), String(p[2]));
    out.set(props.get("Reference")!, fp);
  }
  return out;
}

function boundsOf(root: SNode): Box {
  const pts: Pt[] = [];
  for (const kind of ["gr_line", "gr_rect", "gr_arc"])
    for (const gr of kids(root, kind)) {
      if (kid(gr, "layer")?.[1] !== "Edge.Cuts") continue;
      for (const k of ["start", "end"]) {
        const n = kid(gr, k);
        if (n) pts.push([num(n[1]), num(n[2])]);
      }
    }
  if (!pts.length) return [-Infinity, -Infinity, Infinity, Infinity];
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}

/** Apply the plan's moves to board text. Throws EditStop('STOP ...' / 'FAIL ...') when the move needs a decision or is impossible. */
export function planMoves(
  text0: string,
  fixedRef: (ref: string) => boolean,
  movesIn: MoveSpec[],
  displaceIn: DisplaceSpec | undefined | null,
  pairs: ReadonlyArray<readonly string[]>,
): { text: string; led: MoveLedger } {
  let text = text0;
  const root = parseSexpr(text);
  const board = readBoard(root);
  const fps = board.footprints;
  const pads = board.pads;
  const raw = rawFootprints(root);
  const displace = displaceIn && Object.keys(displaceIn).length ? displaceIn : undefined;
  const fixed = (r: string) => fixedRef(r);
  const gap = displace?.clearance ?? 0.2;
  const padClear = displace?.pad_clearance ?? 0.2;
  const BX = boundsOf(root);
  const led: MoveLedger = {
    moved: [], carried: [], near: [], displaced: [], cut_nets: [], copper_removed: 0, copper_moved: 0, landing_removed_nets: [], review: [],
    fixed_displaced_with_reason: {}, in_way: {}, pruned: 0, internal_nets_moved: [], new_courtyards: {},
  };
  const refs = [...fps.keys()];
  const sideOf = new Map(refs.map((r) => [r, fps.get(r)!.layer[0]!]));
  const side = (r: string) => sideOf.get(r)!;
  const boxOf = new Map<string, Box>();
  for (const r of refs) {
    const f = fps.get(r)!;
    boxOf.set(r, worldBox(localBox(raw.get(r)!), f.x, f.y, f.rot));
  }
  const newPose = new Map<string, Pose>();
  const nearMoves = movesIn.filter((m) => m.near !== undefined && m.to === undefined);
  const moves = movesIn.filter((m) => !nearMoves.includes(m));
  for (const m of nearMoves) if (!fps.has(m.ref)) return stop(`FAIL ${m.ref}: not on the board`);
  const nearRefs = new Set(nearMoves.map((m) => m.ref));
  const nearCarry = new Map<string, string[]>();
  // carry_auto: each named part plus its net-local satellites (parts whose every non-ground net stays inside the block)
  const padsByNet = new Map<string, Set<string>>();
  for (const q of pads) (padsByNet.get(q.net) ?? padsByNet.set(q.net, new Set()).get(q.net)!).add(q.ref);
  const GND = /GND|^unconnected-|^$/i;
  const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));
  for (const m of [...moves, ...nearMoves]) {
    if (!m.carry_auto) continue;
    const anchors = new Set([...m.carry_auto, m.ref]);
    let cand = new Set(
      refs.filter(
        (r) => !anchors.has(r) && !fixed(r) && Object.values(fps.get(r)!.pins).some((n) => n && !GND.test(n) && [...(padsByNet.get(n) ?? [])].some((x) => anchors.has(x))),
      ),
    );
    for (;;) {
      const union = new Set([...anchors, ...cand]);
      const drop = [...cand].filter((r) => Object.values(fps.get(r)!.pins).some((n) => n && !GND.test(n) && !subset(padsByNet.get(n) ?? new Set(), union)));
      if (!drop.length) break;
      for (const r of drop) cand.delete(r);
    }
    m.carry = [...new Set([...(m.carry ?? []), ...m.carry_auto.filter((x) => x !== m.ref), ...cand])].sort();
    (led.carry_auto ??= {})[m.ref] = m.carry;
  }
  for (const m of nearMoves) {
    nearCarry.set(m.ref, (m.carry ?? []).filter((c) => fps.has(c)));
    for (const c of nearCarry.get(m.ref)!) nearRefs.add(c);
  }
  // ---- 1. poses of moved and carried parts (rigid transform about the moved part's origin)
  for (const m of moves) {
    const r = m.ref;
    const f = fps.get(r);
    if (!f) return stop(`FAIL ${r}: not on the board`);
    const [x1, y1, r1] = m.to!.map(Number) as Pose;
    const d = mod(r1 - f.rot, 360);
    if (m.side && m.side[0] !== side(r)) return stop(`FAIL ${r}: side change ${side(r)} -> ${m.side} is not supported yet (flip)`);
    newPose.set(r, [x1, y1, mod(r1, 360)]);
    led.moved.push({ ref: r, from: [round(f.x, 4), round(f.y, 4), f.rot], to: [x1, y1, mod(r1, 360)], fixed: fixed(r), anchor: !!m.anchor, basis: m.basis ?? null });
    for (const c of m.carry ?? []) {
      const fc = fps.get(c);
      if (!fc) return stop(`FAIL carry ${c}: not on the board`);
      if (side(c) !== side(r)) led.review.push(`${c} is carried with ${r} but sits on the other side: it keeps its side`);
      const [dx, dy] = rotPt(fc.x - f.x, fc.y - f.y, d);
      const np: Pose = [x1 + dx, y1 + dy, mod(fc.rot + d, 360)];
      newPose.set(c, np);
      led.carried.push({ ref: c, with: r, from: [round(fc.x, 4), round(fc.y, 4), fc.rot], to: num4(np) });
    }
  }
  const moving = [...newPose.keys()].sort();
  // rigid transform per carried group (for its internal copper)
  const rigid = (x0: number, y0: number, x1: number, y1: number, d: number): Fx => (x, y) => {
    const q = rotPt(x - x0, y - y0, d);
    return [x1 + q[0], y1 + q[1]];
  };
  const groupFx = new Map<string, [string, Fx]>();
  for (const m of moves) {
    const r = m.ref;
    const f = fps.get(r)!;
    const [x1, y1, r1] = newPose.get(r)!;
    const fx = rigid(f.x, f.y, x1, y1, mod(r1 - f.rot, 360));
    for (const c of [r, ...(m.carry ?? [])]) groupFx.set(c, [r, fx]);
  }
  const newBox = new Map<string, Box>();
  for (const r of moving) newBox.set(r, worldBox(localBox(raw.get(r)!), ...newPose.get(r)!));
  for (const r of moving) {
    const b = newBox.get(r)!;
    const out = padList(raw.get(r)!, ...newPose.get(r)!).filter((p) => p.box[0] < BX[0] || p.box[1] < BX[1] || p.box[2] > BX[2] || p.box[3] > BX[3]).map((p) => p.name);
    if (out.length) return stop(`FAIL ${r}: pads outside the outline at the new pose: [${out.map((n) => `'${n}'`).join(", ")}]`);
    if (b[0] < BX[0] || b[1] < BX[1] || b[2] > BX[2] || b[3] > BX[3])
      led.review.push(`${r}: courtyard crosses the board outline at the new pose (${JSON.stringify(b.map((v) => round(v, 2)))}); expected for an edge connector whose body meets the edge`);
  }
  // ---- 2. what is in the way: same-side courtyards, drilled pads either side
  const movingSet = new Set(moving);
  const drills = new Map<string, Box[]>();
  for (const r of refs) {
    if (movingSet.has(r)) continue;
    const f = fps.get(r)!;
    for (const p of padList(raw.get(r)!, f.x, f.y, f.rot)) if (p.drilled) (drills.get(r) ?? drills.set(r, []).get(r)!).push(p.box);
  }
  const newDrills = new Map<string, Box[]>();
  for (const r of moving) newDrills.set(r, padList(raw.get(r)!, ...newPose.get(r)!).filter((p) => p.drilled).map((p) => p.box));
  const inWay = new Map<string, string[]>();
  const close = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-3);
  for (const r of moving) {
    for (const o of refs) {
      if (movingSet.has(o) || nearRefs.has(o)) continue;
      const why: string[] = [];
      const sameP = close(newBox.get(r)!, boxOf.get(r)!);
      // a part taking the exact place another moving part leaves (a swap) inherits that part's neighbours
      const inherited = moving.some((v) => v !== r && side(v) === side(r) && close(newBox.get(r)!, boxOf.get(v)!) && overlap(boxOf.get(v)!, boxOf.get(o)!, gap));
      if (side(o) === side(r) && overlap(newBox.get(r)!, boxOf.get(o)!, gap) && !(sameP && overlap(boxOf.get(r)!, boxOf.get(o)!, gap)) && !inherited) why.push("courtyard");
      else if (inherited && overlap(newBox.get(r)!, boxOf.get(o)!, gap)) (led.inherited_overlaps ??= []).push(`${r} takes the place of a moving part already next to ${o}`);
      if ((drills.get(o) ?? []).some((d) => overlap(newBox.get(r)!, d, 0))) why.push("its drilled pad under the new courtyard");
      if (newDrills.get(r)!.some((nd) => overlap(nd, boxOf.get(o)!, 0))) why.push("new drilled pad through its courtyard");
      if (why.length) (inWay.get(o) ?? inWay.set(o, []).get(o)!).push(`${r}: ${why.join(", ")}`);
    }
  }
  const allow = new Set(Object.keys(displace?.fixed_allowed ?? {}));
  const blockedFixed = [...inWay.keys()].filter((o) => fixed(o) && !allow.has(o));
  for (const o of inWay.keys()) if (allow.has(o)) led.fixed_displaced_with_reason[o] = displace!.fixed_allowed![o]!;
  if (blockedFixed.length) return stop("STOP fixed parts in the way of the new pose(s): " + blockedFixed.map((o) => `${o} (${inWay.get(o)!.join(", ")})`).join("; "));
  for (let i = 0; i < moving.length; i++)
    for (const o of moving.slice(i + 1)) {
      const r = moving[i]!;
      if (groupFx.get(r)![0] === groupFx.get(o)![0]) continue; // one rigid block keeps its own spacing
      if (side(o) === side(r) && overlap(newBox.get(r)!, newBox.get(o)!, gap)) return stop(`STOP moved parts ${r} and ${o} overlap at their new poses`);
    }
  led.in_way = Object.fromEntries(inWay);
  if (inWay.size && !displace)
    return stop("STOP parts in the way (set plan.displace to re-seat them nearby, or carry/move them): " + [...inWay].map(([o, w]) => `${o} (${w.join(", ")})`).join("; "));
  // ---- 3. re-seat displaced parts (spiral round their own position)
  const mates = new Map<string, Array<[number, number, string]>>();
  for (const q of pads) (mates.get(q.net) ?? mates.set(q.net, []).get(q.net)!).push([q.x, q.y, q.ref]);
  const occupied = new Map<string, [string, Box]>();
  for (const r of refs) if (!inWay.has(r) && !nearRefs.has(r)) occupied.set(r, [side(r), movingSet.has(r) ? newBox.get(r)! : boxOf.get(r)!]);
  const allDrills: Box[] = [
    ...[...drills].filter(([r]) => !inWay.has(r) && !nearRefs.has(r)).flatMap(([, ds]) => ds),
    ...[...newDrills.values()].flat(),
  ];
  type Reseat = [string, Pt | undefined | null, "keep" | "any", string[], number | null];
  const reseat: Reseat[] = [];
  const makeRoom = new Set<string>();
  for (const m of nearMoves) {
    const nr = m.near!;
    let tgt: Pt;
    if (Array.isArray(nr)) tgt = [Number(nr[0]), Number(nr[1])];
    else if (nr.includes(".")) {
      const dot = nr.lastIndexOf(".");
      const rr = nr.slice(0, dot);
      const pp = nr.slice(dot + 1);
      const f = fps.get(rr);
      if (!f) return stop(`FAIL near ${nr}: ${rr} is not on the board`);
      const pose = newPose.get(rr) ?? ([f.x, f.y, f.rot] as Pose);
      const pad = padList(raw.get(rr)!, ...pose).find((p) => p.name === pp);
      if (!pad) return stop(`FAIL near ${nr}: no such pad`);
      tgt = [(pad.box[0] + pad.box[2]) / 2, (pad.box[1] + pad.box[3]) / 2];
    } else {
      const b = newBox.get(nr) ?? boxOf.get(nr);
      if (!b) return stop(`FAIL near ${nr}: not on the board`);
      tgt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    }
    reseat.push([m.ref, tgt, m.rotations ?? "any", [`near ${Array.isArray(nr) ? `[${nr.join(", ")}]` : nr}: ${m.basis ?? ""}`], Number(m.radius ?? 8)]);
    if (m.make_room) makeRoom.add(m.ref);
  }
  for (const o of inWay.keys()) reseat.push([o, displace?.near?.[o], displace?.rotations ?? "keep", inWay.get(o)!, null]);
  const radius = displace?.radius ?? (displace ? 10 : 0);
  const keepouts: Box[] = [];
  for (const z of kids(root, "zone")) {
    if (!keepoutBlocks(z, ["footprints", "tracks"])) continue; // pure rule areas (allow all) scope DRC rules only
    const pts: Pt[] = [];
    for (const poly of kids(z, "polygon")) for (const q of kids(kid(poly, "pts") ?? [], "xy")) pts.push([num(q[1]), num(q[2])]);
    if (pts.length) keepouts.push([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]);
  }
  const em = displace?.edge ?? 0.4;
  // routed copper index for landing cost: a pose whose pads would sit on other nets' copper costs a cut (and churn)
  const allItems = routedItems(text);
  const itemBoxes: Array<[Box, RoutedItem]> = [];
  for (const it of allItems) {
    const xs = it.pts.map((q) => q[0]);
    const ys = it.pts.map((q) => q[1]);
    if (xs.length) itemBoxes.push([[Math.min(...xs) - it.hw, Math.min(...ys) - it.hw, Math.max(...xs) + it.hw, Math.max(...ys) + it.hw], it]);
  }
  const landingHits = (ref: string, p: Pose): number => {
    let n = 0;
    for (const pad of padList(raw.get(ref)!, ...p, padClear))
      for (const [bb, it] of itemBoxes) {
        const bx = pad.box;
        if (it.net !== pad.net && bb[0] <= bx[2] && bx[0] <= bb[2] && bb[1] <= bx[3] && bx[1] <= bb[3] && itemHitsBox(it, bx) && (pad.drilled || onLayers(it, pad.layers, side(ref)))) n++;
      }
    return n;
  };
  for (let k = 0; k < reseat.length; k++) {
    const [o, tgt, rmode, whyO, radO] = reseat[k]!;
    if (newPose.has(o)) continue;
    const f = fps.get(o)!;
    const lb = localBox(raw.get(o)!);
    const roomy = makeRoom.has(o);
    // make_room: only fixed parts, drilled pads and parts already re-seated block the pose; others are displaced
    const blockersR = [...occupied].filter(([r_]) => !roomy || fixed(r_) || newPose.has(r_));
    const blockers = blockersR.map(([, v]) => v);
    // what stood in the way of poses nearer than the first legal one (named in a STOP, so the agent knows why)
    const inWayNear = new Map<string, number>();
    const tallyWay = (sd: string, b: Box) => {
      for (const [r_, [s_, bb]] of blockersR) if (s_ === sd && overlap(b, bb, gap)) inWayNear.set(r_, (inWayNear.get(r_) ?? 0) + 1);
    };
    const block = nearCarry.get(o) ?? [];
    const blb = new Map(block.map((c) => [c, localBox(raw.get(c)!)]));
    const blockPoses = (x: number, y: number, rot: number): Map<string, Pose> => {
      const d = mod(rot - f.rot, 360);
      const out = new Map<string, Pose>();
      for (const c of block) {
        const fc = fps.get(c)!;
        const [dx, dy] = rotPt(fc.x - f.x, fc.y - f.y, d);
        out.set(c, [x + dx, y + dy, mod(fc.rot + d, 360)]);
      }
      return out;
    };
    const rots = rmode === "keep" ? [f.rot] : [0, 1, 2, 3].map((q) => mod(f.rot + q * 90, 360));
    const [tx, ty] = tgt ?? [f.x, f.y];
    const radiusO = radO ?? radius;
    const cost = (x: number, y: number, rot: number): number => {
      let tot = 0;
      const own = new Set([o, ...block]);
      const members: Array<[string, Pose]> = [[o, [x, y, rot]], ...blockPoses(x, y, rot)];
      for (const [ref_, pose_] of members)
        for (const pad of padList(raw.get(ref_)!, ...pose_)) {
          const ms = (mates.get(pad.net) ?? []).filter(([, , mr]) => !own.has(mr));
          if (ms.length && pad.net && !/GND/.test(pad.net)) {
            const c: Pt = [(pad.box[0] + pad.box[2]) / 2, (pad.box[1] + pad.box[3]) / 2];
            tot += Math.min(...ms.map(([mx, my]) => Math.hypot(c[0] - mx, c[1] - my)));
          }
        }
      return tot;
    };
    const blockLegal = (x: number, y: number, rot: number): boolean => {
      for (const [c, pose_] of blockPoses(x, y, rot)) {
        const cb = worldBox(blb.get(c)!, ...pose_);
        if (cb[0] < BX[0] + em || cb[1] < BX[1] + em || cb[2] > BX[2] - em || cb[3] > BX[3] - em) return false;
        if (occupiedList(blockers, side(c), cb, gap)) return false;
        if (allDrills.some((dd) => overlap(cb, dd, gap))) return false;
      }
      return true;
    };
    const step = !block.length ? 0.1 : 0.25;
    let firstLegal: number | null = null;
    let best: [number, number, number, number, Box] | null = null;
    for (let ring = 0; ring <= Math.floor(radiusO / step); ring++) {
      const rr = ring * step;
      const steps = Math.max(1, Math.floor((2 * Math.PI * rr) / step));
      for (let kk = 0; kk < steps; kk++) {
        const x = tx + rr * Math.cos((2 * Math.PI * kk) / steps);
        const y = ty + rr * Math.sin((2 * Math.PI * kk) / steps);
        for (const rot of rots) {
          const wb = worldBox(lb, x, y, rot);
          if (wb[0] < BX[0] + em || wb[1] < BX[1] + em || wb[2] > BX[2] - em || wb[3] > BX[3] - em) continue;
          if (occupiedList(blockers, side(o), wb, gap)) {
            if (firstLegal === null) tallyWay(side(o), wb);
            continue;
          }
          if (allDrills.some((d) => overlap(wb, d, gap)) || keepouts.some((kz) => overlap(wb, kz, 0))) continue;
          const ownDrills = padList(raw.get(o)!, x, y, rot).filter((p) => p.drilled).map((p) => p.box);
          if (ownDrills.some((d) => blockers.some(([, b]) => overlap(d, b, 0)))) continue;
          if (block.length && !blockLegal(x, y, rot)) continue;
          let hits = landingHits(o, [x, y, rot]);
          for (const [c, p_] of blockPoses(x, y, rot)) hits += landingHits(c, p_);
          const cst = cost(x, y, rot) + 1000.0 * hits;
          if (!best || cst < best[0]) best = [cst, round(x, 3), round(y, 3), mod(rot, 360), wb];
        }
      }
      if (best && firstLegal === null) firstLegal = rr;
      if (best && (best[0] < 1000.0 || rr >= firstLegal! + 1.5)) break; // first legal ring wins unless every pose there lands on copper: look up to 1.5 mm further
    }
    const wayTxt = () => {
      const top = [...inWayNear].sort((a_, b_) => b_[1] - a_[1]).slice(0, 5).map(([r_]) => r_);
      return top.length ? `; in the way: ${top.join(", ")} (courtyards)` : "";
    };
    if (!best) return stop(`STOP part ${o} has no legal pose within ${radiusO} mm of its target ${tx.toFixed(2)},${ty.toFixed(2)} (${whyO.join("; ")}${wayTxt()}): move it in the plan, move what is in the way, or raise the radius`);
    const [, x, y, rot, wb] = best;
    occupied.set(o, [side(o), wb]);
    newPose.set(o, [x, y, rot]);
    newBox.set(o, wb);
    if (block.length) {
      // the block follows rigidly; its internal copper moves with it (groupFx)
      const d = mod(rot - f.rot, 360);
      const fxb = rigid(f.x, f.y, x, y, d);
      groupFx.set(o, [o, fxb]);
      for (const [c, pose_] of blockPoses(x, y, rot)) {
        newPose.set(c, pose_);
        newBox.set(c, worldBox(blb.get(c)!, ...pose_));
        occupied.set(c, [side(c), newBox.get(c)!]);
        groupFx.set(c, [o, fxb]);
        const fc = fps.get(c)!;
        led.carried.push({ ref: c, with: o, from: [round(fc.x, 4), round(fc.y, 4), fc.rot], to: num4(pose_) });
      }
    }
    if (roomy) {
      // displace what the block now covers
      const boxesNow: Array<[string, Box]> = [[side(o), wb], ...block.map((c) => [side(c), newBox.get(c)!] as [string, Box])];
      const drillsNow = [o, ...block].flatMap((r_) => padList(raw.get(r_)!, ...newPose.get(r_)!).filter((p_) => p_.drilled).map((p_) => p_.box));
      for (const [r_, [s_, b_]] of [...occupied]) {
        if (newPose.has(r_) || r_ === o || block.includes(r_)) continue;
        const hit = boxesNow.some(([sb, bb]) => s_ === sb && overlap(bb, b_, gap)) || drillsNow.some((dd) => overlap(dd, b_, 0));
        if (hit) {
          if (fixed(r_)) return stop(`STOP make_room for ${o} would displace fixed part ${r_}`);
          occupied.delete(r_);
          inWay.set(r_, [`${o} block: courtyard`]);
          reseat.push([r_, null, displace?.rotations ?? "keep", inWay.get(r_)!, null]);
        }
      }
    }
    (nearRefs.has(o) ? led.near : led.displaced).push({ ref: o, from: [round(f.x, 4), round(f.y, 4), f.rot], to: [x, y, rot], shift_mm: round(Math.hypot(x - f.x, y - f.y), 2), why: whyO });
  }
  const seated = [...newPose.keys()].sort();
  const seatedSet = new Set(seated);
  // ---- 4. copper: carried internal copper moves; fan-out of every re-seated part is cut; landings cleared
  const blockNets = new Map<string, Set<string>>();
  for (const [r, [anchor]] of groupFx) for (const net of Object.values(fps.get(r)!.pins)) if (net) (blockNets.get(net) ?? blockNets.set(net, new Set()).get(net)!).add(anchor);
  const internal = new Map<string, string>(); // net -> anchor, when every pad of the net is on parts of that one carried group
  for (const [net, anchors] of blockNets) {
    const refsOn = new Set(pads.filter((q) => q.net === net).map((q) => q.ref));
    const only = [...anchors][0]!;
    if (anchors.size === 1 && refsOn.size && [...refsOn].every((rr) => groupFx.get(rr)?.[0] === only)) internal.set(net, only);
  }
  const oldPads: Array<[string, Box]> = seated.flatMap((r) => padList(raw.get(r)!, fps.get(r)!.x, fps.get(r)!.y, fps.get(r)!.rot, 0.02).map((p) => [p.net, p.box] as [string, Box]));
  const landing: Array<[string, Box, Set<string>, boolean, string]> = [];
  for (const r of seated) for (const p of padList(raw.get(r)!, ...newPose.get(r)!, padClear)) landing.push([p.net, p.box, p.layers, p.drilled, side(r)]);
  const its = routedItems(text);
  const cut = new Set<string>();
  const rm: Array<[number, number]> = [];
  const rmKeys = new Set<string>();
  const addRm = (s: number, e: number) => {
    if (!rmKeys.has(key(s, e))) {
      rmKeys.add(key(s, e));
      rm.push([s, e]);
    }
  };
  const movedSpans = new Map<string, Fx>();
  const landed = new Set<string>();
  for (const it of its) {
    const { kind, start: s, end: e, net, pts } = it;
    const an = internal.get(net);
    if (an !== undefined) {
      movedSpans.set(key(s, e), groupFx.get(an)![1]);
      continue;
    }
    if (pts.length && oldPads.some(([n, bx]) => n === net && itemHitsBox(it, bx) && (kind === "via" || [pts[0]!, pts[pts.length - 1]!].some(([px, py]) => bx[0] <= px && px <= bx[2] && bx[1] <= py && py <= bx[3])))) {
      addRm(s, e);
      cut.add(net);
      continue;
    }
    let hit = false;
    for (const [n, bx, lay, drilled, sd] of landing)
      if (n !== net && itemHitsBox(it, bx) && (drilled || onLayers(it, lay, sd))) {
        addRm(s, e);
        cut.add(net);
        landed.add(net);
        hit = true;
        break;
      }
    if (!hit && kind === "via") {
      for (const r of seated) {
        const b = newBox.get(r)!;
        const [x, y] = pts[0]!;
        if (b[0] <= x && x <= b[2] && b[1] <= y && y <= b[3] && !Object.values(fps.get(r)!.pins).includes(net)) {
          addRm(s, e);
          cut.add(net);
          landed.add(net);
          break;
        }
      }
    }
  }
  // nets whose every pad was re-seated keep nothing at the old place (loops survive prune_dangling)
  const padNetsSeated = new Set(pads.filter((q) => seatedSet.has(q.ref)).map((q) => q.net));
  const allMoved = new Set([...padNetsSeated].filter((n) => n && !internal.has(n) && !GND.test(n) && subset(padsByNet.get(n) ?? new Set(), seatedSet)));
  for (const it of its) if (allMoved.has(it.net) && !movedSpans.has(key(it.start, it.end)) && !rmKeys.has(key(it.start, it.end))) { addRm(it.start, it.end); cut.add(it.net); }
  // carried copper lands too: other-net items crossing a carried track/via at its new place are cut
  const carriedGeo: Array<[string, string, Pt[], number]> = [];
  for (const it of its) {
    const k = key(it.start, it.end);
    if (!movedSpans.has(k) || rmKeys.has(k)) continue;
    const fx = movedSpans.get(k)!;
    const pts = it.pts.map((q) => fx(q[0], q[1]));
    if (it.kind === "via") carriedGeo.push([it.net, "*", [pts[0]!], it.hw + padClear]);
    else {
      const a = pts[0]!, b = pts[pts.length - 1]!;
      const n = Math.max(1, Math.floor(Math.hypot(a[0] - b[0], a[1] - b[1]) / 0.2));
      carriedGeo.push([it.net, [...it.layers][0]!, Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as Pt), it.hw + padClear]);
    }
  }
  for (const it of its) {
    const k = key(it.start, it.end);
    if (movedSpans.has(k) || rmKeys.has(k)) continue;
    for (const [net, lay, samples, r] of carriedGeo) {
      if (net === it.net) continue;
      if (lay !== "*" && !it.layers.has("*") && !it.layers.has(lay)) continue;
      if (samples.some(([x, y]) => itemHitsBox(it, [x - r, y - r, x + r, y + r]))) {
        addRm(it.start, it.end);
        cut.add(it.net);
        landed.add(it.net);
        break;
      }
    }
  }
  // ...and carried copper must clear every other-net pad at its final pose (parts on either side, displaced or not)
  const finalPads: Array<[string, Box, Set<string>, boolean]> = [];
  for (const r of refs) {
    const f = fps.get(r)!;
    const p = newPose.get(r) ?? ([f.x, f.y, f.rot] as Pose);
    for (const pad of padList(raw.get(r)!, ...p, padClear)) finalPads.push([pad.net, pad.box, pad.layers, pad.drilled]);
  }
  for (const it of its) {
    const k = key(it.start, it.end);
    if (!movedSpans.has(k) || rmKeys.has(k)) continue;
    const fx = movedSpans.get(k)!;
    const movedIt: RoutedItem = { ...it, pts: it.pts.map((q) => fx(q[0], q[1])) };
    for (const [net, bx, lay, drilled] of finalPads) {
      if (net === it.net) continue;
      if (!(drilled || it.layers.has("*") || [...lay].some((l) => l.startsWith("*")) || lay.has([...it.layers][0]!))) continue;
      if (itemHitsBox(movedIt, bx)) {
        addRm(it.start, it.end);
        cut.add(it.net);
        break;
      }
    }
  }
  const whole = new Set(pairs.filter((pr) => pr.some((n) => cut.has(n))).flat());
  for (const n of whole) cut.add(n);
  for (const it of its) if (whole.has(it.net) && !rmKeys.has(key(it.start, it.end)) && !movedSpans.has(key(it.start, it.end))) addRm(it.start, it.end);
  type Edit = { s: number; e: number; fx: Fx | null };
  const edits: Edit[] = [...rm.map(([s, e]) => ({ s, e, fx: null })), ...[...movedSpans].filter(([k]) => !rmKeys.has(k)).map(([k, fx]) => ({ s: Number(k.split(":")[0]), e: Number(k.split(":")[1]), fx }))];
  for (const { s, e, fx } of edits.sort((a, b) => b.s - a.s)) {
    if (!fx) text = removeSpans(text, [{ start: s, end: e }]);
    else text = text.slice(0, s) + transformItem(text.slice(s, e), fx) + text.slice(e);
  }
  led.copper_removed = rm.length;
  led.copper_moved = [...movedSpans.keys()].filter((k) => !rmKeys.has(k)).length;
  // ---- 5. footprints to their new poses
  const spans = footprintSpans(text);
  for (const r of [...seated].sort((a, b) => spans.get(b)!.start - spans.get(a)!.start)) {
    const sp = spans.get(r)!;
    text = text.slice(0, sp.start) + setPose(text.slice(sp.start, sp.end), ...newPose.get(r)!) + text.slice(sp.end);
  }
  const pr = pruneDangling(text, cut);
  text = pr.text;
  led.pruned = pr.pruned;
  led.cut_nets = [...cut].sort();
  led.landing_removed_nets = [...landed].sort();
  led.internal_nets_moved = [...internal.keys()].sort();
  led.new_courtyards = Object.fromEntries(seated.map((r) => [r, newBox.get(r)!.map((v) => round(v, 3))]));
  return { text, led };
}

function occupiedList(blockers: Array<[string, Box]>, sd: string, b: Box, gap: number): boolean {
  return blockers.some(([s, bb]) => s === sd && overlap(b, bb, gap));
}

/** Cut copper of a pad's own net that touches it (targets: [ref, pad]); prune what dangles. For net changes. */
export function cutPads(
  text0: string,
  targets: Array<[string, string]>,
  pairs: ReadonlyArray<readonly string[]> = [],
): { text: string; log: { removed: number; pruned: number; cut_nets: string[] } } {
  let text = text0;
  const root = parseSexpr(text);
  const fps = readBoard(root).footprints;
  const raw = rawFootprints(root);
  const boxes: Array<[string, Box]> = [];
  for (const [ref, pad] of targets) {
    const f = fps.get(ref);
    if (!f) return stop(`FAIL ${ref}: not on the board`);
    for (const p of padList(raw.get(ref)!, f.x, f.y, f.rot, 0.02)) if (p.name === pad) boxes.push([p.net, p.box]);
  }
  const rmKeys = new Set<string>();
  const rm: Array<[number, number]> = [];
  const cut = new Set<string>();
  const items = routedItems(text);
  for (const it of items) {
    const { kind, start: s, end: e, net, pts } = it;
    for (const [n, bx] of boxes)
      if (n === net && itemHitsBox(it, bx) && (kind === "via" || [pts[0]!, pts[pts.length - 1]!].some(([px, py]) => bx[0] <= px && px <= bx[2] && bx[1] <= py && py <= bx[3]))) {
        if (!rmKeys.has(key(s, e))) (rmKeys.add(key(s, e)), rm.push([s, e]));
        cut.add(net);
        break;
      }
  }
  const whole = new Set(pairs.filter((pr) => pr.some((n) => cut.has(n))).flat());
  for (const it of items) if (whole.has(it.net) && !rmKeys.has(key(it.start, it.end))) (rmKeys.add(key(it.start, it.end)), rm.push([it.start, it.end]));
  text = removeSpans(text, rm.map(([start, end]) => ({ start, end })));
  const all = new Set([...cut, ...whole]);
  const pr = pruneDangling(text, all);
  return { text: pr.text, log: { removed: rm.length, pruned: pr.pruned, cut_nets: [...all].sort() } };
}
void g;
