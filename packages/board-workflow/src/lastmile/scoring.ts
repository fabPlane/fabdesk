/** The bench's scorer: A1-A9 on a native DRC (refilled zones) for one board folder, plus the open connections. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkAcceptance, type DrcInput } from "../accept";
import { parseBoard } from "../board";
import type { Requirements } from "../requirements";
import type { Scored, Scorer } from "./bench";
import { boardNets, figuresOf, type OpenItem } from "./gate";

export interface DrcRun {
  violations: Array<DrcInput["violations"][number] & { items?: Array<{ description: string; uuid?: string; pos?: { x: number; y: number } }> }>;
  unconnected: Array<{ items: Array<{ description: string; uuid?: string; pos?: { x: number; y: number } }> }>;
  parity: number;
}

export type DrcFn = (o: { board: string; parity: boolean; outFile: string; signal?: AbortSignal }) => Promise<DrcRun>;

/** Net and ends of each unconnected item: the net is the first `[NAME]` of the first item's description. */
export function opensOf(unconnected: DrcRun["unconnected"]): OpenItem[] {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const out: OpenItem[] = [];
  for (const u of unconnected) {
    const [a, b] = u.items;
    if (!a || !b) continue;
    const net = /\[([^\]]*)\]/.exec(a.description)?.[1] ?? "?";
    out.push({ net, a: [r2(a.pos?.x ?? 0), r2(a.pos?.y ?? 0)], b: [r2(b.pos?.x ?? 0), r2(b.pos?.y ?? 0)] });
  }
  return out;
}

export function createScorer(req: Requirements, drc: DrcFn): Scorer {
  const nets = boardNets(req);
  return {
    async score(dir, pcb, o) {
      await mkdir(join(dir, ".lastmile"), { recursive: true });
      const board = join(dir, pcb);
      const run = await drc({ board, parity: o.parity, outFile: join(dir, ".lastmile", "drc.json"), ...(o.signal ? { signal: o.signal } : {}) });
      const acc = checkAcceptance(parseBoard(await readFile(board, "utf8")), req, { violations: run.violations, unconnected: run.unconnected.length, parity: run.parity }, { parityChecked: o.parity, boardPath: board });
      const opens = opensOf(run.unconnected);
      // kept beside the DRC report: later steps of a chain (repair rips, @pairs-todo) read what this board fails
      await writeFile(join(dir, ".lastmile", "acceptance.json"), JSON.stringify(acc, null, 1) + "\n");
      await writeFile(join(dir, ".lastmile", "drc-run.json"), JSON.stringify(run) + "\n");
      const a8 = acc.results.A8_pairs;
      const sc: Scored = {
        figures: figuresOf(acc, opens, nets),
        opens,
        summary: Object.fromEntries(Object.entries(acc.summary)),
        pairsOverSkewLimit: typeof a8["pairs_over_skew_limit"] === "number" ? a8["pairs_over_skew_limit"] : null,
        parityChecked: o.parity,
        a8: { toReroute: (a8["pairs_to_reroute"] ?? []) as Array<[string, string]>, failing: Object.keys((a8["detail"] ?? {}) as object) },
      };
      return sc;
    },
  };
}
