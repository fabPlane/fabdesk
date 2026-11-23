/** Parts (pose, side, value, pad nets) and nets (length per layer, vias, pads) of a board (toolkit `bench info`; courtyard size is not in the board model, so it is not reported). */
import type { Board } from "../board";
import { dist } from "./geometry";

export function infoLines(board: Board, items: readonly string[], allPads = false): string[] {
  const out: string[] = [];
  for (const item of items) {
    const f = board.footprints.get(item);
    if (f) {
      out.push(`${item}  ${f.value ?? ""}  at ${f.x.toFixed(2)},${f.y.toFixed(2)}  rot ${Number(f.rot.toFixed(6))}  ${f.layer[0]}  ${f.lib}`);
      const pads = board.pads.filter((q) => q.ref === item).sort((a, b) => Math.round(a.y * 10) - Math.round(b.y * 10) || a.x - b.x);
      for (const q of pads) if (allPads || (q.net && !q.net.startsWith("unconnected"))) out.push(`   pad ${q.pad.padStart(4)}  ${q.x.toFixed(2).padStart(7)} ${q.y.toFixed(2).padStart(7)}  ${q.net}`);
      continue;
    }
    let rx: RegExp;
    try {
      rx = new RegExp(item);
    } catch {
      out.push(`${item}: no part or net matches`);
      continue;
    }
    const nets = [...new Set([...board.pads.map((q) => q.net), ...board.segments.map((s) => s.net), ...board.vias.map((v) => v.net)].filter((n) => n && rx.test(n)))].sort();
    if (!nets.length) {
      out.push(`${item}: no part or net matches`);
      continue;
    }
    for (const n of nets) {
      const ln = new Map<string, number>();
      for (const s of board.segments) if (s.net === n) ln.set(s.layer, (ln.get(s.layer) ?? 0) + dist(s.a, s.b));
      const vias = board.vias.filter((v) => v.net === n).length;
      const pads = board.pads.filter((q) => q.net === n).map((q) => `${q.ref}.${q.pad}`);
      const total = [...ln.values()].reduce((a, b) => a + b, 0);
      const per = [...ln].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ");
      out.push(`${n}  total ${total.toFixed(2)} mm  [${per}]  vias ${vias}  pads ${pads.length}: ${pads.slice(0, 8).join(" ")}${pads.length > 8 ? " ..." : ""}`);
    }
  }
  return out;
}
