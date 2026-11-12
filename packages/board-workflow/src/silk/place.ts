/**
 * silk place / show: a candidate copy of the project with every label placed by the solver, and pictures of silk over
 * copper and mask openings. Only Reference properties (and, with `texts: move`, the free silk texts that name a part)
 * of the board change; the rest of the board is byte-identical, and that is checked.
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { rasterizeSvg, runKicadCli, type KicadCli } from "@fabdesk/kicad";
import { parseSexpr } from "../sexpr";
import { boardEdge } from "../release/gerbcheck";
import { cleanLabels, judge, matches, planOf, solve, textTarget, type Plan, type Placed, type SolveResult, type Verdict } from "./engine";
import { buildSilkModel, type SilkModel } from "./model";
import { toBoard } from "./shapes";
import { masked, refPropertySpan, rewriteProperty, rewriteText, textSpan, children } from "./textedit";

type Frame =
  | { text_uuid?: undefined; at: [number, number, number]; layer: string; height: number; mirror: boolean; want: [number, number, number, number] }
  | { text_uuid: string; at: [number, number, number]; height: number; stroke: number; want: [number, number, number, number] };

/** A field's position relative to the footprint and its angle, as KiCad stores them (inverse of the footprint transform). */
export function localFrames(m: SilkModel, placed: Record<string, Placed>, plan: Plan): Record<string, Frame> {
  const out: Record<string, Frame> = {};
  for (const [ref, [, rect, ang, hgt]] of Object.entries(placed)) {
    const cx = (rect[0] + rect[2]) / 2;
    const cy = (rect[1] + rect[3]) / 2;
    const rx = Math.round(cx * 1e6) / 1e6;
    const ry = Math.round(cy * 1e6) / 1e6;
    const x = m.extra[ref];
    if (x) {
      out[ref] = { text_uuid: x.uuid, at: [rx, ry, ang], height: hgt, stroke: x.stroke, want: rect };
      continue;
    }
    const p = m.parts[ref]!;
    const a = p.rot * (Math.PI / 180);
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dx = rx - p.x;
    const dy = ry - p.y;
    // inverse of (x c + y s, -x s + y c)
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    out[ref] = { at: [lx, ly, ang], layer: p.side === "B" ? "B.SilkS" : "F.SilkS", height: hgt, mirror: p.side === "B", want: rect };
  }
  void plan;
  void toBoard;
  return out;
}

export function writeBoard(text: string, frames: Record<string, Frame>, hide: string[], plan: Plan): { text: string; edits: number } {
  const edits: Array<[number, number, string]> = [];
  for (const [ref, fr] of Object.entries(frames)) {
    if (fr.text_uuid) {
      const [a, b] = textSpan(text, fr.text_uuid);
      edits.push([a, b, rewriteText(text.slice(a, b), fr.at, fr.height, fr.stroke)]);
      continue;
    }
    const [a, b] = refPropertySpan(text, ref);
    edits.push([a, b, rewriteProperty(text.slice(a, b), fr.at, (fr as Extract<Frame, { layer: string }>).layer, false, fr.height, plan.stroke, (fr as Extract<Frame, { mirror: boolean }>).mirror)]);
  }
  for (const ref of hide) {
    const [a, b] = refPropertySpan(text, ref);
    const blk = text.slice(a, b);
    if (blk.includes("(hide yes)")) continue;
    const kids = children(blk);
    const la = kids.find(([s]) => blk.startsWith("(layer", s))!;
    const ind = /\n([ \t]*)\(/.exec(blk)?.[1] ?? "\t\t\t";
    edits.push([a, b, blk.slice(0, la[1]) + `\n${ind}(hide yes)` + blk.slice(la[1])]);
  }
  let t = text;
  for (const [a, b, nb] of [...edits].sort((x, y) => y[0] - x[0])) t = t.slice(0, a) + nb + t.slice(b);
  return { text: t, edits: edits.length };
}

export interface SilkPlaceResult {
  source: string;
  board: string;
  plan: Plan;
  edits: number;
  only_labels_changed: boolean;
  mode: string;
  kept: number;
  placed: number;
  wanted: number;
  fit_nowhere: string[];
  why: SolveResult["why"];
  hidden_existing: string[];
  solver_vs_model_mm: number;
  written_vs_solver_mm: number;
  before: Pick<Verdict, "labels" | "clean" | "bad" | "counts">;
  after: Pick<Verdict, "labels" | "clean" | "bad" | "counts">;
  after_rows: Verdict["rows"];
  texts_moved: number;
  texts_before: Pick<Verdict, "texts" | "texts_bad" | "text_counts">;
  texts_after: Pick<Verdict, "texts" | "texts_bad" | "text_counts">;
  text_rows_after: Verdict["text_rows"];
  pictures?: string[];
}

export interface SilkPlaceOptions {
  /** The board file (inside the project folder; the whole folder is copied). */
  pcb: string;
  /** Candidate folder: must be absent or empty. */
  out: string;
  plan?: Partial<Plan> | string | null;
  cli: KicadCli;
  pictures?: boolean;
  signal?: AbortSignal;
  log?: (s: string) => void;
}

export async function silkPlace(o: SilkPlaceOptions): Promise<SilkPlaceResult> {
  const plan = planOf(o.plan);
  const src = o.pcb;
  if (await readdir(o.out).then((l) => l.length > 0, () => false)) throw new Error(`${o.out} exists and is not empty`);
  await mkdir(o.out, { recursive: true });
  // the candidate carries the design (board, project settings, schematic sheets, libraries), not exports or work folders
  for (const n of await readdir(dirname(src))) {
    if (/\.(kicad_pcb|kicad_pro|kicad_prl|kicad_dru|kicad_sch|kicad_sym)$|^(fp|sym)-lib-table$/.test(n) && !n.startsWith("_autosave") && !n.startsWith("~")) await cp(join(dirname(src), n), join(o.out, n));
    else if (n.endsWith(".pretty")) await cp(join(dirname(src), n), join(o.out, n), { recursive: true });
  }
  const dst = join(o.out, basename(src));
  const text = await readFile(src, "utf8");
  const work = join(o.out, ".silk-work");
  const m = await buildSilkModel(text, { cli: o.cli, workDir: join(work, "before"), ...(o.signal ? { signal: o.signal } : {}) });
  const before = judge(m, plan);
  let fixed = plan.mode === "fix" ? cleanLabels(m, plan, before) : {};
  if (plan.texts === "move") {
    const named = new Set(m.texts.map((tx) => textTarget(tx, m)).filter((x): x is string => !!x));
    fixed = Object.fromEntries(Object.entries(fixed).filter(([r]) => !named.has(r)));
  }
  const { placed, why, todo } = solve(m, plan, fixed, o.log);
  const frames = localFrames(m, placed, plan);
  const hide = Object.entries(m.parts).filter(([r, p]) => !(r in placed) && !(r in fixed) && p.label.visible && p.label.on_silk).map(([r]) => r);
  const { text: out, edits } = writeBoard(text, frames, hide, plan);
  await writeFile(dst, out);
  const tu = Object.values(frames).flatMap((f) => (f.text_uuid ? [f.text_uuid] : []));
  const same = masked(text, tu) === masked(out, tu);
  if (!same) throw new Error("something other than Reference properties changed");
  const m2 = await buildSilkModel(out, { cli: o.cli, workDir: join(work, "after"), ...(o.signal ? { signal: o.signal } : {}) });
  const after = judge(m2, plan);
  let moved = 0;
  const tbox = new Map(m2.texts.map((x) => [x.uuid, x.box]));
  for (const [ref, fr] of Object.entries(frames)) {
    const got = fr.text_uuid ? tbox.get(fr.text_uuid)! : m2.parts[ref]!.label.box;
    for (let i = 0; i < 4; i++) moved = Math.max(moved, Math.abs(got[i]! - fr.want[i]!));
  }
  const res: SilkPlaceResult = {
    source: src,
    board: dst,
    plan,
    edits,
    only_labels_changed: same,
    mode: plan.mode,
    kept: Object.keys(fixed).length,
    placed: Object.keys(placed).length,
    wanted: todo.length + Object.keys(fixed).length,
    fit_nowhere: Object.keys(why).sort(),
    why,
    hidden_existing: [...hide].sort(),
    solver_vs_model_mm: 0,
    written_vs_solver_mm: Math.round(moved * 1e4) / 1e4,
    before: { labels: before.labels, clean: before.clean, bad: before.bad, counts: before.counts },
    after: { labels: after.labels, clean: after.clean, bad: after.bad, counts: after.counts },
    after_rows: after.rows,
    texts_moved: tu.length,
    texts_before: { texts: before.texts, texts_bad: before.texts_bad, text_counts: before.text_counts },
    texts_after: { texts: after.texts, texts_bad: after.texts_bad, text_counts: after.text_counts },
    text_rows_after: after.text_rows,
  };
  if (o.pictures !== false) {
    await mkdir(join(o.out, "silk-pictures"), { recursive: true });
    res.pictures = [...(await showSilk(o.cli, src, join(o.out, "silk-pictures", "before"), ["F", "B"], 400, 1, o.signal)), ...(await showSilk(o.cli, dst, join(o.out, "silk-pictures", "after"), ["F", "B"], 400, 1, o.signal))];
  }
  await writeFile(join(o.out, "silk.json"), JSON.stringify(res, null, 1) + "\n");
  // the candidate keeps the project as it was computed from (adopt compares design files against it)
  void stat;
  const { rm } = await import("node:fs/promises");
  await rm(work, { recursive: true, force: true });
  return res;
}

/** The solver-only dry run: where labels would go and what blocks the rest. */
export async function silkDryRun(pcb: string, plan: Plan, cli: KicadCli, workDir: string, signal?: AbortSignal) {
  const m = await buildSilkModel(await readFile(pcb, "utf8"), { cli, workDir, ...(signal ? { signal } : {}) });
  const r = solve(m, plan);
  const tot: Record<string, number> = {};
  for (const v of Object.values(r.why)) for (const [k, n] of Object.entries(v.blocked_by_of_60_best)) tot[k] = (tot[k] ?? 0) + n;
  return { label: plan.label ?? "ref", placed: Object.keys(r.placed).length, wanted: r.todo.length, fit_nowhere: Object.keys(r.why).length, why: r.why, blockers: tot };
}

/**
 * PNG of silk over copper and mask, cropped to the board outline (+margin mm) at a fixed scale: two versions of the same
 * board give pictures of identical size that overlay exactly. B is mirrored (seen from below).
 */
export async function showSilk(cli: KicadCli, pcb: string, outPrefix: string, sides: Array<"F" | "B">, dpi = 400, margin = 1.0, signal?: AbortSignal): Promise<string[]> {
  const box = boardEdge(parseSexpr(await readFile(pcb, "utf8")));
  if (!box) throw new Error(`${pcb}: no Edge.Cuts outline`);
  const outs: string[] = [];
  await mkdir(dirname(outPrefix), { recursive: true });
  for (const s of sides) {
    const svgPath = `${outPrefix}-${s}.svg`;
    const args = ["pcb", "export", "svg", ...(s === "B" ? ["--mirror"] : []), "--mode-single", "--exclude-drawing-sheet", "--layers", `${s}.Cu,${s}.Mask,${s}.Silkscreen,Edge.Cuts`, "-o", svgPath, pcb];
    await runKicadCli(cli, args, { tolerateExit: true, ...(signal ? { signal } : {}) });
    let body = await readFile(svgPath, "utf8");
    const vb = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(body);
    if (!vb) throw new Error("kicad-cli wrote no SVG viewBox");
    const [vx, W] = [Number(vb[1]), Number(vb[3])];
    const [a0, a1] = s === "B" ? [vx + W - box.x1, vx + W - box.x0] : [box.x0, box.x1]; // --mirror maps x -> -x (viewBox from -W)
    const w = a1 - a0 + 2 * margin;
    const h = box.y1 - box.y0 + 2 * margin;
    body = body.replace(/width="[^"]*" height="[^"]*" viewBox="[^"]*"/, `width="${w.toFixed(4)}mm" height="${h.toFixed(4)}mm" viewBox="${(a0 - margin).toFixed(4)} ${(box.y0 - margin).toFixed(4)} ${w.toFixed(4)} ${h.toFixed(4)}"`);
    const png = await rasterizeSvg(body, { maxWidth: Math.round((w * dpi) / 25.4), background: "#0b2a17" });
    const pngPath = `${outPrefix}-${s}.png`;
    await writeFile(pngPath, png.png);
    const { rm } = await import("node:fs/promises");
    await rm(svgPath, { force: true });
    outs.push(pngPath);
  }
  return outs;
}

export { matches };
