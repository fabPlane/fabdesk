/**
 * board_review: the whole-board design review, bound to one design hash.
 *
 * `run` executes the checks (identity, netlist, ERC and DRC grouped by type, acceptance A1-A9 on this run's DRC, pin
 * semantics, datasheet rule cards, decoupling, current, impedance, manual items, connector mouths, interconnect gate, BOM,
 * ratings, coverage, evidence, custom checks, expert pack) and keeps the record under `.fabdesk/board/review/runs/`.
 * Every finding carries a proposal. `gate` reports 0 pass | 1 none or stale | 2 open | 3 check errors, open items leading
 * with their proposal; `dispose` records a disposition (carried to later runs by finding id); `fix` lists the proposals
 * and, with `apply`, settles what intent or evidence decides; `import_expert` adds an independent reviewer's findings.
 * The gate is recorded for the project's status (`recordReviewGate`). The reviewer never edits a design.
 *
 * Replaces in intent: the DRC/ERC summaries of `verify_drc` and `verify_erc` as a release judgement (those stay as
 * single-run readings). Starting a fresh-context reviewer (L8) is the owner's call and is not done here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  dispose,
  createEditCandidateBuilder,
  fixProposals,
  importExpert,
  openReviewProject,
  reviewGate,
  reviewStatus,
  runReview,
  type BomDecisions,
  type ExpertFile,
  type GateResult,
  type ReviewEnv,
  type ReviewProject,
} from "@fabdesk/board-workflow";
import { runKicadCli } from "@fabdesk/kicad";
import { recordReviewGate } from "../board-state";
import { runDurable } from "../durable";
import { boardMemGiB, governor } from "../resources";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import { ok, requireKicad } from "./common";
import { editRunners } from "./board-edit";

const BOM_PLACES = [".fabdesk/board/release/bom-decisions.json", ".fabdesk/board/bom/bom-decisions.json"];

async function bomDecisions(dir: string): Promise<BomDecisions | null> {
  for (const rel of BOM_PLACES) {
    const text = await readFile(join(dir, rel), "utf8").catch(() => "");
    if (text) return JSON.parse(text) as BomDecisions;
  }
  return null;
}

async function recordGate(project: ReviewProject, g: GateResult): Promise<void> {
  if (g.state === "none") return; // never reviewed: the status already says "not run"
  await recordReviewGate(project.dir, { current: g.current, open: g.open, mustFix: g.mustFix, errors: g.errors });
}

function gateText(g: GateResult): string {
  return [...g.lines, `gate exit ${g.exit}`].join("\n");
}

export const board_review = defineTool({
  name: "board_review",
  toolset: "board",
  title: "Review the whole board against one design hash",
  description:
    "Whole-board design review. run: the checks (L0 identity/netlist, L1 ERC/DRC grouped + acceptance A1-A9 on the same DRC, L2 pin semantics + datasheet rule cards + evidence, L3 decoupling/current/impedance/ratings/manual items, L4 connector mouths, L5 interconnect gate, L6 BOM/coverage, L8 expert pack, custom checks) as findings (must-fix | question | note), each with a proposal; the record is bound to the design hash (board, schematics, project files, requirements) and goes stale when any of them changes. gate: 0 pass | 1 none/stale | 2 open | 3 check errors, open items lead with their proposal. dispose: settle a finding (state accept | fix | false-positive, by agent | owner, reason; false-positive needs thirdSource; an agent accepting a must-fix needs evidence unless the owner's intent allows it; id may end in *). fix: every open finding's proposal; apply settles what the owner's intent or evidence decides (edit proposals are built as candidate boards by the edit stage and reported READY only when the finding is gone, no new finding appears and nothing outside the plan changed). import_expert: add an independent reviewer's findings (file) to the current review. status: current or stale, open counts. The reviewer never edits the design; the gate result is kept for the project's status.",
  inputSchema: {
    action: z.enum(["run", "gate", "dispose", "fix", "import_expert", "status"]).default("run"),
    pcb: z.string().optional().describe("Board file, relative to the project; default board.kicad_pcb or the project's only .kicad_pcb."),
    checks: z.array(z.string().max(40)).max(30).optional().describe("run: only these checks (a partial run is not the project's review and does not set the gate)."),
    offline: z.boolean().default(false).describe("run: never fetch from the network (JLC/EasyEDA symbols); cached records are still read."),
    trustCustom: z.boolean().default(false).describe("run: execute the project's custom check commands (review/checks.d, review.custom). They are shell commands from the project's files, so they run only when you say so."),
    id: z.string().max(300).optional().describe("dispose: finding id; a trailing * matches a prefix."),
    state: z.enum(["accept", "fix", "false-positive"]).optional().describe("dispose: the disposition."),
    by: z.enum(["agent", "owner"]).optional().describe("dispose: who decided. Record the owner only when the owner said so."),
    reason: z.string().max(2000).optional().describe("dispose: why, with the evidence."),
    thirdSource: z.string().max(1000).optional().describe("dispose: a source that is neither the design nor the check (datasheet page, measurement); false-positive needs it."),
    file: z.string().max(500).optional().describe("import_expert: the expert's JSON file ({reviewer, findings[]}), relative to the project."),
    apply: z.boolean().default(false).describe("fix: record the workflow's dispositions (otherwise only list the proposals)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  longRunning: true,
  handler: async (input, ctx): Promise<ToolOutput> => {
    const dir = ctx.requireProject().dir;
    let project: ReviewProject;
    try {
      project = await openReviewProject(dir, input.pcb);
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
    }
    const needs = (v: unknown, name: string) => {
      if (v === undefined || v === "") throw new ToolError(`${input.action} needs ${name}`, "invalid_args");
    };
    switch (input.action) {
      case "run":
        return runDurable(ctx, "board_review", (c) => run(c, project, input));
      case "status": {
        const s = await reviewStatus(project);
        return ok(`${project.name}: ${s.state}${s.run ? ` (${s.run})` : ""}${s.findings ? `\n${s.findings} findings, ${s.open} open (${s.mustFix} must-fix), ${s.errors} check errors` : ""}`, s);
      }
      case "gate": {
        const g = await reviewGate(project);
        await recordGate(project, g);
        return ok(gateText(g), g);
      }
      case "dispose": {
        needs(input.id, "id");
        needs(input.state, "state");
        needs(input.by, "by");
        needs(input.reason, "reason");
        try {
          const d = await dispose(project, { id: input.id!, state: input.state!, by: input.by!, reason: input.reason!, ...(input.thirdSource ? { third_source: input.thirdSource } : {}) });
          const g = await reviewGate(project);
          await recordGate(project, g);
          return ok(`${d.lines.join("\n")}\n${g.lines[0]}`, { disposed: d.disposed, gate: g });
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e), "invalid_args");
        }
      }
      case "fix": {
        try {
          // edit proposals become candidate boards through the edit stage when applying (the source is never touched)
          const cli = input.apply ? await requireKicad(ctx) : null;
          const builder = cli
            ? createEditCandidateBuilder({
                project,
                runners: editRunners(ctx, cli),
                reviewEnv: { kicad: (args) => runKicadCli(cli, args, { tolerateExit: true, signal: ctx.signal }), kicadVersion: cli.version, bom: () => bomDecisions(project.dir), trustCustom: false, signal: ctx.signal },
              })
            : undefined;
          const r = await fixProposals(project, { apply: input.apply, ...(builder ? { builder } : {}) });
          if (input.apply) await recordGate(project, await reviewGate(project));
          return ok(r.lines.join("\n"), r);
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
        }
      }
      case "import_expert": {
        needs(input.file, "file");
        const path = input.file!.startsWith("/") ? input.file! : join(dir, input.file!);
        const ex = JSON.parse(await readFile(path, "utf8").catch(() => "null")) as ExpertFile | null;
        if (!ex) throw new ToolError(`cannot read ${path} as JSON`, "invalid_args");
        try {
          const r = await importExpert(project, ex, path);
          const g = await reviewGate(project);
          await recordGate(project, g);
          return ok(`imported ${r.imported} expert findings into ${r.run}\n${g.lines[0]}`, { ...r, gate: g });
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
        }
      }
    }
  },
});

async function run(ctx: ToolContext, project: ReviewProject, input: { checks?: string[] | undefined; offline: boolean; trustCustom: boolean }): Promise<ToolOutput> {
  const cli = await requireKicad(ctx);
  const job = await governor().admit({ cls: "light", label: "board_review", paths: [project.dir], signal: ctx.signal, memGiB: await boardMemGiB([project.pcb]), onWait: (why) => ctx.progress(0, why) });
  try {
    const env: ReviewEnv = {
      kicad: (args) => runKicadCli(cli, args, { tolerateExit: true, signal: ctx.signal }),
      kicadVersion: cli.version,
      bom: () => bomDecisions(project.dir),
      trustCustom: input.trustCustom,
      signal: ctx.signal,
    };
    let n = 0;
    const res = await runReview(project, env, {
      ...(input.checks?.length ? { checks: input.checks } : {}),
      offline: input.offline,
      progress: (note) => ctx.progress(Math.min(0.95, 0.05 + 0.045 * ++n), note),
    });
    const ev = res.evaluation;
    const partial = res.review.partial;
    let g: GateResult | undefined;
    if (!partial) {
      g = await reviewGate(project);
      await recordGate(project, g);
    }
    const mustFix = ev.open.filter((r) => r.severity === "must-fix").length;
    const lines = [
      `Review ${project.name}: ${res.review.findings.length} findings, ${ev.open.length} open (${mustFix} must-fix), ${ev.errors.length} check errors; design ${res.review.hash.slice(0, 12)}; ${res.review.seconds.toFixed(0)} s${partial ? " (partial run: not the project's review, gate unchanged)" : ""}`,
      ...res.review.checks.map((c) => `  ${c.name.padEnd(13)} ${c.layer.padEnd(3)} ${c.status.padEnd(7)} ${c.detail.slice(0, 90)}`),
      ...(g ? ["", ...g.lines] : []),
      "",
      `Report: ${join(res.dir, "review.md")}`,
    ];
    return ok(lines.join("\n"), {
      dir: res.dir,
      hash: res.review.hash,
      partial,
      checks: res.review.checks.map((c) => ({ name: c.name, layer: c.layer, status: c.status, detail: c.detail, findings: res.review.findings.filter((f) => f.check === c.name).length })),
      findings: res.review.findings.length,
      open: ev.open.map((r) => ({ id: r.id, severity: r.severity, claim: r.claim, proposal: r.proposal ? { by: r.proposal.by, action: r.proposal.action, effect: r.proposal.effect } : null })),
      errors: ev.errors.map((c) => ({ name: c.name, detail: c.detail })),
      gate: g ?? null,
    });
  } finally {
    job.release();
  }
}

export const boardReviewTools = [board_review];
