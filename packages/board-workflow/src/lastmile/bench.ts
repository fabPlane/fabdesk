/**
 * The last-mile bench (toolkit tools/bench.py + lastmile.py): parallel alternatives judged by the whole-board gate and
 * undone when they do not help. A workspace holds the accepted steps (s0 = the start board, each accepted candidate a
 * folder), `try` runs several actions from the current board at once, scores every whole board, accepts the best one
 * that passes the gate and leaves the board unchanged otherwise. Routers and other engines are not here: a Step is run
 * by the StepEngine the host supplies; scoring (A1-A9 plus native DRC) by the Scorer.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isInside } from "../files";
import { stepsFor, type Step } from "./actions";
import { compareKeys, figureLine, gate, keyOf, type Figures, type GateSlack, type OpenItem } from "./gate";
import { hostMemory } from "../sysinfo";
import { boardGridShape, routerFootprint, type RouterFootprint } from "../layout/footprint";
import { changedCopperNets } from "../layout/text";

export interface Scored {
  figures: Figures;
  opens: OpenItem[];
  /** The checks' verdicts (A1_connectivity ... A9_heights) and the A8 pair counts, for validate. */
  summary: Record<string, boolean>;
  pairsOverSkewLimit: number | null;
  parityChecked: boolean;
  /** A8 as the loop reads it: pairs to re-route and the nets with an A8 failure. */
  a8: { toReroute: Array<[string, string]>; failing: string[] };
}

export interface Scorer {
  /** Score the board folder `dir` (its board file `pcb`): A1-A9 on a native DRC with refilled zones. `parity` adds schematic parity. */
  score(dir: string, pcb: string, o: { parity: boolean; signal?: AbortSignal }): Promise<Scored>;
}

export type StepOutcome = { dir: string; info?: Record<string, unknown>; skipped?: boolean } | { error: string };

export interface StepInput {
  /** The board folder the step starts from (accepted step or the previous step of the chain). */
  cur: string;
  /** Where the step writes its board folder (created by the engine). */
  out: string;
  /** The board the whole candidate began from ("{start}" in a repair's rip arguments). */
  start: string;
  pcb: string;
  signal: AbortSignal;
}

export interface StepEngine {
  run(step: Step, input: StepInput): Promise<StepOutcome>;
}

export interface BenchDeps {
  scorer: Scorer;
  engine: StepEngine;
  /** Memory available now, GiB (default: `hostMemory()`, the same reading the resource governor uses). */
  availableGiB?: () => Promise<number>;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface HistoryEntry {
  action: string;
  dir: string;
  figures: Figures;
  wall_s: number;
}

export interface BenchState {
  src: string;
  pcb: string;
  pointer: number;
  tries: number;
  history: HistoryEntry[];
  log?: TryLog[];
  /** Free-form data the host keeps with the workspace (project, design-file hashes at `new`). */
  meta?: Record<string, unknown>;
}

export interface CandidateRecord {
  name: string;
  /** Nets whose copper this candidate changed that were not open on the board it started from (set by `try`). */
  otherNetsChanged?: string[];
  wall_s: number;
  figures?: Figures;
  rejected: string[];
  dir?: string;
  steps: Array<Record<string, unknown>>;
  error?: string;
}

export interface TryLog {
  try: number;
  from: number;
  wall_s: number;
  results: Array<Pick<CandidateRecord, "name" | "wall_s" | "figures" | "rejected" | "dir">>;
}

export interface TryResult {
  lines: string[];
  from: Figures;
  candidates: CandidateRecord[];
  accepted: string | null;
  pointer: number;
  figures: Figures;
}

const COPY_SKIP = /^(tm|tm-.*|acceptance.*\.json|score\.json|import\.json|\.fabdesk|\.git|_autosave.*|.*\.lock|lastmile\.score\.json|\.lastmile|round\d+\.drc\.json|base\.drc\.json|3d_lib|.*\.3dshapes|.*\.(step|stp|wrl|pdf|png))$/;

export async function copyBoardFolder(src: string, dst: string): Promise<void> {
  // entry by entry: a workspace may live inside the project it was started from (`.fabdesk` is skipped)
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true }))
    if (!COPY_SKIP.test(e.name)) await cp(join(src, e.name), join(dst, e.name), { recursive: true, filter: (p) => !COPY_SKIP.test(basename(p)) });
}

/**
 * Parallel candidates and per-action time scaled to the board (toolkit size_limits). `footprint` is one router run's
 * memory and time on this board (layout/footprint.ts, from outline area x copper layers); without it a candidate is
 * taken as 0.06 GiB per MB of board file, which badly undercounts large-area boards.
 */
export function sizeLimits(o: { pcbBytes: number; availableGiB: number; jobs: number; budget?: number | undefined; opens: number; footprint?: { memGiB: number; budgetS: number } | undefined }) {
  const mb = o.pcbBytes / 1e6;
  const per = o.footprint?.memGiB ?? Math.max(0.5, 0.06 * mb);
  const fit = Math.max(1, Math.trunc((o.availableGiB - 2) / per));
  const jobs = Math.max(1, Math.min(o.jobs, fit));
  const budget = o.budget ?? Math.max(180, Math.min(1800, 6 * o.opens), o.footprint?.budgetS ?? 0);
  const notes: string[] = [];
  if (jobs < o.jobs) notes.push(`${jobs} candidate(s) at a time (board ${mb.toFixed(0)} MB, ~${per.toFixed(1)} GiB per router run, ${o.availableGiB.toFixed(1)} GiB available)`);
  if (o.budget === undefined && budget > 180) notes.push(`budget ${budget.toFixed(0)} s per action (${o.opens} opens)`);
  return { jobs, budget, note: notes.length ? "limits: " + notes.join("; ") : "" };
}

/** One router run's footprint on the board file (null when it cannot be read: the file-size rule applies). */
async function boardFootprint(file: string, bytes: number): Promise<RouterFootprint | undefined> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (!text) return undefined;
  try {
    return routerFootprint(boardGridShape(text), bytes);
  } catch {
    return undefined;
  }
}

/** The host's available memory (Linux MemAvailable, macOS vm_stat, Windows os.freemem), the number the governor admits on. */
const memAvailableGiB = async (): Promise<number> => (await hostMemory()).availableGiB;

const slug = (s: string) => s.replace(/[^\w.+-]+/g, "_");

/**
 * One folder name per candidate of a try: actions that slug alike (`finish` twice, two regexes) or differ only in case
 * (one folder on a case-insensitive file system) get `-2`, `-3` ... so no two candidates write one folder.
 */
export function candidateSlugs(actions: readonly string[]): string[] {
  const used = new Set<string>();
  return actions.map((a) => {
    const base = slug(a);
    let s = base;
    for (let k = 2; used.has(s.toLowerCase()); k++) s = `${base}-${k}`;
    used.add(s.toLowerCase());
    return s;
  });
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const sha = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");

/** A folder's cached score: the scored board's sha256 with it, so a cache never answers for another board. */
type ScoreCache = Scored & { board_sha256: string };
const SCORE_CACHE = "lastmile.score.json";

export class Bench {
  private constructor(
    readonly ws: string,
    private st: BenchState,
    private readonly deps: BenchDeps,
  ) {}

  static async create(ws: string, srcDir: string, pcb: string, deps: BenchDeps, meta: Record<string, unknown> = {}): Promise<{ bench: Bench; line: string }> {
    ws = resolve(ws);
    if (await stat(ws).catch(() => null)) throw new Error(`${ws} exists`);
    await mkdir(ws, { recursive: true });
    const s0 = join(ws, "s0");
    await copyBoardFolder(srcDir, s0);
    const sc = await deps.scorer.score(s0, pcb, { parity: false, ...(deps.signal ? { signal: deps.signal } : {}) });
    await writeJson(join(s0, SCORE_CACHE), { ...sc, board_sha256: await sha(join(s0, pcb)) } satisfies ScoreCache);
    const st: BenchState = {
      src: resolve(srcDir),
      pcb,
      pointer: 0,
      tries: 0,
      history: [{ action: "start", dir: s0, figures: sc.figures, wall_s: 0 }],
      meta,
    };
    const bench = new Bench(ws, st, deps);
    await bench.save();
    return { bench, line: `${basename(ws)}: ${figureLine(sc.figures)}` };
  }

  static async open(ws: string, deps: BenchDeps): Promise<Bench> {
    ws = resolve(ws);
    const text = await readFile(join(ws, "state.json"), "utf8").catch(() => null);
    if (!text) throw new Error(`${ws}: no workspace (board_route {action: "new"})`);
    return new Bench(ws, JSON.parse(text) as BenchState, deps);
  }

  get state(): BenchState {
    return this.st;
  }
  get pointer() {
    return this.st.pointer;
  }
  get dir(): string {
    return this.st.history[this.st.pointer]!.dir;
  }
  get figures(): Figures {
    return this.st.history[this.st.pointer]!.figures;
  }
  get board(): string {
    return join(this.dir, this.st.pcb);
  }
  private say(l: string, lines?: string[]) {
    lines?.push(l);
    this.deps.onLine?.(l);
  }
  private async save() {
    await writeJson(join(this.ws, "state.json"), this.st);
  }

  /**
   * Score a folder, caching the result beside it (the toolkit recomputed figures on every call; the figures are a pure
   * function of the board). The cache holds the board's sha256 and is used only while the board is that board.
   */
  async scoreDir(dir: string, parity = false): Promise<Scored> {
    const f = join(dir, SCORE_CACHE);
    const boardSha = await sha(join(dir, this.st.pcb));
    if (!parity) {
      const cached = await readFile(f, "utf8").then((t) => JSON.parse(t) as Partial<ScoreCache>, () => null);
      if (cached?.board_sha256 === boardSha) {
        const { board_sha256: _h, ...sc } = cached as ScoreCache;
        return sc;
      }
    }
    const sc = await this.deps.scorer.score(dir, this.st.pcb, { parity, ...(this.deps.signal ? { signal: this.deps.signal } : {}) });
    if (!parity) await writeJson(f, { ...sc, board_sha256: boardSha } satisfies ScoreCache);
    return sc;
  }

  openNets(sc: Scored): string[] {
    return [...new Set(sc.opens.map((o) => o.net))].sort();
  }

  private async runCandidate(c: { name: string; steps: Step[]; slug: string }, cur: string, out: string, budget: number): Promise<CandidateRecord> {
    const t0 = Date.now();
    const rec: CandidateRecord = { name: c.name, wall_s: 0, rejected: [], steps: [] };
    const signal = AbortSignal.any([...(this.deps.signal ? [this.deps.signal] : []), AbortSignal.timeout(budget * 1000)]);
    let dir = cur;
    let i = 0;
    for (const st of c.steps) {
      i++;
      const stepOut = c.steps.length > 1 ? join(out, `s${i}`) : out;
      let r;
      try {
        signal.throwIfAborted(); // no next step once the budget is spent or the job is cancelled
        r = await this.deps.engine.run(st, { cur: dir, out: stepOut, start: cur, pcb: this.st.pcb, signal });
      } catch (e) {
        r = { error: signal.aborted && !this.deps.signal?.aborted ? "over the time budget" : e instanceof Error ? e.message : String(e) };
      }
      if ("error" in r) {
        rec.steps.push({ type: st.type, error: r.error });
        rec.error = r.error;
        break;
      }
      rec.steps.push({ type: st.type, ...(r.skipped ? { skipped: true } : {}), ...(r.info ?? {}) });
      dir = r.dir;
    }
    rec.wall_s = Math.round((Date.now() - t0) / 100) / 10;
    // a step that ran past the budget may still have left a (partial) board: it is over budget, not a candidate; scoring
    // it would spend a whole-board DRC on a result the gate must not take (vme-wren: ~9 min after a stopped KRT run)
    if (!rec.error && signal.aborted && !this.deps.signal?.aborted) rec.error = "over the time budget";
    if (!rec.error) {
      try {
        const sc = await this.scoreDir(dir);
        rec.dir = dir;
        rec.figures = sc.figures;
      } catch (e) {
        rec.error = e instanceof Error ? e.message : String(e);
      }
    }
    return rec;
  }

  /**
   * Run the actions in parallel from the current board, score each whole board, accept the best one that passes the
   * gate (unless `noAccept`), print one line each.
   */
  async try(actions: string[], o: { noAccept?: boolean; jobs?: number; slackA8?: number; budget?: number } = {}): Promise<TryResult> {
    const lines: string[] = [];
    const start = this.dir;
    const f0 = this.figures;
    this.st.tries++;
    // a try folder left by a run that never saved its state is not reused (its candidates belong to other boards)
    while (await stat(join(this.ws, `t${this.st.tries}`)).catch(() => null)) this.st.tries++;
    const tdir = join(this.ws, `t${this.st.tries}`);
    const slugs = candidateSlugs(actions);
    const cands = actions.map((name, k) => ({ name, steps: stepsFor(name), slug: slugs[k]! }));
    const t0 = Date.now();
    const pcbBytes = (await stat(join(start, this.st.pcb)).catch(() => null))?.size ?? 0;
    const footprint = await boardFootprint(join(start, this.st.pcb), pcbBytes);
    const lim = sizeLimits({ pcbBytes, availableGiB: await (this.deps.availableGiB ?? memAvailableGiB)(), jobs: o.jobs ?? 6, budget: o.budget, opens: f0.open, footprint });
    if (lim.note) this.say(lim.note, lines);
    const recs = await pool(cands, lim.jobs, (c) => this.runCandidate(c, start, join(tdir, c.slug), lim.budget));
    const slack: GateSlack = { a8_slack: o.slackA8 ?? 0 };
    const before = new Set(this.openNets(await this.scoreDir(start)));
    this.say(`from  ${figureLine(f0)}`, lines);
    for (const r of recs) r.rejected = r.error ? [r.error.slice(-160).replaceAll("\n", " ")] : gate(r.figures!, f0, slack);
    const ok = recs.filter((r) => !r.rejected.length).sort((a, b) => compareKeys(keyOf(a.figures!), keyOf(b.figures!)));
    for (const r of recs) {
      if (!r.figures) {
        this.say(`  ${r.name.padEnd(28)} ${r.wall_s.toFixed(0).padStart(5)}s  FAILED: ${r.rejected[0]}`, lines);
        continue;
      }
      const after = new Set(this.openNets(await this.scoreDir(r.dir!)));
      const closed = [...before].filter((n) => !after.has(n)).sort();
      const fresh = [...after].filter((n) => !before.has(n)).sort();
      // nets whose copper the candidate changed beyond the ones that were open: what a "change only this" task must see
      const startText = await readFile(join(start, this.st.pcb), "utf8").catch(() => "");
      const candText = await readFile(join(r.dir!, this.st.pcb), "utf8").catch(() => "");
      r.otherNetsChanged = startText && candText ? changedCopperNets(startText, candText).filter((n) => !before.has(n)) : [];
      const others = r.otherNetsChanged.length
        ? `also changed ${r.otherNetsChanged.length} other net(s): ${r.otherNetsChanged.slice(0, 6).join(", ")}${r.otherNetsChanged.length > 6 ? ", ..." : ""}`
        : "";
      const delta = [closed.length ? `closed ${closed.join(", ")}` : "", fresh.length ? `NEW open ${fresh.join(", ")}` : "", others].filter(Boolean).join("; ");
      const verdict = ok[0] === r && !o.noAccept ? "ACCEPT" : r.rejected.length ? r.rejected.join("; ") : "passes gate";
      this.say(`  ${r.name.padEnd(28)} ${r.wall_s.toFixed(0).padStart(5)}s  ${figureLine(r.figures)}  -> ${verdict}${delta ? `  [${delta}]` : ""}`, lines);
    }
    (this.st.log ??= []).push({
      try: this.st.tries,
      from: this.st.pointer,
      wall_s: Math.round((Date.now() - t0) / 100) / 10,
      results: recs.map((r) => ({ name: r.name, wall_s: r.wall_s, ...(r.figures ? { figures: r.figures } : {}), rejected: r.rejected, ...(r.dir ? { dir: r.dir } : {}), ...(r.otherNetsChanged ? { other_nets_changed: r.otherNetsChanged } : {}) })),
    });
    const best = ok[0];
    if (best && !o.noAccept) {
      this.st.history = [...this.st.history.slice(0, this.st.pointer + 1), { action: best.name, dir: best.dir!, figures: best.figures!, wall_s: best.wall_s }];
      this.st.pointer++;
      this.say(`now   step ${this.st.pointer}: ${figureLine(best.figures!)}   (${Math.round((Date.now() - t0) / 1000)}s)`, lines);
    } else this.say(`now   unchanged (step ${this.st.pointer})   (${Math.round((Date.now() - t0) / 1000)}s)`, lines);
    await this.save();
    return { lines, from: f0, candidates: recs, accepted: best && !o.noAccept ? best.name : null, pointer: this.st.pointer, figures: this.figures };
  }

  /**
   * Per-pair loop: each round, one candidate per pair still failing A8 (`template` with `{pair}` = a regex for that pair),
   * plus clusters of pairs whose pad areas lie within 1 mm and all of them together, all from the current board in
   * parallel; the gate accepts the best; repeat until a round accepts nothing.
   */
  async loop(
    template: string,
    o: { pairs?: string; maxRounds?: number; jobs?: number; budget?: number; padBoxes?: (dir: string, nets: string[]) => Promise<[number, number, number, number] | null> } = {},
  ): Promise<string[]> {
    const lines: string[] = [];
    const t0 = Date.now();
    for (let rnd = 1; rnd <= (o.maxRounds ?? 6); rnd++) {
      const a8 = await this.a8Failing();
      let failing = a8;
      if (o.pairs) failing = failing.filter((p) => p.some((n) => new RegExp(o.pairs!).test(n)));
      if (!failing.length) {
        this.say("loop: no failing pairs left", lines);
        break;
      }
      const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\+", ".");
      let groups: Array<Array<[string, string]>> = failing.map((p) => [p]);
      if (failing.length > 1) {
        // pairs whose pad areas lie within 1 mm interact: also as one candidate per cluster, and all together
        const cl = new Map<string, Array<[string, string]>>();
        if (o.padBoxes) {
          const box = new Map<string, [number, number, number, number]>();
          for (const p of failing) {
            const b = await o.padBoxes(this.dir, [...p]);
            if (b) box.set(p.join("|"), b);
          }
          const par = new Map(failing.map((p) => [p.join("|"), p.join("|")]));
          const find = (x: string): string => (par.get(x) === x ? x : find(par.get(x)!));
          for (let i = 0; i < failing.length; i++)
            for (const q of failing.slice(i + 1)) {
              const A = box.get(failing[i]!.join("|"));
              const B = box.get(q.join("|"));
              if (A && B && A[0] <= B[2] && B[0] <= A[2] && A[1] <= B[3] && B[1] <= A[3]) par.set(find(failing[i]!.join("|")), find(q.join("|")));
            }
          for (const p of failing) (cl.get(find(p.join("|"))) ?? cl.set(find(p.join("|")), []).get(find(p.join("|")))!).push(p);
        }
        groups = [...groups, ...[...cl.values()].filter((g) => g.length > 1 && g.length < failing.length), failing];
      }
      const acts = groups.map((g) => template.replace("{pair}", "^(" + g.map((p) => esc(p[0])).join("|") + ")$"));
      this.say(`loop round ${rnd}: ${acts.length} candidates`, lines);
      const before = this.st.pointer;
      const r = await this.try(acts, { jobs: o.jobs ?? 5, budget: o.budget ?? 900 });
      lines.push(...r.lines);
      if (this.st.pointer === before) break;
    }
    this.say(`loop: ${Math.round((Date.now() - t0) / 1000)}s`, lines);
    return lines;
  }

  /** Pairs still failing A8 on the current board: those to re-route that have a failing net (sorted, unique). */
  async a8Failing(): Promise<Array<[string, string]>> {
    const { toReroute, failing } = (await this.scoreDir(this.dir)).a8;
    const bad = new Set(failing);
    const uniq = new Map(toReroute.filter((p) => p.some((n) => bad.has(n))).map((p) => [p.join("\u0000"), p] as [string, [string, string]]));
    return [...uniq.values()].sort((x, y) => (x.join("\u0000") < y.join("\u0000") ? -1 : 1));
  }

  /** Go back one accepted step. */
  async undo(): Promise<string> {
    if (this.st.pointer === 0) throw new Error("at the start board");
    this.st.pointer--;
    await this.save();
    return `step ${this.st.pointer}: ${figureLine(this.figures)}`;
  }

  /** Accept an earlier try's scored board after re-running the gate against the current board (no re-route). */
  async acceptDir(dir: string, o: { slackA8?: number } = {}): Promise<{ ok: boolean; lines: string[] }> {
    const d = resolve(dir);
    const lines: string[] = [];
    const f0 = this.figures;
    const f1 = (await this.scoreDir(d)).figures;
    const why = gate(f1, f0, { a8_slack: o.slackA8 ?? 0 });
    this.say(`from  ${figureLine(f0)}\nthis  ${figureLine(f1)}  -> ${why.length ? why.join("; ") : "ACCEPT"}`, lines);
    if (why.length) return { ok: false, lines };
    const rel = relative(this.ws, d);
    this.st.history = [...this.st.history.slice(0, this.st.pointer + 1), { action: `accept ${rel.startsWith("..") ? d : rel}`, dir: d, figures: f1, wall_s: 0 }];
    this.st.pointer++;
    await this.save();
    this.say(`now   step ${this.st.pointer}: ${figureLine(f1)}`, lines);
    return { ok: true, lines };
  }

  /** Delete try candidates no accepted step uses (each try copies the whole project). */
  async prune(): Promise<string> {
    const keep = this.st.history.map((h) => resolve(h.dir));
    let gone = 0;
    for (const t of await readdir(this.ws)) {
      if (!/^t\d+$/.test(t)) continue;
      for (const c of await readdir(join(this.ws, t)).catch(() => [] as string[])) {
        const r = resolve(this.ws, t, c);
        if (!keep.some((k) => isInside(r, k))) {
          await rm(r, { recursive: true, force: true });
          gone++;
        }
      }
    }
    for (const x of ["cache", "views"]) await rm(join(this.ws, x), { recursive: true, force: true });
    return `pruned ${gone} candidate dirs; kept ${keep.length} accepted steps`;
  }

  /** Full proof of the current board: A1-A9 with schematic parity, written to validate.json. */
  async validate(): Promise<Record<string, unknown>> {
    const v = join(this.ws, "validate");
    await rm(v, { recursive: true, force: true });
    await copyBoardFolder(this.dir, v);
    await rm(join(v, "lastmile.score.json"), { force: true });
    const sc = await this.deps.scorer.score(v, this.st.pcb, { parity: true, ...(this.deps.signal ? { signal: this.deps.signal } : {}) });
    const rec = {
      board: join(v, this.st.pcb),
      sha256: await sha(join(v, this.st.pcb)),
      summary: sc.summary,
      all_pass: Object.values(sc.summary).every(Boolean),
      parity_checked: sc.parityChecked,
      pairs_over_length_limit: sc.pairsOverSkewLimit,
      figures: sc.figures,
      steps: this.st.history.slice(0, this.st.pointer + 1).map((h) => h.action),
    };
    await writeJson(join(v, "validate.json"), rec);
    return rec;
  }

  /** The text of `status`: steps so far with their figures. */
  statusLines(): string[] {
    const st = this.st;
    return [
      `${basename(this.ws)}  step ${st.pointer} of ${st.history.length - 1}  tries ${st.tries}  board ${this.dir}`,
      ...st.history.map((h, i) => `  ${i === st.pointer ? ">" : " "} ${String(i).padStart(2)} ${h.action.padEnd(26)} ${h.wall_s.toFixed(0).padStart(5)}s  ${figureLine(h.figures)}`),
    ];
  }

  /** Where the accepted board lives, for a host that hands it to adoption. */
  candidateBoard(): string {
    return join(this.dir, this.st.pcb);
  }

  async setMeta(patch: Record<string, unknown>) {
    this.st.meta = { ...this.st.meta, ...patch };
    await this.save();
  }
}

async function writeJson(path: string, v: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(v, null, 1) + "\n");
}
