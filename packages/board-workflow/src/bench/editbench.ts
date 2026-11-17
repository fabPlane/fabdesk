/**
 * The edit suite (the toolkit's `flow/editbench.py` `tasks` and `table`): a fixed set of edit tasks per board, chosen by
 * rules from the board so a held-out board gets the same kinds of edits without hand tuning, and the table that compares
 * results across boards, tasks and tool versions. `run` is the edit stage itself (`runEdit` mode full with the bench
 * repair and the churn guard); these are for measuring it.
 *
 * Tasks:
 *   remove   a 2-pad decoupling capacitor whose nets keep >= 3 pads (no pins left alone)
 *   value    a resistor's value: no copper change expected
 *   move     a 2-pad passive re-seated next to the part at the other end of its signal net (the tool computes the pose)
 *   swap     a 2-pad capacitor onto another capacitor footprint already in the board (different pad spacing)
 *   add      a decoupling capacitor on an IC's supply pin, next to that IC (copies an existing capacitor's symbol)
 *   net      a pull-up/pull-down resistor's rail pin moved to another existing rail net
 * The pick within each rule is a hash of (board name, task), so the suite is stable for a board and differs between boards.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseBoard, type Board, type Footprint, type Pad } from "../board";
import { pyRound } from "../accept";

export const RAIL = /(^|::|_)(\+?\d+V\d*|\d+V\d+|3V3|1V8|1V1|2V5|5V0|VCC|VDD\w*|VBUS\w*|VSYS|V\d\w*)$/i;
export const GND = /GND/i;

/** The toolkit's `pick`: the sorted candidates indexed by sha256("name:salt") mod their count. */
export function pick(seq: readonly string[], name: string, salt: string): string | null {
  const s = [...seq].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!s.length) return null;
  const k = BigInt(`0x${createHash("sha256").update(`${name}:${salt}`).digest("hex")}`) % BigInt(s.length);
  return s[Number(k)]!;
}

interface AcceptanceLike {
  net_classes?: { classes?: Record<string, { pairs?: string[][]; nets?: string[] }> };
  stack_policy?: { ground_net?: string };
}

export interface EditTaskInput {
  name: string;
  board: Board;
  acceptance: AcceptanceLike;
  /** Regex source (the spec's `fixed`): parts the suite never touches. */
  fixed?: string | null;
  /** Fields every plan carries first (board, project, spec, authority in the toolkit). */
  base?: Record<string, unknown>;
}

export type EditTask = Record<string, unknown>;

const DISPLACE = () => ({ radius: 6, clearance: 0.2, rotations: "keep" });
const setsMeet = (a: Iterable<string>, b: ReadonlySet<string>) => [...a].some((x) => b.has(x));

/** The suite's plans for one board, keyed remove | value | move | swap | add | net (a task whose rule finds nothing is left out). */
export function editTasks(i: EditTaskInput): Record<string, EditTask> {
  const { name, board, acceptance: acc } = i;
  const fps = board.footprints;
  const classes = acc.net_classes?.classes ?? {};
  const pairNets = new Set(Object.values(classes).flatMap((c) => (c.pairs ?? []).flat()));
  const fixed = new RegExp(i.fixed || "^$");
  const byNet = new Map<string, Pad[]>();
  for (const p of board.pads) (byNet.get(p.net) ?? byNet.set(p.net, []).get(p.net)!).push(p);
  const nOn = (n: string) => byNet.get(n)?.length ?? 0;
  const vals = (f: Footprint) => Object.values(f.pins);
  const two = new Map([...fps].filter(([r, f]) => Object.keys(f.pins).length === 2 && !fixed.test(r) && vals(f).every((n) => n)));
  const caps = new Map([...two].filter(([r]) => /(^|_)C\d+$/.test(r)));
  const res = new Map([...two].filter(([r]) => /(^|_)R\d+$/.test(r)));
  const decaps = [...caps].filter(([, f]) => vals(f).some((n) => GND.test(n)) && vals(f).every((n) => nOn(n) >= 3) && !setsMeet(vals(f), pairNets)).map(([r]) => r);
  const base = i.base ?? {};
  const tasks: Record<string, EditTask> = {};

  let r = pick(decaps, name, "remove");
  if (r) tasks["remove"] = { ...base, id: `bench-${name}-remove`, reason: `benchmark: remove decoupling cap ${r}`, remove: [r] };

  r = pick([...res.keys()].filter((x) => !setsMeet(vals(res.get(x)!), pairNets)), name, "value");
  if (r) tasks["value"] = { ...base, id: `bench-${name}-value`, reason: `benchmark: change ${r} value`, swap: [{ ref: r, value: `${fps.get(r)!.value || "R"}-B`, fields: {} }] };

  const lone = (n: string) => !GND.test(n) && nOn(n) === 2;
  const movable = [...two.keys()].filter((x) => !setsMeet(vals(two.get(x)!), pairNets) && vals(two.get(x)!).some(lone));
  r = pick(movable, name, "move");
  if (r) {
    const sig = vals(fps.get(r)!).find(lone)!;
    const other = byNet.get(sig)!.find((p) => p.ref !== r)!.ref;
    tasks["move"] = {
      ...base,
      id: `bench-${name}-move`,
      reason: `benchmark: re-seat ${r} next to ${other} (other end of ${sig})`,
      move: [{ ref: r, near: other, radius: 8, basis: "benchmark: shorten its signal net" }],
      displace: DISPLACE(),
    };
  }

  // swap: capacitor footprints in the board with a different pad spacing
  const span = (f: string): number | null => {
    const ps = board.pads.filter((p) => p.ref === f);
    return ps.length === 2 ? pyRound(Math.abs(ps[0]!.x - ps[1]!.x) + Math.abs(ps[0]!.y - ps[1]!.y), 2) : null;
  };
  const libs = new Map<number | null, string>();
  for (const c of caps.keys()) {
    const s = span(c);
    if (!libs.has(s)) libs.set(s, c);
  }
  r = pick(decaps.filter((c) => span(c) !== null), name, "swap");
  if (r) {
    const sr = span(r)!;
    const order = [...libs.keys()].map((s, k) => ({ s, k })).sort((a, b) => Math.abs((a.s || 0) - sr) - Math.abs((b.s || 0) - sr) || a.k - b.k);
    const hit = order.find(({ s }) => s && Math.abs(s - sr) > 0.2);
    const alt = hit ? libs.get(hit.s)! : null;
    if (alt)
      tasks["swap"] = {
        ...base,
        id: `bench-${name}-swap`,
        reason: `benchmark: ${r} onto ${fps.get(alt)!.lib} (footprint of ${alt})`,
        swap: [{ ref: r, footprint: fps.get(alt)!.lib, height_mm: 1.0, height_basis: "benchmark placeholder" }],
        displace: DISPLACE(),
      };
  }

  // add: decoupling cap on an IC supply pin, copying an existing cap symbol
  const ics = [...fps.keys()].filter((x) => /(^|_)(U|IC)\d+$/.test(x) && !fixed.test(x));
  const cand: string[] = [];
  for (const u of ics) for (const n of vals(fps.get(u)!)) if (n && RAIL.test(n) && !GND.test(n) && nOn(n) >= 2) cand.push(`${u}|${n}`);
  const c = pick(cand, name, "add");
  const gnd = acc.stack_policy?.ground_net || [...byNet.keys()].find((n) => GND.test(n)) || "GND";
  const like = pick(decaps, name, "like");
  if (c && like) {
    const [u, n] = c.split("|") as [string, string];
    const lf = fps.get(like)!;
    const g = vals(lf).find((x) => GND.test(x)) ?? gnd;
    const pinG = Object.keys(lf.pins).find((p) => lf.pins[p] === g)!;
    const pinS = Object.keys(lf.pins).find((p) => p !== pinG)!;
    const cut = like.lastIndexOf("C");
    tasks["add"] = {
      ...base,
      id: `bench-${name}-add`,
      reason: `benchmark: add a decoupling cap on ${u} ${n}`,
      add: [{ ref: `${cut >= 0 ? like.slice(0, cut) : like}C9${String(fps.size % 100).padStart(2, "0")}`, like, value: lf.value, footprint: lf.lib, pins: { [pinS]: n, [pinG]: g }, near: u, height_mm: 1.0, height_basis: "benchmark placeholder", fields: {} }],
      displace: DISPLACE(),
    };
  }

  // net: a resistor with one rail pin moves that pin to another rail
  const rails = [...new Set([...byNet.keys()].filter((n) => RAIL.test(n) && !GND.test(n) && nOn(n) >= 3))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pulls = [...res.keys()].filter((x) => vals(res.get(x)!).filter((n) => RAIL.test(n)).length === 1 && !setsMeet(vals(res.get(x)!), pairNets));
  r = pick(pulls, name, "net");
  if (r && rails.length >= 2) {
    const f = fps.get(r)!;
    const [pd, n] = Object.entries(f.pins).find(([, x]) => RAIL.test(x))!;
    const to = pick(rails.filter((x) => x !== n), name, "netto")!;
    const nc: Record<string, unknown> = { pin: `${r}.${pd}`, to };
    const pwr = new Set(Object.entries(classes).filter(([k]) => k.startsWith("PWR")).flatMap(([, cl]) => cl.nets ?? []));
    if (pwr.has(to)) Object.assign(nc, { tap_width: 0.15, tap_basis: "pull-up/down resistor pad: < 1 mA; 0.15 mm carries ~0.6 A (IPC-2221 ext.)" });
    tasks["net"] = { ...base, id: `bench-${name}-net`, reason: `benchmark: ${r}.${pd} from ${n} to ${to}`, net: [nc] };
  }
  return tasks;
}

export interface EditTaskFiles {
  /** Board name (used in ids and the hash). */
  name: string;
  /** Folder holding `<stem>.kicad_pcb`. */
  src: string;
  stem: string;
  /** Folder holding acceptance.json (the project's `.fabdesk/board/requirements`). */
  requirements: string;
  fixed?: string | null;
  /** The spec file the plans name (the toolkit's flow spec); recorded as given. */
  spec?: string;
  /** Plans name the board relative to this root when it lies inside (the toolkit's PROJECT), else absolute. */
  root?: string;
  out: string;
}

/** `editbench tasks`: write the suite's plans (`<task>.json`) into `out`; returns them. */
export async function writeEditTasks(o: EditTaskFiles): Promise<Record<string, EditTask>> {
  const board = parseBoard(await readFile(join(o.src, `${o.stem}.kicad_pcb`), "utf8"));
  const acceptance = JSON.parse(await readFile(join(o.requirements, "acceptance.json"), "utf8")) as AcceptanceLike;
  const src = resolve(o.src);
  const rel = o.root && !relative(resolve(o.root), src).startsWith("..") && !isAbsolute(relative(resolve(o.root), src)) ? relative(resolve(o.root), src) || "." : src;
  const base = { board: rel, project: rel, ...(o.spec ? { spec: resolve(o.spec) } : {}), authority: "edit benchmark (eco95): synthetic task, never adopted" };
  const tasks = editTasks({ name: o.name, board, acceptance, fixed: o.fixed ?? null, base });
  await mkdir(o.out, { recursive: true });
  for (const [k, t] of Object.entries(tasks)) await writeFile(join(o.out, `${k}.json`), JSON.stringify(t, null, 1) + "\n");
  return tasks;
}

/** One `result.json` of an edit bench run (editbench run / runEdit mode full, as the harness records it). */
export interface EditBenchResult {
  id: string;
  tool_version?: string;
  started?: string;
  verdict?: string;
  total_s?: number;
  phases?: Record<string, number>;
  agent_coordinates?: number;
  churn?: { collateral_nets?: unknown; collateral_mm?: unknown; unplanned_moved?: unknown[]; error?: string };
  final_detail?: unknown;
}

async function walk(dir: string, name: string, out: string[]): Promise<void> {
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, name, out);
    else if (e.name === name) out.push(p);
  }
}

/** Every result.json under the folders, sorted per folder by path (Python `sorted(rglob)`). */
export async function readEditResults(dirs: readonly string[]): Promise<EditBenchResult[]> {
  const rows: EditBenchResult[] = [];
  for (const d of dirs) {
    const files: string[] = [];
    await walk(d, "result.json", files);
    // Python sorts the paths part by part ("a/x" before "a-b/x"), not as strings
    const parts = (p: string) => p.split("/");
    const byParts = (x: string, y: string) => {
      const [a, b] = [parts(x), parts(y)];
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
      return a.length - b.length;
    };
    for (const f of files.sort(byParts)) rows.push(parsePyJson(await readFile(f, "utf8")) as EditBenchResult);
  }
  return rows;
}

/** Fields written as Python floats (`75.0` in the file): JSON.parse makes them 75, the table prints them as Python does. */
const FLOATS = new WeakMap<object, Set<string>>();

/** JSON.parse that remembers which integral numbers were floats in the text (per holder object and key). */
export function parsePyJson(text: string): unknown {
  return JSON.parse(text, function (this: object, k: string, v: unknown, ctx?: { source?: string }) {
    if (typeof v === "number" && Number.isInteger(v) && ctx?.source && /[.eE]/.test(ctx.source)) (FLOATS.get(this) ?? FLOATS.set(this, new Set()).get(this)!).add(k);
    return v;
  } as (k: string, v: unknown) => unknown);
}

/** Python `str()` of field `k` of `o` (a float keeps its `.0`). */
const pyField = (o: object, k: string): string => {
  const v = (o as Record<string, unknown>)[k];
  return typeof v === "number" && Number.isInteger(v) && FLOATS.get(o)?.has(k) ? v.toFixed(1) : pyStr(v);
};

/** Python `str()` of a JSON value as the toolkit's table prints it. */
export function pyStr(v: unknown): string {
  if (v === undefined || v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return pyRepr(v);
}
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
}

/** `editbench table`: the markdown table, and the JSON rows the toolkit writes beside `--md`. */
export function editTable(rows: readonly EditBenchResult[]): { md: string; json: Array<Record<string, unknown>> } {
  const lines = ["| board-task | tool | run | verdict | wall s | collateral nets / mm | unplanned moved | coords |", "|---|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    const ch = r.churn ?? {};
    lines.push(
      `| ${r.id.replaceAll("bench-", "")} | ${pyStr(r.tool_version)} | ${(r.started ?? "").slice(11, 16)} | ${pyStr(r.verdict)} | ` +
        `${pyField(r, "total_s")} | ${"collateral_nets" in ch ? pyField(ch, "collateral_nets") : "-"} / ${"collateral_mm" in ch ? pyField(ch, "collateral_mm") : "-"} | ` +
        `${"unplanned_moved" in ch ? (ch.unplanned_moved ?? []).length : "-"} | ${pyField(r, "agent_coordinates")} |`,
    );
  }
  const json = rows.map((r) => {
    const parts = r.id.split("-");
    const ch = r.churn ?? {};
    return {
      board: parts[1],
      task: parts[parts.length - 1],
      tool: r.tool_version ?? null,
      started: r.started ?? null,
      pass: String(r.verdict ?? "").startsWith("PASS"),
      verdict: r.verdict ?? null,
      wall_s: r.total_s ?? null,
      phases: r.phases ?? null,
      collateral_nets: ch.collateral_nets ?? null,
      collateral_mm: ch.collateral_mm ?? null,
      unplanned_moved: (ch.unplanned_moved ?? []).length,
      coords: r.agent_coordinates ?? null,
      final: r.final_detail ?? null,
    };
  });
  return { md: lines.join("\n"), json };
}
