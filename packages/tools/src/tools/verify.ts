/** Verify toolset: ERC and the release gate (kicad-automation semantics). */
import { z } from "zod/v4";
import { PROJECT_FILES, readJsonOrNull, writeJson } from "../fs";
import { ToolError, defineTool } from "../registry";
import type { DrcReport, ErcReport } from "../services";
import { describeViolation } from "./core";
import { ok, p, requireKicad, requireSchematic } from "./common";

export const verify_erc = defineTool({
  name: "verify_erc",
  toolset: "verify",
  title: "Run KiCad ERC",
  description: "Run KiCad electrical rule check on board.kicad_sch, write reports/erc.json and return counts plus the first violations. Requires kicad-cli and a schematic (an imported KiCad project; a compiled netlist has none).",
  inputSchema: {
    severity: z.enum(["all", "error"]).default("all"),
    limit: z.number().int().min(1).max(200).default(30),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ severity, limit }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    const outFile = p(project, PROJECT_FILES.reports, "erc.json");
    ctx.progress(0.3, "running ERC");
    const report = await ctx.services.kicad.runErc(cli, { schematic, outFile, severity, signal: ctx.signal });
    await writeJson(outFile, report);
    ctx.progress(1, "done");
    const lines = [`ERC: ${report.counts.errors} errors, ${report.counts.warnings} warnings`];
    for (const v of report.violations.slice(0, limit)) lines.push(`- ${describeViolation(v)}`);
    return { text: lines.join("\n"), json: report, isError: report.counts.errors > 0 };
  },
});

export const verify_gate = defineTool({
  name: "verify_gate",
  toolset: "verify",
  title: "Release gate",
  description:
    "Evaluate the release gate over the latest reports/drc.json and reports/erc.json: pass when DRC errors == 0, unconnected == 0, ERC errors == 0 and every DRC warning signature is in fabdesk.json allowedDrcWarnings. Returns the reasons for failure and new warning signatures; pass acceptWarnings=true to baseline the current warnings (only after a human reviewed them).",
  inputSchema: {
    acceptWarnings: z.boolean().default(false).describe("Add the current new warning signatures to the allowed baseline"),
    requireErc: z.boolean().default(false).describe("Fail when no ERC report exists"),
  },
  annotations: { idempotentHint: true },
  handler: async ({ acceptWarnings, requireErc }, ctx) => {
    const project = ctx.requireProject();
    const drc = await readJsonOrNull<DrcReport>(p(project, PROJECT_FILES.reports, "drc.json"));
    if (!drc) throw new ToolError("reports/drc.json missing: run verify_drc first", "precondition");
    const erc = await readJsonOrNull<ErcReport>(p(project, PROJECT_FILES.reports, "erc.json"));
    if (!erc && requireErc) throw new ToolError("reports/erc.json missing: run verify_erc first", "precondition");
    let allowed = project.manifest().allowedDrcWarnings;
    let gate = ctx.services.kicad.gate(drc, erc ?? undefined, allowed);
    let baselined: string[] = [];
    if (acceptWarnings && gate.newWarningSignatures.length) {
      baselined = gate.newWarningSignatures;
      allowed = [...new Set([...allowed, ...baselined])];
      await project.updateManifest({ allowedDrcWarnings: allowed });
      gate = ctx.services.kicad.gate(drc, erc ?? undefined, allowed);
    }
    await writeJson(p(project, PROJECT_FILES.reports, "gate.json"), { at: new Date().toISOString(), ...gate, allowedDrcWarnings: allowed });
    const text = [
      `Gate: ${gate.pass ? "PASS" : "FAIL"}`,
      ...gate.reasons.map((r) => `- ${r}`),
      ...(gate.newWarningSignatures.length ? [`New warning signatures (${gate.newWarningSignatures.length}):`, ...gate.newWarningSignatures.slice(0, 30).map((s) => `  ${s}`)] : []),
      ...(baselined.length ? [`Baselined ${baselined.length} warning signature(s) in fabdesk.json.`] : []),
      ...(erc ? [] : ["(no ERC report; run verify_erc for full coverage)"]),
    ].join("\n");
    return { text, json: { ...gate, baselined, ercChecked: Boolean(erc) }, isError: !gate.pass };
  },
});

export const verifyTools = [verify_erc, verify_gate];
