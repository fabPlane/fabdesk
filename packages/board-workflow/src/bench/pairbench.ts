/**
 * The pair-tool bench (the toolkit's `tools/pairbench.py`): the same pair actions on several boards, one comparable
 * table. Each board gets a last-mile workspace and every action runs from the same start (`Bench.try` with no accept).
 * Per board and action: wall time, the gate figures (open, DRC, A8 nets) and the gate verdict, plus what the gate does
 * not see: pairs failing coupling, the mean coupled share of the pairs failing at the start, the worst P/N length
 * difference, and collateral (non-pair copper items added or removed against the start). A pair-tool change earns its
 * place when no board gets worse (DRC, opens, collateral) and the carrier or a held-out board gets better.
 *
 * It measures the last-mile pair tools, so it is a dev harness (`scripts/bench.ts pairs`) over the host's Bench (scorer
 * and step engine), not an agent tool.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBoard } from "../board";
import { pyRound } from "../accept";
import type { Figures } from "../lastmile/gate";
import { measurePairs, type PairSpec } from "../lastmile/pairs";
import { Bench, type BenchDeps } from "../lastmile/bench";

const ITEM = /\((segment|via|arc)\b(?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;

export interface PairMetrics {
  pairs_uncoupled: number;
  uncoupled: string[];
  focus_mean_share: number | null;
  worst_len_diff: number;
  shares: Record<string, number>;
}

/** Coupling figures of a board: pairs >= 7 mm with a coupled share under 0.5, the mean share of `failing0` (default those). */
export function boardMetrics(text: string, pairs: readonly PairSpec[], stack: readonly string[], failing0?: readonly string[]): PairMetrics {
  const m = measurePairs(parseBoard(text), pairs, stack);
  const under = Object.keys(m).filter((k) => m[k]!.p_mm >= 7.0 && m[k]!.coupled_share < 0.5);
  const focus = failing0 ?? under;
  const vals = Object.values(m);
  return {
    pairs_uncoupled: under.length,
    uncoupled: [...under].sort(),
    focus_mean_share: focus.length ? pyRound(focus.reduce((s, k) => s + m[k]!.coupled_share, 0) / focus.length, 3) : null,
    worst_len_diff: vals.length ? Math.max(...vals.map((v) => Math.abs(v.p_mm - v.n_mm))) : 0,
    shares: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.coupled_share])),
  };
}

/** Copper items (segment, via, arc) not on a pair net, uuids masked and whitespace collapsed: collateral is the symmetric difference. */
export function nonpairItems(text: string, pairNets: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const mt of text.matchAll(ITEM)) {
    const blk = mt[0];
    const n = /\(net "((?:[^"\\]|\\.)*)"\)/.exec(blk);
    if (n && pairNets.has(JSON.parse(`"${n[1]}"`) as string)) continue;
    out.add(blk.replace(/\(uuid "[^"]+"\)/g, "").replace(/\s+/g, " "));
  }
  return out;
}

export const symmetricDifference = <T,>(a: ReadonlySet<T>, b: ReadonlySet<T>) => [...a].filter((x) => !b.has(x)).length + [...b].filter((x) => !a.has(x)).length;

export interface PairbenchRow {
  action: string;
  wall_s: number | null;
  figures: Figures | null;
  verdict: string[] | "passes gate";
  pairs_uncoupled?: number;
  focus_mean_share?: number | null;
  worst_len_diff?: number;
  collateral?: number;
}

export interface PairbenchBoard {
  board: string;
  src: string;
  start: { figures: Figures; pairs_uncoupled: number; focus_mean_share: number | null; worst_len_diff: number };
  rows: PairbenchRow[];
  wall_s: number;
  bench_stdout: string;
}

/** Python `f"{x:.Nf}"` (ties to even on the exact value). */
const fx = (x: number, nd: number) => pyRound(x, nd).toFixed(nd);
const pyNum = (x: number | null | undefined) => (x === null || x === undefined ? "None" : Number.isInteger(x) ? x.toFixed(1) : String(x));
const sumDrc = (f: Figures) => Object.values(f.drc).reduce((s, v) => s + v, 0);

/** The toolkit's table. */
export function pairbenchTable(recs: readonly PairbenchBoard[]): string {
  const L = ["| board | action | s | open | DRC | A8 nets | pairs uncoupled | mean share (failing at start) | worst ΔL mm | collateral | gate |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of recs) {
    const f = r.start.figures;
    L.push(`| ${r.board} | *start* | | ${f.open} | ${sumDrc(f)} | ${f.a8} | ${r.start.pairs_uncoupled} | ${pyNum(r.start.focus_mean_share)} | ${fx(r.start.worst_len_diff, 2)} | | |`);
    for (const x of r.rows) {
      const g = x.figures;
      if (!g) {
        L.push(`| | ${x.action} | ${fx(x.wall_s || 0, 0)} | failed | | | | | | | ${(Array.isArray(x.verdict) ? `[${x.verdict.map((v) => `'${v}'`).join(", ")}]` : x.verdict).slice(0, 60)} |`);
        continue;
      }
      const v = x.verdict === "passes gate" ? "pass" : x.verdict.join("; ").slice(0, 50);
      L.push(`| | ${x.action} | ${fx(x.wall_s ?? 0, 0)} | ${g.open} | ${sumDrc(g)} | ${g.a8} | ${x.pairs_uncoupled} | ${pyNum(x.focus_mean_share)} | ${fx(x.worst_len_diff ?? 0, 2)} | ${x.collateral} | ${v} |`);
    }
  }
  return L.join("\n") + "\n";
}

export interface PairbenchBoardInput {
  name: string;
  /** Board folder (scored, as the bench starts from). */
  src: string;
  /** Board file name inside src. */
  pcb: string;
  out: string;
  actions: string[];
  pairs: readonly PairSpec[];
  stack: readonly string[];
  deps: BenchDeps;
  jobs?: number;
  budget?: number;
}

/** One board: workspace (kept between runs), every action from the same start, metrics per candidate; boards pruned after. */
export async function pairbenchBoard(i: PairbenchBoardInput): Promise<PairbenchBoard> {
  const t0 = Date.now();
  const ws = join(i.out, "ws");
  const bench = await Bench.open(ws, i.deps).catch(async () => (await Bench.create(ws, i.src, i.pcb, i.deps)).bench);
  const tr = await bench.try(i.actions, { noAccept: true, ...(i.jobs ? { jobs: i.jobs } : {}), ...(i.budget ? { budget: i.budget } : {}) });
  const st = bench.state;
  const pairNets = new Set(i.pairs.flatMap((p) => [p.p, p.n]));
  const startText = await readFile(join(st.history[st.pointer]!.dir, st.pcb), "utf8");
  const m0 = boardMetrics(startText, i.pairs, i.stack);
  const baseItems = nonpairItems(startText, pairNets);
  const rows: PairbenchRow[] = [];
  for (const r of st.log?.at(-1)?.results ?? []) {
    const row: PairbenchRow = { action: r.name, wall_s: r.wall_s ?? null, figures: r.figures ?? null, verdict: r.rejected.length ? r.rejected : "passes gate" };
    if (r.dir && r.figures) {
      const text = await readFile(join(r.dir, st.pcb), "utf8");
      const mm = boardMetrics(text, i.pairs, i.stack, m0.uncoupled);
      Object.assign(row, { pairs_uncoupled: mm.pairs_uncoupled, focus_mean_share: mm.focus_mean_share, worst_len_diff: mm.worst_len_diff, collateral: symmetricDifference(baseItems, nonpairItems(text, pairNets)) });
    }
    rows.push(row);
  }
  await bench.prune(); // metrics kept, boards not
  const rec: PairbenchBoard = {
    board: i.name,
    src: i.src,
    start: { figures: st.history[st.pointer]!.figures, pairs_uncoupled: m0.pairs_uncoupled, focus_mean_share: m0.focus_mean_share, worst_len_diff: m0.worst_len_diff },
    rows,
    wall_s: pyRound((Date.now() - t0) / 1000, 1),
    bench_stdout: tr.lines.join("\n").slice(-3000),
  };
  await mkdir(i.out, { recursive: true });
  await writeFile(join(i.out, "board.json"), JSON.stringify(rec, null, 1) + "\n");
  return rec;
}

export interface PairbenchConfig {
  boards: Array<{ name: string; src: string; pcb?: string }>;
  actions: string[];
}

/** All boards in sequence (each runs its actions in parallel); pairbench.json + pairbench.md in `out`. */
export async function runPairbench(cfg: PairbenchConfig, out: string, board: (b: PairbenchConfig["boards"][number], dir: string) => Promise<PairbenchBoard>, say: (l: string) => void = () => {}): Promise<{ table: string; boards: PairbenchBoard[] }> {
  await mkdir(out, { recursive: true });
  const t0 = Date.now();
  const recs: PairbenchBoard[] = [];
  for (const b of cfg.boards) {
    const d = join(out, b.name);
    await mkdir(d, { recursive: true });
    try {
      recs.push(await board(b, d));
      say(`${b.name}: done`);
    } catch (e) {
      say(`${b.name}: failed\n${(e instanceof Error ? e.message : String(e)).slice(-1200)}`);
    }
  }
  const table = pairbenchTable(recs);
  await writeFile(join(out, "pairbench.json"), JSON.stringify({ config: cfg, wall_s: pyRound((Date.now() - t0) / 1000, 1), boards: recs }, null, 1) + "\n");
  await writeFile(join(out, "pairbench.md"), table);
  return { table, boards: recs };
}
