/**
 * The toolkit's `flow/pairseat.py`: seat pass-through parts of differential pairs on their chip's pins, as KRT placer
 * templates (one row per chip), computed from the board.
 *
 * A pass-through part (series resistor, common-mode filter, ESD array) whose pads sit on pair nets that run only to one
 * chip's pins belongs on those pins, its chip-side pads facing them, partners side by side. Placers and HPWL do not
 * know this: A2 (flow92) placed R105/R106 4-7 mm from the RP2040 and 4 mm apart, so the USB pair could not couple.
 *
 * For each chip (U/IC): its pins on pair nets with exactly two pads, the other on ONE movable non-chip part, grouped by
 * the side of the chip they are on. Each part goes outward from the pins it serves by the chip's pad extent + half the
 * part's depth + a gap; the rotation (0/90/180/270) that puts its chip-side pads nearest their pins wins; parts on one
 * side are spread along it so courtyards do not touch. Offsets and rotations are in the chip's frame (the template
 * moves with the chip). The agent can edit or drop any row.
 */
import type { Board, Footprint, Pad } from "../board";
import type { Acceptance } from "../requirements";
import type { Group } from "./spec";

const GAP = 0.35;
const CHIP = /^(U|IC)\d/;

export interface SeatMember {
  ref: string;
  at: [number, number];
  rot: number;
  /** ref -> the pads of the pass-through part and of the chip that the pair nets join. */
  pads: Record<string, string[]>;
}

export interface SeatRow {
  anchor: string;
  tolerance_mm: number;
  members: SeatMember[];
  source: string;
}

type Side = readonly ["x" | "y", 1 | -1];

/** Board point -> footprint frame (inverse of the board model's pad transform). */
function local(fp: Footprint, x: number, y: number): [number, number] {
  const r = (fp.rot * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - fp.x, dy = y - fp.y;
  return [c * dx - s * dy, s * dx + c * dy];
}

/** Footprint-frame offset rotated by `deg` as KiCad applies a footprint rotation. */
function rotPt(px: number, py: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [px * c + py * s, -px * s + py * c];
}

const round4 = (x: number) => Number(x.toFixed(4));
const pairNetsOf = (acc: Acceptance) => new Set(Object.values(acc.net_classes.classes).flatMap((c) => (c.pairs ?? []).flat()));

/** chip -> template row for its pass-through parts (empty when the board has none). `fixed` is matched with `test`. */
export function pairSeat(board: Board, acc: Acceptance, fixed: RegExp): Record<string, SeatRow> {
  const fps = board.footprints;
  const byNet = new Map<string, Pad[]>();
  for (const p of board.pads) if (p.net) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)!).push(p);
  // chip -> part -> [(chip pad, part pad)]; pair nets in name order so the rows come out the same every run
  const serve = new Map<string, Map<string, Array<[Pad, Pad]>>>();
  for (const n of [...pairNetsOf(acc)].sort()) {
    const ps = byNet.get(n) ?? [];
    if (ps.length !== 2) continue;
    const [a, b] = ps as [Pad, Pad];
    for (const [chip, part] of [[a, b], [b, a]] as const)
      if (CHIP.test(chip.ref) && !CHIP.test(part.ref) && !fixed.test(part.ref) && !fixed.test(chip.ref)) {
        const parts = serve.get(chip.ref) ?? serve.set(chip.ref, new Map()).get(chip.ref)!;
        (parts.get(part.ref) ?? parts.set(part.ref, []).get(part.ref)!).push([chip, part]);
      }
  }
  const rows: Record<string, SeatRow> = {};
  for (const [chip, parts] of serve) {
    const cf = fps.get(chip);
    if (!cf) continue;
    const cpads = board.pads.filter((p) => p.ref === chip).map((p) => local(cf, p.x, p.y));
    const extX = Math.max(...cpads.map(([x]) => Math.abs(x))) + 0.4;
    const extY = Math.max(...cpads.map(([, y]) => Math.abs(y))) + 0.4;
    const members: Array<{ ref: string; side: Side; at: [number, number]; rot: number; wid: number; pads: Record<string, string[]> }> = [];
    for (const [part, links] of parts) {
      const pf = fps.get(part);
      if (!pf) continue;
      const ppads = new Map(board.pads.filter((p) => p.ref === part).map((p) => [p.pad, local(pf, p.x, p.y)] as const));
      const pins = links.map(([ch]) => local(cf, ch.x, ch.y));
      const mx = pins.reduce((t, [x]) => t + x, 0) / pins.length;
      const my = pins.reduce((t, [, y]) => t + y, 0) / pins.length;
      // the side of the chip the pins are on: the axis where they sit nearest the pad extent (first wins a tie)
      const sides: Array<[Side, number]> = [[["x", 1], extX - mx], [["x", -1], extX + mx], [["y", 1], extY - my], [["y", -1], extY + my]];
      const side = sides.reduce((best, s) => (s[1] < best[1] ? s : best))[0];
      const pxExt = Math.max(...[...ppads.values()].map(([x]) => Math.abs(x))) + 0.35;
      const pyExt = Math.max(...[...ppads.values()].map(([, y]) => Math.abs(y))) + 0.35;
      let best: { cost: number; rot: number; ax: number; ay: number; wid: number } | null = null;
      for (const rot of [0, 90, 180, 270]) {
        const straight = rot === 0 || rot === 180;
        const dep = side[0] === "x" ? (straight ? pxExt : pyExt) : straight ? pyExt : pxExt;
        const wid = side[0] === "x" ? (straight ? pyExt : pxExt) : straight ? pxExt : pyExt;
        const [ax, ay] = side[0] === "x" ? [side[1] * (extX + GAP + dep), my] : [mx, side[1] * (extY + GAP + dep)];
        let cost = 0;
        links.forEach(([, pp], i) => {
          const [ox, oy] = rotPt(...ppads.get(pp.pad)!, rot);
          cost += Math.hypot(ax + ox - pins[i]![0], ay + oy - pins[i]![1]);
        });
        if (best === null || cost < best.cost) best = { cost, rot, ax, ay, wid };
      }
      const b = best!;
      members.push({
        ref: part,
        side,
        at: [b.ax, b.ay],
        rot: b.rot,
        wid: b.wid,
        pads: { [part]: links.map(([, pp]) => pp.pad).sort(), [chip]: links.map(([ch]) => ch.pad).sort() },
      });
    }
    // spread members on one side so their courtyards clear (keeps their order along the side)
    const sideKeys = [...new Set(members.map((m) => m.side.join()))];
    for (const key of sideKeys) {
      const k = key.startsWith("x") ? 1 : 0;
      const ms = members.filter((m) => m.side.join() === key).sort((p, q) => p.at[k] - q.at[k]);
      if (ms.length < 2) continue;
      const centre = ms.reduce((t, m) => t + m.at[k], 0) / ms.length;
      const total = ms.reduce((t, m) => t + m.wid * 2, 0) + 0.2 * (ms.length - 1);
      let pos = centre - total / 2;
      for (const m of ms) {
        m.at[k] = pos + m.wid;
        pos += m.wid * 2 + 0.2;
      }
    }
    if (!members.length) continue;
    rows[chip] = {
      anchor: chip,
      tolerance_mm: 0.3,
      members: members.map((m) => ({ ref: m.ref, at: [round4(m.at[0]), round4(m.at[1])], rot: m.rot, pads: m.pads })),
      source: "pairseat (the toolkit's flow/pairseat.py): pass-through parts of pairs on their chip pins, chip frame",
    };
  }
  return rows;
}

/** Move each seated member into its chip's group (out of any other); groups left empty are dropped. As the toolkit's onboard. */
export function seatGroups(groups: Group[], rows: Record<string, SeatRow>): Group[] {
  for (const [chip, row] of Object.entries(rows))
    for (const m of row.members) {
      for (const g of groups) if (g.anchor !== chip && g.refs.includes(m.ref)) g.refs = g.refs.filter((r) => r !== m.ref);
      const home = groups.find((g) => g.anchor === chip);
      if (home && !home.refs.includes(m.ref)) home.refs.push(m.ref);
    }
  return groups.filter((g) => g.refs.length);
}
