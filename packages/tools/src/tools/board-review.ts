/**
 * board_review: the whole-board design review, bound to one design hash.
 *
 * `run` executes the checks (identity, netlist, ERC and DRC grouped by type, acceptance A1-A9 on this run's DRC, pin
 * semantics, datasheet rule cards, decoupling, current, divider, impedance, manual items, connector mouths, interconnect
 * gate, BOM, ratings, coverage, silk labels, evidence, custom checks, expert pack) and keeps the record under `.fabdesk/board/review/runs/`.
 * Every finding carries a proposal. `gate` reports 0 pass | 1 none or stale | 2 open | 3 check errors, open items leading
 * with their proposal; `dispose` records a disposition (carried to later runs by finding id); `fix` lists the proposals
 * and, with `apply`, settles what intent or evidence decides, builds and proves edit candidates (and the combined one,
 * with a change picture per READY candidate); `try` proves the agent's own plan the same way; `autopilot` is the
 * toolkit's `pcb run` (review if stale -> fixes -> owner questions); `intent*` read and write the owner's intent file;
 * `import_expert` adds an independent reviewer's findings.
 * The gate is recorded for the project's status (`recordReviewGate`). The reviewer never edits a design.
 *
 * Replaces in intent: the DRC/ERC summaries of `verify_drc` and `verify_erc` as a release judgement (those stay as
 * single-run readings). Starting a fresh-context reviewer (L8) is the owner's call and is not done here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  autopilot,
  dispose,
  createEditCandidateBuilder,
  fixProposals,
  intentDecide,
  intentInit,
  intentShow,
  lowDisk,
  tryPlan,
  type EditCandidateBuilder,
  type EditPlan,
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
  confineToProject,
} from "@fabdesk/board-workflow";
import { runKicadCli, type KicadCli } from "@fabdesk/kicad";
import { clearReviewGate, recordReviewGate } from "../board-state";
import { bomDirOf, readBomState } from "../release-state";
import { runDurable } from "../durable";
import { boardMemGiB, governor } from "../resources";
import { ToolError, defineTool, type ToolContext, type ToolOutput } from "../registry";
import { ok, requireKicad } from "./common";
import { editRunners } from "./board-edit";

/**
 * The release stage's BOM decisions (`board_release bom`, under `bomDirOf`), for the review of `pcb`. A BOM check made
 * on another board (or one without its board record) is not trusted: it comes back marked stale, and the review's BOM
 * check turns that into a must-fix instead of reading its lines. Without `pcb` (an edit candidate's review, whose board
 * differs from the source by the planned edit only) the source's decisions are read as they are.
 */
export async function bomDecisions(dir: string, pcb?: string): Promise<BomDecisions | null> {
  const st = await readBomState(dir, pcb ?? "");
  const text = await readFile(join(bomDirOf(dir), "bom-decisions.json"), "utf8").catch(() => "");
  if (!text) return null;
  const d = JSON.parse(text) as BomDecisions;
  if (pcb && st.state !== "current") return { ...d, stale: st.state === "stale" ? "the BOM check was made on an earlier board (it changed since)" : "the BOM check has no record of the board it was made on" };
  return d;
}

async function recordGate(project: ReviewProject, g: GateResult): Promise<void> {
  // never reviewed, or its runs removed: forget any saved gate rather than keep an old pass
  if (g.state === "none") return clearReviewGate(project.dir);
  await recordReviewGate(project.dir, { current: g.current, open: g.open, mustFix: g.mustFix, errors: g.errors });
}

function gateText(g: GateResult): string {
  return [...g.lines, `gate exit ${g.exit}`].join("\n");
}

/** Edit candidates through the edit stage (the source is never touched), each reviewed with the source's BOM decisions. */
function candidateBuilder(ctx: ToolContext, project: ReviewProject, cli: KicadCli): EditCandidateBuilder {
  return createEditCandidateBuilder({
    project,
    runners: editRunners(ctx, cli),
    reviewEnv: { kicad: (args) => runKicadCli(cli, args, { tolerateExit: true, signal: ctx.signal }), kicadVersion: cli.version, bom: () => bomDecisions(project.dir), trustCustom: false, signal: ctx.signal },
  });
}

/** An edit plan given as an object, inline JSON text, or a project-relative JSON file. */
async function readPlan(dir: string, plan: unknown): Promise<EditPlan> {
  let raw: unknown = plan;
  if (typeof plan === "string") {
    const t = plan.trim();
    try {
      raw = t.startsWith("{") ? JSON.parse(t) : JSON.parse(await readFile(await confineToProject(dir, t, "plan file"), "utf8"));
    } catch (e) {
      throw new ToolError(`cannot read the plan: ${e instanceof Error ? e.message : String(e)}`, "invalid_args");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError("plan must be a JSON object (a board_edit plan)", "invalid_args");
  return raw as EditPlan;
}

export const board_review = defineTool({
  name: "board_review",
  toolset: "board",
  title: "Review the whole board against one design hash",
  description:
    "Whole-board design review: the first call when asked to review a board or find its faults before ordering (then read for what the checks cannot judge). run: the checks (L0 identity/netlist, L1 ERC/DRC grouped + acceptance A1-A9 on the same DRC, L2 pin semantics + datasheet rule cards + evidence, L3 decoupling/current/divider/impedance/ratings/manual items, L4 connector mouths, L5 interconnect gate, L6 BOM/coverage/silk labels, L8 expert pack, custom checks) as findings (must-fix | question | note), each with a proposal; the record is bound to the design hash (board, schematics, project files, requirements) and goes stale when any of them changes. gate: 0 pass | 1 none/stale | 2 open | 3 check errors, open items lead with their proposal. dispose: settle a finding (state accept | fix | false-positive, by agent | owner, reason; false-positive needs thirdSource; an agent accepting a must-fix needs evidence unless the owner's intent allows it; id may end in *). fix: every open finding's proposal; apply settles what the owner's intent or evidence decides (edit proposals are built as candidate boards by the edit stage and reported READY only when the finding is gone, no new finding appears and nothing outside the plan changed). With apply, two or more READY candidates are also applied together as one combined candidate and proven (fixes/combined.json), and every READY candidate gets a change picture (change.html beside its board). try: your own board_edit plan (plan) proven exactly like the workflow's for the finding ids it should fix (ids): READY only when the proof passes, every one of them is gone, no new finding appears and nothing outside the plan changed. autopilot: review if stale, then fix with apply (settle, build and prove candidates, the combined candidate, pictures), then only what needs the owner; on a low disk it settles only. intent / intent_init / intent_decide: the owner's intent file (.fabdesk/board/review/intent.json): show it; write a skeleton (constraints from the requirements, the goal left to the owner, default preferences); record an owner decision (id, decision, covers: finding-id patterns it settles in every later review, effect). Record a decision only when the owner gave it. import_expert: add an independent reviewer's findings (file) to the current review. status: current or stale, open counts. The reviewer never edits the design; the gate result is kept for the project's status.",
  inputSchema: {
    action: z.enum(["run", "gate", "dispose", "fix", "try", "autopilot", "intent", "intent_init", "intent_decide", "import_expert", "status"]).default("run"),
    pcb: z.string().optional().describe("Board file, relative to the project; default board.kicad_pcb or the project's only .kicad_pcb."),
    checks: z.array(z.string().max(40)).max(30).optional().describe("run: only these checks (a partial run is not the project's review and does not set the gate)."),
    offline: z.boolean().default(false).describe("run: never fetch from the network (JLC/EasyEDA symbols); cached records are still read."),
    trustCustom: z.boolean().default(false).describe("run: execute the project's custom check commands (review/checks.d, review.custom). They are shell commands from the project's files, so they run only when you say so."),
    id: z.string().max(300).optional().describe("dispose: finding id; a trailing * matches a prefix. intent_decide: the decision's id (D1, usb-orientation ...)."),
    state: z.enum(["accept", "fix", "false-positive"]).optional().describe("dispose: the disposition."),
    by: z.enum(["agent", "owner"]).optional().describe("dispose: who decided. Record the owner only when the owner said so."),
    reason: z.string().max(2000).optional().describe("dispose: why, with the evidence."),
    thirdSource: z.string().max(1000).optional().describe("dispose: a source that is neither the design nor the check (datasheet page, measurement); false-positive needs it."),
    file: z.string().max(500).optional().describe("import_expert: the expert's JSON file ({reviewer, findings[]}), relative to the project."),
    apply: z.boolean().default(false).describe("fix: record the workflow's dispositions and build the edit candidates (otherwise only list the proposals)."),
    plan: z.union([z.record(z.string(), z.unknown()), z.string().max(200_000)]).optional().describe("try: a board_edit plan (id, move, add, swap, remove, net, displace ...): an object, inline JSON text, or a project-relative JSON file."),
    ids: z.array(z.string().max(300)).max(50).optional().describe("try: the finding ids the plan should fix (each must be in the current review; every one must be gone for READY)."),
    decision: z.string().max(2000).optional().describe("intent_decide: the owner's answer, in their words."),
    covers: z.array(z.string().max(300)).max(50).optional().describe("intent_decide: finding-id patterns the decision settles (* ? [seq]), e.g. L4:MOUTH:J1:*."),
    effect: z.string().max(1000).optional().describe("intent_decide: what the decision changes in practice."),
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
          const builder = cli ? candidateBuilder(ctx, project, cli) : undefined;
          const r = await fixProposals(project, { apply: input.apply, ...(builder ? { builder } : {}) });
          if (input.apply) await recordGate(project, await reviewGate(project));
          return ok(r.lines.join("\n"), r);
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
        }
      }
      case "try": {
        needs(input.plan, "plan");
        const plan = await readPlan(dir, input.plan);
        return runDurable(ctx, "board_review", async (c) => {
          const cli = await requireKicad(c);
          try {
            const r = await tryPlan(project, { plan, ids: input.ids ?? [] }, candidateBuilder(c, project, cli));
            return ok(r.lines.join("\n"), r);
          } catch (e) {
            throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
          }
        });
      }
      case "autopilot":
        return runDurable(ctx, "board_review", async (c) => {
          const cli = await requireKicad(c);
          const env: ReviewEnv = { kicad: (args) => runKicadCli(cli, args, { tolerateExit: true, signal: c.signal }), kicadVersion: cli.version, bom: () => bomDecisions(project.dir, project.pcb), trustCustom: input.trustCustom, signal: c.signal };
          let n = 0;
          const r = await autopilot(project, env, {
            offline: input.offline,
            builder: candidateBuilder(c, project, cli),
            lowDisk: await lowDisk(project.dir),
            progress: (note) => c.progress(Math.min(0.5, 0.05 + 0.02 * ++n), note),
            admit: async () => governor().admit({ cls: "light", label: "board_review", paths: [project.dir], signal: c.signal, memGiB: await boardMemGiB([project.pcb]), onWait: (why) => c.progress(0, why) }),
          });
          await recordGate(project, r.gate);
          return ok(r.lines.join("\n"), { reviewed: r.reviewed, settled: r.fix.settled, edits: r.fix.edits, combined: r.fix.combined ?? null, pictures: r.fix.pictures, tasks: r.fix.tasks, commands: r.fix.commands, owner: r.fix.owner, gate: r.gate });
        });
      case "intent": {
        const r = await intentShow(project);
        return ok(r.lines.join("\n"), r);
      }
      case "intent_init": {
        try {
          const r = await intentInit(project);
          await recordGate(project, await reviewGate(project));
          return ok(r.lines.join("\n"), r);
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
        }
      }
      case "intent_decide": {
        needs(input.id, "id");
        needs(input.decision, "decision");
        try {
          const r = await intentDecide(project, { id: input.id!, decision: input.decision!, covers: input.covers ?? [], ...(input.effect ? { effect: input.effect } : {}) });
          const g = await reviewGate(project);
          await recordGate(project, g);
          return ok(`${r.lines.join("\n")}\n${g.lines[0]}`, { ...r, gate: g });
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
        }
      }
      case "import_expert": {
        needs(input.file, "file");
        let path: string;
        try {
          path = await confineToProject(dir, input.file!, "expert file");
        } catch (e) {
          throw new ToolError(e instanceof Error ? e.message : String(e), "invalid_args");
        }
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
      bom: () => bomDecisions(project.dir, project.pcb),
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
