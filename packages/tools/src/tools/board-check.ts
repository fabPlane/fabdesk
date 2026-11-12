/**
 * board_check: the board's definition of done. Onboards the project's board (requirements derived from it, kept in
 * `.fabdesk/board/`), then measures A1-A9 against them with refilled-zone DRC and schematic parity, keeps every
 * result by design hash and reports the change against the board as onboarded.
 *
 * Overlaps `verify_drc` (A1-A3 are one KiCad DRC run with parity); board_check adds the board's own
 * requirements (A4-A9), the history and the baseline comparison. Nothing here shells out to a toolkit.
 */
import { z } from "zod/v4";
import {
  CHECK_NAMES,
  onboard,
  readOnboardRecord,
  readRequirements,
  runAcceptance,
  type AcceptCode,
  type AcceptRun,
  type Comparison,
  type OnboardResult,
} from "@fabdesk/board-workflow";
import { confirmOnboarding, readOnboardingCheck } from "../board-state";
import { ToolError, defineTool } from "../registry";
import { requireKicad, runLiveDrc } from "./common";

function changeLines(c: Comparison, label: string): string[] {
  const moved = c.deltas.filter((d) => d.change !== "same" || !d.now.pass);
  const lines = [`Change vs ${label} (${c.record.at}):`];
  if (!moved.length) lines.push("- every check passes, as before");
  for (const d of moved) {
    const was = d.before.pass ? "pass" : `fail(${d.before.figure})`;
    const now = d.now.pass ? "pass" : `fail(${d.now.figure})`;
    lines.push(`- ${d.code} ${d.name}: ${was} -> ${now}${d.change === "same" ? " (unchanged)" : ` (${d.change})`}`);
  }
  if (c.newFailures.length) lines.push(`NEW FAILURES: ${c.newFailures.join(", ")}`);
  const rules = Object.entries(c.drcChange);
  if (rules.length) lines.push(`DRC error types changed: ${rules.map(([r, [b, n]]) => `${r} ${b}->${n}`).join(", ")}`);
  return lines;
}

export function describeRun(run: AcceptRun, onboarded: OnboardResult | null): string {
  const pass = run.entry.results.filter((r) => r.status === "pass" || r.status === "na").length;
  const lines = [`A1-A9: ${pass}/9 pass (design ${run.entry.designHash.slice(0, 12)}, record ${run.entry.id})`];
  if (onboarded)
    lines.push(
      `Onboarded ${onboarded.counts.footprints} parts (${onboarded.counts.fixed} fixed), ${onboarded.counts.nets} nets, ${onboarded.counts.classes} net classes, planes ${JSON.stringify(onboarded.counts.planes)}; requirements in .fabdesk/board/requirements.`,
    );
  for (const r of run.entry.results) {
    const figs = Object.entries(r.figures).map(([k, v]) => `${k}=${v}`).join(", ");
    lines.push(`${r.code} ${CHECK_NAMES[r.code as AcceptCode]}: ${r.status.toUpperCase()} (${figs})`);
    for (const e of r.evidence.slice(0, 6)) lines.push(`  - ${e}`);
  }
  if (run.changedDuringRun) lines.push("WARNING: the design files changed while the check ran; run again.");
  if (run.baseline) lines.push(...changeLines(run.baseline, "the board as onboarded"));
  else lines.push("This run is the baseline (the board as onboarded); later runs compare with it.");
  if (run.previous) lines.push(...changeLines(run.previous, "the previous run"));
  if (onboarded?.review.length)
    lines.push(
      "Onboarding proposals to review (you own these numbers; edit .fabdesk/board/requirements/acceptance.json), then record that they were checked against the circuit with board_check {\"confirm\": true}:",
      ...onboarded.review.map((r) => `- ${r}`),
    );
  return lines.join("\n");
}

export const board_check = defineTool({
  name: "board_check",
  toolset: "board",
  title: "Check the board against its own requirements (A1-A9)",
  description:
    "The board's definition of done. Derives the board's requirements on first use (fixed parts as anchors, plane layers, power/pair/impedance classes, circuit snapshot; stored in .fabdesk/board/requirements, you own the numbers) and measures nine checks: A1 connectivity, A2 drc, A3 schematic parity (one kicad-cli DRC run, zones refilled), A4 circuit unchanged, A5 anchors in place, A6 stack and via spans, A7 power widths for their current, A8 differential pairs coupled, A9 heights. Every result is kept by design hash and compared with the board as onboarded (per check before -> now, new failures named) and with the previous run. A completed measurement is a result, not a tool failure. confirm: true records (who, when, note) that the onboarding proposals were checked against the circuit, which clears the 'not yet confirmed' warning on the Status page and in release_build; it measures nothing, and onboarding again (refresh) needs a new confirmation.",
  inputSchema: {
    onboard: z
      .enum(["auto", "refresh"])
      .default("auto")
      .describe("auto: derive the requirements only when missing. refresh: derive them again from the board (overwrites edits to the requirements)."),
    pcb: z.string().optional().describe("Board file, relative to the project; default board.kicad_pcb or the project's only .kicad_pcb."),
    parity: z.boolean().default(true).describe("Include schematic parity (A3); it is most of a DRC run's time."),
    currents: z.record(z.string(), z.number().positive()).optional().describe("Expected current per net in amps, stored with the requirements when onboarding (the A7 neck rule scales with it)."),
    fixed: z.array(z.string()).optional().describe("Extra fixed references when onboarding (connectors, switches, holes, netless and locked parts are fixed already)."),
    confirm: z.boolean().default(false).describe("Record that the onboarding proposals (the review list) were checked against the circuit, instead of measuring: once you (or the owner) have checked each one."),
    by: z.enum(["agent", "owner"]).default("agent").describe("confirm: who checked them. Record the owner only when the owner said so."),
    note: z.string().max(2000).optional().describe("confirm: what was checked and against what (schematic sheets, datasheets)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  longRunning: true,
  handler: async ({ onboard: mode, pcb, parity, currents, fixed, confirm, by, note }, ctx) => {
    const project = ctx.requireProject();
    if (confirm) {
      const before = await readOnboardingCheck(project.dir);
      if (!before || !(await confirmOnboarding(project.dir, note, by)))
        throw new ToolError("nothing to confirm: the board has not been onboarded yet (run board_check first)", "precondition");
      const ob = await readOnboardingCheck(project.dir);
      return {
        text: `Onboarding confirmed by ${by}${ob?.at ? ` at ${ob.at}` : ""}: ${before.toConfirm.length} derived requirement${before.toConfirm.length === 1 ? "" : "s"} checked against the circuit${before.toConfirm.length ? `:\n${before.toConfirm.map((r) => `- ${r}`).join("\n")}` : "."}\nOnboarding again (onboard: refresh) needs a new confirmation.`,
        json: { confirmed: true, by, at: ob?.at ?? null, toConfirm: before.toConfirm, ...(note ? { note } : {}) },
      };
    }
    const cli = await requireKicad(ctx);
    let onboarded: OnboardResult | null = null;
    try {
      if (mode === "refresh" || !(await readRequirements(project.dir)))
        onboarded = await onboard(project.dir, {
          refresh: true,
          ...(pcb ? { pcb } : {}),
          ...(currents ? { currents } : {}),
          ...(fixed ? { fixed } : {}),
          name: project.name,
        });
      ctx.progress(0.2, "running DRC with refilled zones");
      const run = await runAcceptance(project.dir, {
        ...(pcb ? { pcb } : {}),
        parity,
        drc: async ({ board, parity: withParity, outFile }) => {
          const r = await runLiveDrc(ctx, cli, { board, outFile, parity: withParity, refill: true, signal: ctx.signal });
          return { violations: r.violations, unconnected: r.unconnected.length, parity: r.schematicParity.length };
        },
      });
      ctx.progress(1, "done");
      return {
        text: describeRun(run, onboarded),
        json: {
          id: run.entry.id,
          designHash: run.entry.designHash,
          summary: run.entry.summary,
          results: run.entry.results,
          baseline: run.baseline && { at: run.baseline.record.at, newFailures: run.baseline.newFailures, drcChange: run.baseline.drcChange, deltas: run.baseline.deltas },
          previous: run.previous && { at: run.previous.record.at, newFailures: run.previous.newFailures, deltas: run.previous.deltas },
          record: run.recordPath,
          onboard: onboarded ? { counts: onboarded.counts, review: onboarded.review } : (await readOnboardRecord(project.dir))?.counts,
        },
      };
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(e instanceof Error ? e.message : String(e), "precondition");
    }
  },
});

export const boardCheckTools = [board_check];
