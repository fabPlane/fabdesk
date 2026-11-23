/**
 * The toolkit's tools/tp_legalise.py, exactly: place single-pad footprints (test points) at the nearest free spot to
 * the centroid of the other pads on their net.
 *
 * For each ref in the order given: the target is the centroid of the other pads on the net of its first netted pad (its
 * own pose when there are none). A spiral on a 0.1 mm grid (ring r = k * 0.1 mm, max(1, floor(2 pi r / 0.1)) points per
 * ring, angle order) takes the first spot where the part's courtyard box (rotation kept) stays `edge` inside the bounding
 * box of the Edge.Cuts lines and rectangles, clears every other courtyard box on its side by `clearance` (the parts being
 * placed are not obstacles until placed; each placed one is for the next), and clears every drilled pad of every part at
 * its original pose (either side, the parts being placed included) by `clearance`. The centroid is summed as Python's
 * sum() and poses are rounded as its round(x, 3), so ties fall the same way. The edit path then applies them as plain moves (fan-out cut, repair, proof); native DRC is the acceptance.
 */
import { readBoard } from "../board";
import { pyRound } from "../accept";
import { kid, kids, num, parseSexpr } from "../sexpr";
import { localBox, overlap, worldBox, type Box } from "./geom";
import { rawFootprints } from "./move";
import { EditStop } from "./sch";

export interface LegaliseOptions {
  /** Courtyard / drill clearance, mm (tp_legalise --clearance, 0.15). */
  clearance?: number;
  /** Margin inside the outline, mm (tp_legalise --edge, 0.5). */
  edge?: number;
  /** Search radius, mm (tp_legalise: 400 rings of 0.1 mm = 40). */
  radius?: number;
}

/**
 * Python's sum() of floats (3.12+: Neumaier compensated summation). A plain left-to-right sum differs in the last bit,
 * enough to flip round(x, 3) on a centroid that sits on a tie (jetson TP45: 205.1675 vs 205.16750000000002).
 */
export function pySum(xs: readonly number[]): number {
  let total = 0;
  let c = 0;
  for (const x of xs) {
    const t = total + x;
    c += Math.abs(total) >= Math.abs(x) ? total - t + x : x - t + total;
    total = t;
  }
  return c !== 0 && Number.isFinite(c) ? total + c : total;
}

/** ref -> [x, y, rotation] for each ref, placed in order. Throws an EditStop naming the first ref with no free spot. */
export function legalisePoses(text: string, refs: readonly string[], opts: LegaliseOptions = {}): Map<string, [number, number, number]> {
  const clearance = opts.clearance ?? 0.15;
  const edgeM = opts.edge ?? 0.5;
  const rings = Math.round((opts.radius ?? 40) / 0.1);
  const root = parseSexpr(text);
  const board = readBoard(root);
  const fps = board.footprints;
  const raw = rawFootprints(root);
  for (const r of refs) if (!fps.has(r) || !raw.has(r)) throw new EditStop(`FAIL legalise ${r}: not on the board`);
  const edge: Array<[number, number]> = [];
  for (const g of [...kids(root, "gr_line"), ...kids(root, "gr_rect")]) {
    if (kid(g, "layer")?.[1] !== "Edge.Cuts") continue;
    for (const k of ["start", "end"]) {
      const p = kid(g, k);
      if (p) edge.push([num(p[1]), num(p[2])]);
    }
  }
  if (!edge.length) throw new EditStop("FAIL legalise: the board has no Edge.Cuts lines or rectangles");
  const X0 = Math.min(...edge.map((p) => p[0])) + edgeM;
  const Y0 = Math.min(...edge.map((p) => p[1])) + edgeM;
  const X1 = Math.max(...edge.map((p) => p[0])) - edgeM;
  const Y1 = Math.max(...edge.map((p) => p[1])) - edgeM;
  const placing = new Set(refs);
  const sideOf = (r: string) => fps.get(r)!.layer[0]!;
  const boxes = new Map<string, [string, Box]>();
  for (const [r, f] of fps) if (!placing.has(r) && raw.has(r)) boxes.set(r, [sideOf(r), worldBox(localBox(raw.get(r)!), f.x, f.y, f.rot)]);
  const drills: Box[] = [];
  for (const [r, fp] of raw) {
    const f = fps.get(r);
    if (!f) continue;
    const c = Math.cos((f.rot * Math.PI) / 180);
    const s = Math.sin((f.rot * Math.PI) / 180);
    for (const pad of kids(fp, "pad")) {
      if (!kid(pad, "drill")) continue;
      const at = kid(pad, "at")!;
      const size = kid(pad, "size")!;
      const px = num(at[1]);
      const py = num(at[2]);
      const cx = f.x + px * c + py * s;
      const cy = f.y - px * s + py * c;
      const h = Math.max(num(size[1]), num(size[2])) / 2;
      drills.push([cx - h, cy - h, cx + h, cy + h]);
    }
  }
  const out = new Map<string, [number, number, number]>();
  for (const ref of refs) {
    const f = fps.get(ref)!;
    const side = sideOf(ref);
    const lb = localBox(raw.get(ref)!);
    // the net of its first netted pad, in file order (Python's next(iter(pins.values())))
    const firstPad = kids(raw.get(ref)!, "pad").find((p) => kid(p, "net"));
    const netNode = firstPad ? kid(firstPad, "net")! : null;
    const net = netNode ? String(netNode[netNode.length - 1]) : null;
    const others = net === null ? [] : board.pads.filter((p) => p.net === net && p.ref !== ref);
    const tx = others.length ? pySum(others.map((p) => p.x)) / others.length : f.x;
    const ty = others.length ? pySum(others.map((p) => p.y)) / others.length : f.y;
    let best: [number, number, Box] | null = null;
    for (let ring = 0; ring < rings && !best; ring++) {
      const r = ring * 0.1;
      const steps = Math.max(1, Math.floor((2 * Math.PI * r) / 0.1));
      for (let k = 0; k < steps; k++) {
        const x = tx + r * Math.cos((2 * Math.PI * k) / steps);
        const y = ty + r * Math.sin((2 * Math.PI * k) / steps);
        const wb = worldBox(lb, x, y, f.rot);
        if (wb[0] < X0 || wb[1] < Y0 || wb[2] > X1 || wb[3] > Y1) continue;
        if ([...boxes.values()].some(([s, b]) => s === side && overlap(wb, b, clearance))) continue;
        if (drills.some((d) => overlap(wb, d, clearance))) continue;
        best = [pyRound(x, 3), pyRound(y, 3), wb];
        break;
      }
    }
    if (!best) throw new EditStop(`STOP legalise ${ref}: no free spot within ${rings / 10} mm of its net's centroid ${tx.toFixed(2)},${ty.toFixed(2)} (courtyards on ${side}.Cu, drilled pads and the outline - ${edgeM} mm block it)`);
    boxes.set(ref, [side, best[2]]);
    out.set(ref, [best[0], best[1], f.rot]);
  }
  return out;
}
