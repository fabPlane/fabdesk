/**
 * Placement sweep (toolkit bench.py cmd_sweep): for each part, poses on a grid round where it is (offsets x rotations,
 * each courtyard-gated by the nudge step), every one followed by `then` (a repair chain), all tried from the current
 * board and the best accepted by the gate. Illegal poses fail in under a second, so the grid can be generous.
 */
import { footprintSpans, pose } from "../layout/text";

export interface SweepOptions {
  span?: number;
  step?: number;
  rotations?: "keep" | "flip" | "all";
  then?: string;
}

const g = (x: number) => String(Number(x.toPrecision(6))); // Python's {:g} for the rotations used here

/** The `try` actions of a sweep over `refs` on the board text. */
export function sweepActions(boardText: string, refs: string[], o: SweepOptions = {}): string[] {
  const span = o.span ?? 1.0;
  const step = o.step ?? 0.5;
  const rotations = o.rotations ?? "flip";
  const spans = footprintSpans(boardText);
  const k = Math.round(span / step);
  const offs = Array.from({ length: 2 * k + 1 }, (_, i) => (i - k) * step);
  const acts: string[] = [];
  for (const ref of refs) {
    const sp = spans.get(ref);
    if (!sp) throw new Error(`sweep: no footprint ${ref} on the board`);
    const [x, y, rot] = pose(boardText.slice(sp[0], sp[1]));
    const deltas = rotations === "flip" ? [0, 180] : rotations === "all" ? [0, 90, 180, 270] : [0];
    const rots = [...new Set(deltas.map((d) => (((rot + d) % 360) + 360) % 360))].sort((a, b) => a - b);
    for (const dx of offs)
      for (const dy of offs)
        for (const r of rots) {
          if (dx === 0 && dy === 0 && r === rot) continue;
          acts.push(`nudge:${ref}@${(x + dx).toFixed(2)},${(y + dy).toFixed(2)}@${g(r)}~${(step / 2).toFixed(2)}` + (o.then ? `+${o.then}` : ""));
        }
  }
  return acts;
}
