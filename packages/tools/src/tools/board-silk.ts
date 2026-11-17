/**
 * board_silk: reference labels on the silkscreen. check judges every label (over copper, silk or another label, under a
 * part body, near the edge, too small, ambiguous, far, unlabelled) and every free text (detached); place computes a
 * candidate board with every label placed by the solver and proves only labels changed (and can adopt it); show draws
 * silk over copper and mask openings.
 *
 * Pad mask openings and silk strokes come from KiCad's own Gerber plot; labels, courtyards and outlines from the board
 * file (see `@fabdesk/board-workflow` silk/model.ts for where each shape comes from and what is approximate).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod/v4";
import { locateProject, silk } from "@fabdesk/board-workflow";
import { adoptCandidate, designFileHashes } from "../board-adopt";
import { runDurable } from "../durable";
import { releaseHome } from "../release-state";
import { boardMemGiB, governor } from "../resources";
import { defineTool, type ToolContext, type ToolOutput } from "../registry";
import { ok, requireKicad } from "./common";

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "$1Z"); // milliseconds: two runs in one second must not share a folder
const silkHome = (dir: string) => join(releaseHome(dir), "..", "silk");

const Input = {
  action: z.enum(["check", "place", "show"]).describe("check: judge every label and free text. place: candidate board with labels placed (optionally adopted). show: pictures of silk over copper and mask openings."),
  pcb: z.string().optional().describe("Board file, relative to the project; default board.kicad_pcb or the project's only .kicad_pcb."),
  plan: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Your rules, all optional: {"heights":[1.0,0.8], "stroke":0.16, "min_height":0.8, "min_stroke":0.15, "clear":{"copper":0.15,"silk":0.12,"label":0.15,"edge":0.3,"body":0.1}, "labels":"all"|"visible", "mode":"fix"|"all", "texts":"keep"|"move", "skip":["FIT_*"], "keep":["U1"], "pin":{"U1":{"at":[x,y],"angle":0,"height":1.0}}, "hide":["TP*"], "inside_ok":["J1"], "max_gap":1.5}. Defaults are JLC-minded (0.15 mm from exposed copper, 0.8 mm text at 0.16 mm stroke).'),
  dryRun: z.boolean().default(false).describe("place: solve and report only; write nothing."),
  adopt: z.boolean().default(false).describe("place: adopt the candidate into the project's board (checkpoint first) when only labels changed."),
  reason: z.string().max(300).default("silk labels placed").describe("place with adopt: the checkpoint's reason."),
  pictures: z.boolean().default(true).describe("place: before/after pictures of both sides."),
  side: z.enum(["F", "B", "both"]).default("both").describe("show: which side."),
  dpi: z.number().int().min(100).max(1200).default(400).describe("show: picture resolution."),
};
type Args = { [K in keyof typeof Input]: z.infer<(typeof Input)[K]> };

async function admit(ctx: ToolContext, label: string, pcb: string) {
  return governor().admit({ cls: "light", label, paths: [pcb], signal: ctx.signal, memGiB: await boardMemGiB([pcb]), onWait: (w) => ctx.progress(0, w) });
}

const counts = (c: Record<string, number>) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

function verdictText(v: silk.Verdict, name: string): string[] {
  const out = [`silk ${name}: ${v.labels} labels on silk (${v.clean} clean, ${v.bad} with problems); ${v.wanted} parts want one`, `  ${counts(v.counts)}`, `free texts: ${v.texts} (${v.texts_bad} with problems) ${counts(v.text_counts)}`];
  for (const r of v.rows.filter((x) => x.issues.some((i) => !["unlabelled"].includes(i.kind))).slice(0, 30)) out.push(`- ${r.ref} ${r.side}: ${r.issues.map((i) => `${i.kind}${i.with.length ? ` (${i.with.join("; ")})` : ""}`).join(", ")}`);
  for (const t of v.text_rows.slice(0, 10)) out.push(`- text '${t.text}' ${t.side}: ${t.issues.map((i) => `${i.kind}${i.with.length ? ` (${i.with.join("; ")})` : ""}`).join(", ")}`);
  return out;
}

async function run(a: Args, ctx: ToolContext): Promise<ToolOutput> {
  const project = ctx.requireProject();
  const files = await locateProject(project.dir, a.pcb);
  const cli = await requireKicad(ctx);
  const plan = silk.planOf(a.plan as Partial<silk.Plan> | undefined);
  const work = join(silkHome(project.dir), `${a.action}-${stamp()}`);
  const job = await admit(ctx, `board_silk ${a.action}`, files.pcb);
  try {
    if (a.action === "check") {
      const m = await silk.buildSilkModel(await readFile(files.pcb, "utf8"), { cli, workDir: work, signal: ctx.signal });
      const v = silk.judge(m, plan);
      await mkdir(work, { recursive: true });
      await writeFile(join(work, "silk-check.json"), JSON.stringify(v, null, 1) + "\n");
      return ok(verdictText(v, files.stem).join("\n"), { labels: v.labels, wanted: v.wanted, clean: v.clean, bad: v.bad, counts: v.counts, texts: v.texts, textsBad: v.texts_bad, textCounts: v.text_counts, rows: v.rows, textRows: v.text_rows, record: relative(project.dir, join(work, "silk-check.json")) });
    }
    if (a.action === "show") {
      const out = await silk.showSilk(cli, files.pcb, join(work, "silk"), a.side === "both" ? ["F", "B"] : [a.side], a.dpi, 1, ctx.signal);
      return ok(`Pictures of silk over copper and mask openings (B seen from below): ${out.map((p) => relative(project.dir, p)).join(", ")}`, { pictures: out.map((p) => relative(project.dir, p)) });
    }
    // place
    if (a.dryRun) {
      const r = await silk.silkDryRun(files.pcb, plan, cli, work, ctx.signal);
      return ok(`dry run: ${r.placed}/${r.wanted} placed; ${r.fit_nowhere} fit nowhere; blockers of those: ${counts(r.blockers)}`, r);
    }
    const out = join(work, "candidate");
    const origin = await designFileHashes(project.dir);
    const r = await silk.silkPlace({ pcb: files.pcb, out, plan, cli, pictures: a.pictures, signal: ctx.signal, log: (s) => ctx.progress(0.5, s) });
    await writeFile(join(out, "origin.json"), JSON.stringify({ project: project.dir, files: origin }) + "\n");
    const text = [
      `${r.mode} mode: ${r.kept} clean labels kept, ${r.placed} placed; before ${r.before.labels} labels (${r.before.bad} with problems), after ${r.after.labels} labels (${r.after.bad} with problems); ${r.fit_nowhere.length} parts fit nowhere; only labels changed: ${r.only_labels_changed}`,
      `after: ${counts(r.after.counts)}; free texts ${r.texts_before.texts_bad} of ${r.texts_before.texts} with problems before, ${r.texts_after.texts_bad} after (${r.texts_moved} moved)`,
      ...r.fit_nowhere.slice(0, 25).map((ref) => `- ${ref}: ${r.why[ref]!.reason}; blockers among the 60 best spots: ${counts(r.why[ref]!.blocked_by_of_60_best)}`),
      ...(r.fit_nowhere.length > 25 ? [`... ${r.fit_nowhere.length - 25} more in silk.json`] : []),
      `Candidate: ${relative(project.dir, r.board)}${r.pictures ? `; pictures ${relative(project.dir, join(out, "silk-pictures"))}` : ""}`,
    ];
    if (a.adopt) {
      if (!r.only_labels_changed || r.after.bad > r.before.bad) {
        text.push(`Not adopted: ${r.only_labels_changed ? "the candidate has more labels with problems than the board" : "something other than labels changed"}.`);
      } else {
        // onto the board this run placed labels on (a named `pcb`, or the project's only board), never a default
        const ad = await adoptCandidate(ctx, { candidate: r.board, board: relative(project.dir, files.pcb), reason: a.reason });
        text.push(ad.text);
      }
    } else text.push("Not adopted; run again with adopt, or adopt the candidate board yourself.");
    return ok(text.join("\n"), { candidate: relative(project.dir, r.board), placed: r.placed, kept: r.kept, wanted: r.wanted, fitNowhere: r.fit_nowhere, why: r.why, before: r.before, after: r.after, onlyLabelsChanged: r.only_labels_changed, hiddenExisting: r.hidden_existing, textsMoved: r.texts_moved });
  } finally {
    job.release();
  }
}

export const board_silk = defineTool({
  name: "board_silk",
  toolset: "board",
  title: "Silkscreen labels: check, place, show",
  description:
    "Reference labels on the silkscreen. check: every label judged (over exposed copper, other silk or another label, under a part body, near the board edge, below JLC's minimum size, nearer another part than its own, far from its part, unlabelled; free texts detached or over silk), with pad mask openings and silk strokes read from KiCad's own plot. place: a candidate board with every label placed by the solver (most-constrained first, 0.8-1.0 mm text, 0.15 mm from copper, outside every part body), labels that already pass kept in fix mode, a label that fits nowhere hidden and listed with what blocks it; proves only Reference properties changed; adopt applies it with a checkpoint. show: silk over copper and mask openings as pictures. Your plan sets the rules.",
  inputSchema: Input,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  longRunning: true,
  handler: async (args, ctx) => runDurable(ctx, "board_silk", (c) => run(args as Args, c)),
});

export const boardSilkTools = [board_silk];
void readdir;
