/**
 * board_review's looking-and-fit actions, kept apart from the review record (none of them reads or changes it):
 *
 * - `cable`: cable reach between boards' connectors in a chassis (the toolkit's `pcb cable` / `flow/cablepath.py`).
 *   A review of fit across boards rather than a check of one board, so it is an action of the reviewer, beside the
 *   one-board mouth check (L4) whose rule it shares. Seconds, no KiCad.
 * - `page`: one interactive HTML page comparing boards from KiCad's own plots (`tools/board_page.py`).
 * - `diff`: the change picture between two versions of a board (`pcb diff` / `review/diff.py`); the same picture the
 *   review's READY candidates get as change.html.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { boardHome, boardPage, cable, changePage, changeSummary, changeSvgStandalone, confineToProject, diffBoards, isInside, locateProject } from "@fabdesk/board-workflow";
import { runKicadCli } from "@fabdesk/kicad";
import { ToolError, type ToolContext, type ToolOutput } from "../registry";
import { boardMemGiB, governor } from "../resources";
import { ok, requireKicad, runLiveDrc } from "./common";

const reviewDir = (dir: string) => join(boardHome(dir), "review");

async function inProject(dir: string, p: string, what: string): Promise<string> {
  try {
    return await confineToProject(dir, p, what);
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e), "invalid_args");
  }
}

/** A file to write, inside the project (it need not exist yet). */
function outPath(dir: string, p: string): string {
  const f = resolve(dir, p);
  if (!isInside(resolve(dir), f)) throw new ToolError(`out ${p} is outside the project`, "invalid_args");
  if (!f.endsWith(".html")) throw new ToolError("out must be an .html file", "invalid_args");
  return f;
}

async function projectBoard(dir: string, pcb: string | undefined): Promise<string> {
  try {
    return (await locateProject(dir, pcb)).pcb;
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
  }
}

export interface CableInput {
  chassis?: string | undefined;
  root?: string | undefined;
  frame?: string | undefined;
  boards?: Record<string, string> | undefined;
  sweep?: string | undefined;
  edge?: cable.Edge | undefined;
  step?: number | undefined;
  frames?: string[] | undefined;
}

/** `cable`: every cable in every frame (or one), or the sweep of one connector along an edge. */
export async function cableAction(dir: string, input: CableInput): Promise<ToolOutput> {
  if (!input.chassis) throw new ToolError("cable needs chassis (the chassis JSON file, relative to the project)", "invalid_args");
  const file = await inProject(dir, input.chassis, "chassis file");
  let ch: cable.Chassis;
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    cable.validateChassis(raw);
    ch = raw;
  } catch (e) {
    throw new ToolError(`cannot read the chassis ${input.chassis}: ${e instanceof Error ? e.message : String(e)}`, "invalid_args");
  }
  // board paths in the chassis resolve against root (default the project): the other boards of a multi-board product
  // usually live beside it, so they may sit outside the project; only board files are read
  const root = input.root ? resolve(dir, input.root) : dir;
  for (const p of [...cable.chassisBoardFiles(ch), ...Object.values(input.boards ?? {})])
    if (!p.endsWith(".kicad_pcb")) throw new ToolError(`chassis board ${p} is not a .kicad_pcb file`, "invalid_args");
  const boards = new cable.CableBoards(root);
  const rec = (rel: string) => (isAbsolute(rel) ? rel : relative(dir, resolve(root, rel)) || ".");
  try {
    if (input.sweep) {
      const [bn, ref] = input.sweep.split(":");
      if (!bn || !ref) throw new ToolError("sweep is BOARD:REF (a board name of the chassis and a connector reference)", "invalid_args");
      const rows = await cable.sweepCable(boards, ch, bn, ref, input.edge ?? "right", { ...(input.step ? { step: input.step } : {}), ...(input.frames?.length ? { frames: input.frames } : {}) });
      const out = join(reviewDir(dir), "cable-sweep.json");
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify({ chassis: input.chassis, board: bn, ref, edge: input.edge ?? "right", rows }, null, 1) + "\n");
      const keys = rows[0] ? Object.keys(rows[0].slack) : [];
      const best = keys.map((k) => {
        const r = rows.reduce((p, q) => (q.slack[k]! > p.slack[k]! ? q : p));
        return `${k}: best slack ${r.slack[k]} mm at ${r.pos} (pose ${r.pose.join(", ")})`;
      });
      return ok([...cable.sweepLines(rows), "", ...best, "", `prove a chosen pose with board_edit (move ${ref} to it); the sweep does not check the courtyard against parts`, `Record: ${out}`].join("\n"), { rows, record: out });
    }
    const r = await cable.runCables(boards, ch, { ...(input.frame ? { frame: input.frame } : {}), ...(input.boards ? { pcb: input.boards } : {}) });
    const out = join(reviewDir(dir), "cable.json");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify({ chassis: input.chassis, boards: Object.fromEntries(cable.chassisBoardFiles(ch).map((p) => [p, rec(p)])), results: r.results }, null, 1) + "\n");
    const n = Object.values(r.results).reduce((s, x) => s + x.length, 0);
    return ok([...r.lines, "", `${n} cable checks, ${r.failed} FAIL. A PASS is geometric reach in the stated frame (shortest orthogonal path), not installed fit.`, `Record: ${out}`].join("\n"), { results: r.results, failed: r.failed, record: out });
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
  }
}

export interface PageInput {
  compare?: string[] | undefined;
  pcb?: string | undefined;
  title?: string | undefined;
  render3d: boolean;
  drc: boolean;
  out?: string | undefined;
}

/** `page`: plot each board (LABEL=PATH, project-relative files or folders; default the project's board) into one HTML page. */
export async function pageAction(ctx: ToolContext, dir: string, input: PageInput): Promise<ToolOutput> {
  const specs = input.compare?.length ? input.compare : [`board=${relative(dir, await projectBoard(dir, input.pcb))}`];
  const entries: Array<{ label: string; path: string }> = [];
  for (const s of specs) {
    const i = s.indexOf("=");
    const [label, p] = i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s.replace(/\/$/, "").split("/").pop()!.replace(/\.kicad_pcb$/, ""), s];
    entries.push({ label, path: await inProject(dir, p, "board") });
  }
  const out = input.out ? outPath(dir, input.out) : join(reviewDir(dir), "board-page.html");
  const cli = await requireKicad(ctx);
  const files = await Promise.all(entries.map((e) => boardPage.pageBoardFile(e.path)));
  const job = await governor().admit({ cls: "light", label: "board_review page", paths: [dir], signal: ctx.signal, memGiB: await boardMemGiB(files), onWait: (why) => ctx.progress(0, why) });
  try {
    const kicad = (args: string[]) => runKicadCli(cli, args, { tolerateExit: true, signal: ctx.signal });
    const boards: boardPage.PageBoard[] = [];
    const notes: string[] = [];
    for (const [i, e] of entries.entries()) {
      let drcFile: string | undefined;
      if (input.drc) {
        drcFile = join(reviewDir(dir), "page", `${e.label.replace(/[^\w.-]+/g, "_")}.drc.json`);
        await mkdir(dirname(drcFile), { recursive: true });
        await runLiveDrc(ctx, cli, { board: files[i]!, outFile: drcFile, parity: false, refill: false, signal: ctx.signal });
      }
      const b = await boardPage.boardPageData(e.label, e.path, { kicad, no3d: !input.render3d, ...(drcFile ? { drc: drcFile } : {}), signal: ctx.signal, progress: (n) => ctx.progress(Math.min(0.95, (i + 0.5) / entries.length), `${e.label}: ${n}`) });
      notes.push(...b.notes.map((n) => `${e.label}: ${n}`));
      boards.push({ ...b, path: relative(dir, b.path) || "." });
    }
    const html = boardPage.boardPageHtml(boards, input.title ?? "Board Viewer");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, html);
    const lines = [
      ...boards.map((b) => `${b.label}: ${b.layers.length} layers, ${b.opens.length} open, ${b.viol.length} DRC errors${Object.keys(b.r3).length ? ", 3D top/bottom" : ""}`),
      ...notes,
      `Page: ${out} (${(html.length / 1e6).toFixed(2)} MB)`,
    ];
    return ok(lines.join("\n"), { page: out, boards: boards.map((b) => ({ label: b.label, path: b.path, layers: b.layers.map((l) => l.n), opens: b.opens.length, drcErrors: b.viol.length, render3d: Object.keys(b.r3) })), notes });
  } finally {
    job.release();
  }
}

export interface DiffInput {
  old?: string | undefined;
  new?: string | undefined;
  pcb?: string | undefined;
  layers?: string[] | undefined;
  out?: string | undefined;
}

/** `diff`: the change picture OLD -> NEW (default NEW: the project's board), page + standalone SVG. */
export async function diffAction(dir: string, input: DiffInput): Promise<ToolOutput> {
  if (!input.old) throw new ToolError("diff needs old (the earlier board file or folder, relative to the project)", "invalid_args");
  const oldP = await inProject(dir, input.old, "old board");
  const newP = input.new ? await inProject(dir, input.new, "new board") : await projectBoard(dir, input.pcb);
  const out = input.out ? outPath(dir, input.out) : join(reviewDir(dir), "change.html");
  let d;
  try {
    d = await diffBoards(oldP, newP);
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e), "invalid_args");
  }
  // name the versions as the project knows them, not by absolute path
  d = { ...d, old: relative(dir, oldP) || ".", new: relative(dir, newP) || "." };
  const lay = input.layers?.length ? new Set(input.layers) : undefined;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, changePage(d, lay));
  const svg = out.replace(/\.html$/, ".svg");
  await writeFile(svg, changeSvgStandalone(d, lay));
  const moved = d.moved.slice(0, 12).map((m) => `${m.ref} ${m.mm} mm`);
  return ok([`${changeSummary(d)} -> ${out}`, ...(moved.length ? [`moved: ${moved.join(", ")}${d.moved.length > 12 ? ", ..." : ""}`] : []), `SVG: ${svg}`].join("\n"), {
    page: out,
    svg,
    summary: changeSummary(d),
    tracksAdded: d.seg_add.length,
    tracksRemoved: d.seg_del.length,
    viasAdded: d.via_add.length,
    viasRemoved: d.via_del.length,
    moved: d.moved.map((m) => ({ ref: m.ref, mm: m.mm })),
    added: d.added,
    removed: d.removed,
  });
}
