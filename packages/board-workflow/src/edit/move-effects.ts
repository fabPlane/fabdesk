/** Verify actual placement and describe the connections left behind by a move. */
import { parseBoard, type Board } from "../board";
import { diffBoards } from "./diff";
import { round, mod } from "./fmt";
import { stop } from "./sch";
import type { MoveLedger, Pose } from "./move";

/** Reject unwritten or partial moves, including a wrong destination that still counts as movement in a diff. */
export function verifyMovePoses(before: string, after: string, targets: ReadonlyMap<string, Pose>): Set<string> {
  const actual = parseBoard(after).footprints;
  const moved = new Set(diffBoards(before, after).moved);
  const failed = [...targets].filter(([r, p]) => {
    const f = actual.get(r);
    return !f || round(f.x, 4) !== round(p[0], 4) || round(f.y, 4) !== round(p[1], 4) || Math.abs(mod(f.rot - p[2] + 180, 360) - 180) > 1e-6;
  }).map(([r]) => r);
  if (failed.length) return stop(`FAIL ${failed.join(", ")}: planned pose was not written to the board (unsupported pose spelling or target mismatch); no repair run`);
  return moved;
}

/** Nearest pad span is a geometric estimate, not a prediction of the router's final track length. */
export function stayingBehind(before: Board, after: Board, moved: string[], seated: Set<string>): NonNullable<MoveLedger["staying_behind"]> {
  const result: NonNullable<MoveLedger["staying_behind"]> = [];
  const byNet = new Map<string, typeof before.pads>();
  for (const p of before.pads) if (p.net && !/GND|^unconnected-/i.test(p.net))
    (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)!).push(p);
  for (const r of moved) {
    const others = new Map<string, Array<{ net: string; lengthening_mm: number }>>();
    for (const [net, pads] of byNet) {
      const own = pads.filter((p) => p.ref === r);
      if (!own.length) continue;
      const placed = after.pads.filter((p) => p.ref === r && p.net === net);
      for (const other of new Set(pads.filter((p) => !seated.has(p.ref)).map((p) => p.ref))) {
        const remote = pads.filter((p) => p.ref === other);
        const span = (ps: typeof own) => Math.min(...ps.flatMap((p) => remote.map((q) => Math.hypot(p.x - q.x, p.y - q.y))));
        const delta = span(placed) - span(own);
        if (delta > 0.01) (others.get(other) ?? others.set(other, []).get(other)!).push({ net, lengthening_mm: round(delta, 2) });
      }
    }
    for (const [ref, nets] of others) result.push({ ref, moved: r, nets });
  }
  return result;
}
