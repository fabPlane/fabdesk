/**
 * Pin facing of pair pins on a placed board (port of `flow/facing.py`): does each chip's pair-pin side face where the
 * pair goes? A pair whose pins face away (cos < 0) must wrap round its chip, and no router step fixes that.
 */
import { pyRound } from "../accept";
import type { Board, Footprint, Pad } from "../board";
import type { Acceptance } from "../requirements";

const IC = /^(U|IC)\d/;

export interface FacingRow {
  pair: string;
  chip: string;
  cos: number;
  far_mm: number;
  faces_away: boolean;
}

const local = (fp: Footprint, x: number, y: number): [number, number] => {
  const r = (fp.rot * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = x - fp.x, dy = y - fp.y;
  return [c * dx - s * dy, s * dx + c * dy];
};
const rotPt = (px: number, py: number, deg: number): [number, number] => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [px * c + py * s, -px * s + py * c];
};

export function facing(board: Board, acc: Acceptance): FacingRow[] {
  const pads = board.pads;
  const byNet = new Map<string, Pad[]>();
  for (const p of pads) if (p.net) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)!).push(p);
  const out: FacingRow[] = [];
  for (const c of Object.values(acc.net_classes.classes)) {
    for (const [pn, nn] of c.pairs ?? []) {
      const ends = [...(byNet.get(pn) ?? []), ...(byNet.get(nn) ?? [])];
      const chips = [...new Set(ends.filter((p) => IC.test(p.ref)).map((p) => p.ref))].sort();
      for (const chip of chips) {
        const cf = board.footprints.get(chip)!;
        const mine = ends.filter((p) => p.ref === chip);
        const cpads = pads.filter((p) => p.ref === chip).map((p) => local(cf, p.x, p.y));
        const ex = Math.max(...cpads.map(([x]) => Math.abs(x))) + 1e-6;
        const ey = Math.max(...cpads.map(([, y]) => Math.abs(y))) + 1e-6;
        const ml = mine.map((p) => local(cf, p.x, p.y));
        const lx = ml.reduce((s, [x]) => s + x, 0) / mine.length;
        const ly = ml.reduce((s, [, y]) => s + y, 0) / mine.length;
        const [nx, ny] = Math.abs(lx) / ex >= Math.abs(ly) / ey ? [lx > 0 ? 1 : -1, 0] : [0, ly > 0 ? 1 : -1];
        if (new Set(ml.map(([x, y]) => ((nx ? x : y) > 0 ? 1 : -1))).size > 1) continue; // flow-through part: facing is meaningless
        const [bx, by] = rotPt(nx, ny, cf.rot);
        const far = ends.filter((p) => p.ref !== chip);
        const hop = new Set(far.filter((p) => (byNet.get(p.net)?.length ?? 0) === 2).map((p) => p.ref));
        const beyond: Pad[] = [];
        for (const p of far)
          if (hop.has(p.ref))
            for (const q of pads) if (q.ref === p.ref && q.net && q.net !== pn && q.net !== nn && (byNet.get(q.net)?.length ?? 0) >= 2) beyond.push(q);
        const viaHop = beyond.flatMap((b) => (byNet.get(b.net) ?? []).filter((q) => q.ref !== b.ref));
        const tgt = viaHop.length ? viaHop : far;
        const tx = tgt.reduce((s, q) => s + q.x, 0) / tgt.length - cf.x;
        const ty = tgt.reduce((s, q) => s + q.y, 0) / tgt.length - cf.y;
        const d = Math.hypot(tx, ty) || 1.0;
        const cos = (bx * tx + by * ty) / d;
        out.push({ pair: `${pn} / ${nn}`, chip, cos: pyRound(cos, 2), far_mm: pyRound(d, 1), faces_away: cos < 0 && d > 5.0 });
      }
    }
  }
  return out;
}
