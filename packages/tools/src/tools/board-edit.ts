/**
 * board_edit: an engineering change on a routed board, as data, with impact first and proof after.
 *
 * Impact (what the change touches; a STOP is a decision for the owner) -> apply (the unedited project is scored first,
 * the change is made on the board AND the schematic sheets in an isolated candidate, requirements copied and edited)
 * -> A1-A9 proof against the project's own baseline (strict, or "no new failure" when the project already fails) ->
 * planned-versus-collateral diff. `adopt: true` writes a passing candidate into the project through the adopt path
 * (sheets, then the board as one KiCad commit over IPC).
 *
 * Repair (re-routing what the edit opened) is the last-mile bench's `finish` step, wired through the pipeline's `repair` hook;
 * a candidate that still has opens is returned with them, and is not adopted.
 *
 * Replaces in intent: `pcb_place` for moving, swapping and re-seating parts on a routed board, `schematic_edit` and
 * `pcb_update_from_schematic` for an ECO that must reach board, schematic and requirements together, and the
 * remove/replace halves of the native part edits when the board is routed.
 */
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod/v4";
import { CHECK_NAMES, runAcceptance, edit } from "@fabdesk/board-workflow";
type EditMode = edit.EditMode;
type EditRunResult = edit.EditRunResult;
type EditRunners = edit.EditRunners;
const { runEdit } = edit;
import { adoptCandidate } from "../board-adopt";
import { runDurable } from "../durable";
import { jailPath } from "../fs";
import { ToolError, defineTool, type ToolContext } from "../registry";
import { editMemGiB, governor } from "../resources";
import { ChildTaskError, type EditChildInput } from "../child-tasks";
import type { KicadCli } from "../services";
import { ok, requireKicad, runLiveDrc } from "./common";
import { repairEditCandidate } from "./board-lastmile-actions";

/**
 * Fixed-length number lists as `array` + `length(n)`, not tuples: the MCP SDK writes a tuple as array-form
 * `items: [...]`, and Codex silently drops every tool whose schema has one (board_edit and board_route were missing
 * from its tool list). The tools test checks the listed schemas.
 */
const nums = (n: number) => z.array(z.number()).length(n);

const MOVE = z.object({
  ref: z.string(),
  to: nums(3).optional().describe("[x, y, rotation degrees]: the new origin pose; side kept."),
  near: z.union([z.string(), nums(2)]).optional().describe("Instead of `to`: sit next to a part, a REF.PAD, or a point; the tool picks the pose."),
  carry: z.array(z.string()).optional().describe("Parts that move rigidly with it (their internal copper too)."),
  carry_auto: z.array(z.string()).optional().describe("These parts plus the parts whose every non-ground net stays inside the block."),
  anchor: z.boolean().optional().describe("The new pose becomes a mechanical anchor (required for a fixed part)."),
  basis: z.string().optional(),
  radius: z.number().optional(),
  rotations: z.enum(["keep", "any"]).optional(),
  make_room: z.boolean().optional(),
});

const PLAN = z
  .object({
    id: z.string().describe("Letters, digits, - _ . (names the candidate folder)."),
    authority: z.string().optional().describe("Whose direction this is (the owner's decision)."),
    reason: z.string().optional(),
    remove: z.array(z.string()).optional().describe("Parts to delete, with their symbols and copper."),
    move: z.array(MOVE).optional(),
    displace: z
      .object({
        radius: z.number().optional(),
        clearance: z.number().optional(),
        pad_clearance: z.number().optional(),
        rotations: z.enum(["keep", "any"]).optional(),
        near: z.record(z.string(), nums(2)).optional(),
        fixed_allowed: z.record(z.string(), z.string()).optional().describe("Fixed parts the plan lets move, each with the reason."),
      })
      .optional()
      .describe("Parts in the way of a move are re-seated nearby (without it, parts in the way stop the edit)."),
    swap: z
      .array(
        z.object({
          ref: z.string(),
          value: z.string().optional(),
          fields: z.record(z.string(), z.string()).optional(),
          footprint: z.string().optional().describe("LIB:NAME: rebuild the footprint (pose and pad-number -> net map kept)."),
          side: z.enum(["F", "B"]).optional(),
          dnp: z.boolean().optional(),
          height_mm: z.number().optional(),
          height_basis: z.string().optional(),
        }),
      )
      .optional(),
    add: z
      .array(
        z.object({
          ref: z.string(),
          like: z.string().describe("A placed part to copy: symbol sheet and instance path, field layout, default footprint and value."),
          value: z.string().optional(),
          footprint: z.string().optional(),
          pins: z.record(z.string(), z.string()).describe("Pad number -> net."),
          near: z.union([z.string(), nums(2)]).optional(),
          side: z.enum(["F", "B"]).optional(),
          rot: z.number().optional(),
          fields: z.record(z.string(), z.string()).optional(),
          symbol: z.string().optional().describe("LIB:NAME from the project's symbol library instead of like's symbol."),
          height_mm: z.number().optional(),
          height_basis: z.string().optional(),
          radius: z.number().optional(),
          rotations: z.enum(["keep", "any"]).optional(),
          basis: z.string().optional(),
        }),
      )
      .optional(),
    net: z.array(z.object({ pin: z.string().describe("REF.PAD"), to: z.string(), tap_width: z.number().optional(), tap_basis: z.string().optional() })).optional().describe("Move a pad to another net: the pad, the schematic label at its pin, and both nets' dangling copper."),
    accept_unconnected: z.array(z.string()).optional().describe("REF.PAD left alone on a single-pad net, reviewed (impact lists them)."),
    accept_before: z.record(z.string(), z.string()).optional().describe("Parity/circuit/anchor/height checks (A3_parity ...) that already fail on the source, each with the reason."),
    notes: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

async function readPlan(ctx: ToolContext, plan: unknown): Promise<unknown> {
  if (typeof plan !== "string") return plan;
  const t = plan.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch (e) {
      throw new ToolError(`plan is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, "invalid_args");
    }
  }
  const file = await jailPath(ctx.requireProject().dir, t);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new ToolError(`cannot read the plan ${t}: ${e instanceof Error ? e.message : String(e)}`, "not_found");
  }
}

const py = (n: number) => String(n);

export function describeEdit(r: EditRunResult, adopted: string | null): string {
  const lines: string[] = [];
  if (r.stage === "impact") {
    lines.push(...r.impactLines);
    if (r.mode !== "impact" || r.stop) lines.push(r.stop ? "STOP: a decision is needed before anything is written (see REVIEW lines)." : "Nothing was written.");
    else lines.push("Nothing was written (mode impact).");
    return lines.join("\n");
  }
  lines.push(`Plan ${r.planId}: ${r.impact.verdict}`);
  for (const l of r.impactLines.filter((x) => /^(part|net|move|carry|near|displace|copper|REVIEW|landing|court)/.test(x))) lines.push(l);
  if (r.stage === "apply" && !r.candidate) {
    lines.push(r.verdict);
    return lines.join("\n");
  }
  if (r.candidate) lines.push(`Candidate: ${r.candidate.dir} (board ${relative(r.candidate.dir, r.candidate.pcb)}, origin.json beside it)`);
  const ap = r.applied;
  if (ap) {
    const bits = [
      ap.footprints ? `removed ${ap.footprints} footprint(s), ${ap.symbols} symbol(s)` : "",
      ap.moves ? `moved ${ap.moves.moved.length}, carried ${ap.moves.carried.length}, near ${ap.moves.near.length}, displaced ${ap.moves.displaced.length}` : "",
      ap.swaps.length ? `swapped ${ap.swaps.length} footprint(s)` : "",
      ap.adds.length ? `added ${ap.adds.map((a) => a.ref).join(", ")}` : "",
      ap.net_changes.length ? `re-netted ${ap.net_changes.map((c) => `${c.pin} ${c.from} -> ${c.to}`).join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`Applied: ${bits.join("; ") || "field/value changes only"}.`);
  }
  if (r.repair) {
    const nets = r.repair.routeAgain.length;
    lines.push(
      r.repair.available
        ? `Repair (route stage): ${r.repair.note ?? "nothing to do"}.`
        : nets
          ? `Repair: no route stage ran. ${nets} net(s) lost copper and must be routed again in the candidate: ${r.repair.routeAgain.join(", ")}.`
          : "Repair: nothing opened.",
    );
  }
  if (r.stage === "apply") {
    if (r.churn) lines.push(`Change: ${r.diff!.removed.length} removed, ${r.diff!.added.length} added, ${r.diff!.moved.length} moved, ${Object.keys(r.diff!.copper_changed_nets).length} nets' copper changed; collateral ${r.churn.collateral_nets} nets / ${r.churn.collateral_mm} mm, unplanned parts moved ${r.churn.unplanned_moved.length}.`);
    lines.push("Not proven yet: board_edit mode proof (or full) judges A1-A9 on the candidate.");
    return lines.join("\n");
  }
  const p = r.proof!;
  const pass = Object.values(p.after).filter(Boolean).length;
  lines.push(`Proof (${p.mode === "strict" ? "strict: the source passed every check" : "no new failure: the source already fails some checks"}): ${r.verdict}`);
  lines.push(`A1-A9 after the edit: ${pass}/9 pass; open connections ${p.figures.open ?? "?"}, DRC errors ${Object.values(p.figures.drc).reduce((a, b) => a + b, 0)}, A7 nets failing ${p.figures.a7 ?? "?"}, A8 nets failing ${p.figures.a8 ?? "?"}.`);
  const moved = p.comparison?.changes.filter((c) => c.change !== "same") ?? [];
  if (p.comparison) {
    lines.push(moved.length ? `Against the source:` : "Against the source: every check as before.");
    for (const c of moved) lines.push(`- ${c.code} ${CHECK_NAMES[c.code as keyof typeof CHECK_NAMES]}: ${c.before} -> ${c.now} (${c.change})`);
    if (p.comparison.newFailures.length) lines.push(`NEW FAILURES: ${p.comparison.newFailures.join(", ")}`);
  }
  const ch = r.churn!;
  lines.push(`Planned vs collateral: ${r.diff!.removed.length} removed, ${r.diff!.added.length} added, ${ch.planned_parts_moved.length} planned part(s) moved, unplanned parts moved ${py(ch.unplanned_moved.length)}${ch.unplanned_moved.length ? ` (${ch.unplanned_moved.join(", ")})` : ""}; collateral copper ${ch.collateral_nets} nets / ${ch.collateral_mm} mm.`);
  if (r.guard)
    lines.push(
      r.guard.kept
        ? `Churn guard: ${r.guard.nets.length} net(s) the plan did not touch got their original copper back (${r.guard.nets.slice(0, 8).join(", ")}${r.guard.nets.length > 8 ? " ..." : ""}); the board scored no worse.`
        : `Churn guard: putting the original copper back on ${r.guard.nets.length} untouched net(s) scored ${r.guard.why ?? "worse"}, so the repaired copper stays.`,
    );
  lines.push(adopted ?? (p.pass ? "Passes: board_edit with adopt true writes it into the project." : "Not adoptable as it stands: the proof does not pass."));
  return lines.join("\n");
}

/** The runners the edit pipeline needs: A1-A9 on a live DRC, and the last-mile `finish` step to repair cut nets. */
export function editRunners(c: ToolContext, cli: KicadCli): EditRunners {
  return {
    progress: (p, note) => c.progress(p, note),
    // nets the edit cut are reconnected by the last-mile bench (editbench order: finish, pairs, taps, a7, leg, rip + blockers)
    repair: (r) => repairEditCandidate(c, r),
    accept: (dir, pcb) =>
      runAcceptance(dir, {
        pcb,
        parity: true,
        drc: async ({ board, parity, outFile }) => {
          const r = await runLiveDrc(c, cli, { board, outFile, parity, refill: true, signal: c.signal });
          return { violations: r.violations, unconnected: r.unconnected.length, parity: r.schematicParity.length };
        },
      }),
  };
}

/**
 * The edit pipeline with its heavy compute (impact, apply, proof) in a child process when the host can start one
 * (`services.runChild`; see child-tasks.ts): on a large board it holds several GiB and minutes of CPU. The repair step
 * (the last-mile bench, itself running router processes) stays here, between the child's apply and proof. Without
 * `runChild` (tests, embedded hosts) the pipeline runs in-process as before.
 */
const TOOL_ERROR_CODES: ReadonlySet<string> = new Set(["invalid_args", "not_found", "precondition", "cancelled", "unavailable", "internal"]);

export async function runEditOutOfCore(
  c: ToolContext,
  o: { projectDir: string; plan: unknown; mode: EditMode; pcb?: string; candidate?: string },
  cli: KicadCli | null,
): Promise<EditRunResult> {
  const run = c.services.runChild;
  if (!run) return runEdit({ ...o, runners: editRunners(c, cli!) });
  const child = async (mode: "impact" | "apply" | "proof", candidate?: string): Promise<EditRunResult> => {
    const input: EditChildInput = { projectDir: o.projectDir, plan: o.plan, mode, ...(o.pcb ? { pcb: o.pcb } : {}), ...(candidate ? { candidate } : {}), kicadCli: cli?.path ?? null };
    try {
      return (await run("edit", input, { signal: c.signal, onProgress: (p, n) => c.progress(p, n) })) as EditRunResult;
    } catch (e) {
      if (e instanceof ChildTaskError && e.errorName === "EditStop") throw new ToolError(e.message, "precondition");
      // only a ToolError's own codes come back as a ToolError; a system error code (ENOENT, EACCES ...) stays internal
      if (e instanceof ChildTaskError && e.code && TOOL_ERROR_CODES.has(e.code)) throw new ToolError(e.message, e.code as ToolError["code"]);
      throw e;
    }
  };
  if (o.mode === "impact" || o.mode === "proof") return child(o.mode, o.candidate);
  const applied = await child("apply");
  const routeAgain = applied.repair?.routeAgain ?? [];
  if (o.mode === "apply" || applied.stage !== "apply" || applied.stop || !applied.candidate) return { ...applied, ...(applied.repair ? { repair: { ...applied.repair, available: true } } : {}) };
  let note: string | undefined;
  if (routeAgain.length) {
    c.progress(0.55, "repair (route stage)");
    note = (await repairEditCandidate(c, { candidateDir: applied.candidate.dir, pcb: applied.candidate.pcb, routeAgain })).note;
  }
  const proven = await child("proof", applied.candidate.dir);
  return { ...proven, phases: { ...applied.phases, ...proven.phases }, repair: { available: true, routeAgain, ...(note ? { note } : {}) } };
}

export const board_edit = defineTool({
  name: "board_edit",
  toolset: "board",
  title: "Engineering change on a routed board (impact, apply, proof)",
  description:
    "An ECO on a routed board as a plan, not as hand edits. Plan keys: remove [refs]; move [{ref, to:[x,y,rot] | near:REF|REF.PAD|[x,y], carry, carry_auto, anchor, basis}] with displace {radius, ...} (parts in the way are re-seated nearby, fixed parts stop it); swap [{ref, value, fields, footprint:LIB:NAME, side, dnp}] (a position swap of two parts is two moves); add [{ref, like, pins:{pad:net}, near, value, footprint}] (copies the template symbol and footprint, one label per pin); net [{pin:REF.PAD, to:NET}] (pad, schematic label and dangling copper). mode impact: what it touches (parts, nets, copper, requirement entries, contracts, schematic symbols) and a verdict; STOP means a decision (pins left alone, fixed part in the way, anchor) and writes nothing. mode apply: scores the unedited project, makes the change on board AND schematic sheets in a candidate folder (.fabdesk/board/edits/<id>-<time>) with edited requirements and an origin.json, and lists the nets to route again. mode proof: A1-A9 on the candidate against the project before the edit (strict if it passed, no new failure if it already failed) and the planned-versus-collateral diff. full (default) = impact, apply, proof. adopt: true writes a PASSING candidate into the project (sheets, then the board as one KiCad commit). In full/apply, nets the edit cut are reconnected in the candidate by board_route's last-mile steps in order (finish; pairs if a pair got worse; then while opens remain taps, a7, leg, rip+blockers:1.0; each kept only if the whole board improves under its gate) before the proof; the candidate's last-mile workspace stays at <candidate>/.lastmile for board_route info/view/why/try (pass it as workspace). After the proof a churn guard gives nets the plan did not touch their original copper back when the board scores no worse. A candidate that still has opens is not adopted. A completed measurement is a result, not a tool failure.",
  inputSchema: {
    plan: z.union([PLAN, z.string()]).describe("The plan: an object, inline JSON text, or a project-relative path to a JSON file."),
    mode: z.enum(["impact", "apply", "proof", "full"]).default("full"),
    adopt: z.boolean().default(false).describe("After a passing proof, write the candidate into the project."),
    candidate: z.string().optional().describe("mode proof: the candidate folder (default: the newest of this plan id)."),
    pcb: z.string().optional().describe("Board file, relative to the project; default board.kicad_pcb or the only .kicad_pcb."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  longRunning: true,
  handler: (input, ctx) =>
    runDurable(ctx, "board_edit", async (c) => {
      const project = c.requireProject();
      const mode = input.mode as EditMode;
      const plan = await readPlan(c, input.plan);
      const cli = mode === "impact" ? null : await requireKicad(c);
      const job = await governor().admit({
        cls: "light",
        label: "board_edit",
        paths: [project.dir],
        signal: c.signal,
        memGiB: await editMemGiB([project.dir]),
        onWait: (why) => c.progress(0, why),
      });
      try {
        const candidate = input.candidate ? await jailPath(project.dir, input.candidate) : undefined;
        const result = await runEditOutOfCore(c, { projectDir: project.dir, plan, mode, ...(input.pcb ? { pcb: input.pcb } : {}), ...(candidate ? { candidate } : {}) }, cli);
        let adopted: string | null = null;
        let adoptData: unknown = null;
        if (input.adopt) {
          if (!result.candidate || result.stage !== "proof") adopted = "adopt: nothing to adopt (no candidate was proven).";
          else if (!result.proof!.pass) adopted = `adopt refused: the proof does not pass (${result.verdict}).`;
          else {
            try {
              const a = await adoptCandidate(c, { candidate: result.candidate.pcb, board: relative(project.dir, result.impact.board), reason: `board_edit ${result.planId}` });
              adopted = a.text;
              adoptData = a.data;
            } catch (e) {
              if (!(e instanceof ToolError)) throw e;
              adopted = `adopt refused: ${e.message}`;
            }
          }
        }
        return ok(describeEdit(result, adopted), { ...result, adopted: adoptData, adoptNote: adopted });
      } finally {
        job.release();
      }
    }),
});

export const boardEditTools = [board_edit];
