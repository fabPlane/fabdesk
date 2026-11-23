/** Verify toolset: ERC and the release gate (kicad-automation semantics). */
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, exists, readJsonOrNull, writeJson } from "../fs";
import { checkMaterialBoard, materialCheckTitle, planMaterialApply } from "../materials";
import { ToolError, defineTool } from "../registry";
import type { DrcReport, ErcReport } from "../services";
import { describeViolation } from "./core";
import {
  VIAGRID_9055,
  VIAGRID_9055_HOLES,
  VIAGRID_9055_VIAS,
  boardToViagrid,
  isOnViagrid9055Via,
} from "../templates/viagrid-9055";
import {
  inspectSavedHierarchy,
  ok,
  p,
  requireKicad,
  requireSchematic,
  writeReport,
} from "./common";

export const verify_erc = defineTool({
  name: "verify_erc",
  toolset: "verify",
  title: "Run KiCad ERC",
  description:
    "Run packaged kicad-cli electrical rule check on the complete saved schematic hierarchy, bind it to the aggregate revision of every referenced native sheet, write qualified evidence to reports/erc.json, and return counts and violations.",
  inputSchema: {
    severity: z.enum(["all", "error"]).default("all"),
    limit: z.number().int().min(1).max(200).default(30),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ severity, limit }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    const outFile = p(project, PROJECT_FILES.reports, "erc.json");
    const checkedHierarchy = await inspectSavedHierarchy(ctx, project, cli);
    // A hierarchy with no placed symbols gives kicad-cli nothing to check, so its ERC is
    // vacuously clean. Report it as not applicable (same shape as an incomplete hierarchy)
    // instead of a measured pass. See issue #64.
    const noSymbols = checkedHierarchy.complete && checkedHierarchy.counts.components === 0;
    if (!checkedHierarchy.complete || noSymbols) {
      const failed = {
        violations: [],
        counts: { errors: 1, warnings: 0 },
        measurement: {
          evidenceLevel: "missing" as const,
          source: "packaged-kicad-cli" as const,
          scope: "complete saved hierarchy" as const,
          applicability: false,
          ...(noSymbols ? { reason: "no-schematic-symbols" as const } : {}),
          checkedRevision: checkedHierarchy.aggregateRevision,
          currentRevision: checkedHierarchy.aggregateRevision,
          revisionStable: true,
          capturedAt: new Date().toISOString(),
          hierarchy: checkedHierarchy,
          kicadCli: { path: cli.path, version: cli.version },
        },
      };
      await writeJson(outFile, failed);
      return {
        text: noSymbols
          ? `Saved-file ERC not applicable: the saved schematic hierarchy has no placed symbols (${checkedHierarchy.sheets.length} sheet(s), 0 components), so there is nothing to check. Place the design's symbols before running ERC.`
          : `Saved-file ERC not applicable: native schematic hierarchy is incomplete (${checkedHierarchy.issues.map((issue) => `${issue.kind}: ${issue.path}`).join(", ")}).`,
        json: failed,
        isError: true,
      };
    }
    ctx.progress(0.3, "measuring saved-file ERC with packaged kicad-cli");
    const report = await ctx.services.kicad.runErc(cli, {
      schematic,
      outFile,
      severity,
      signal: ctx.signal,
    });
    const currentHierarchy = await inspectSavedHierarchy(ctx, project, cli);
    const checkedRevision = checkedHierarchy.aggregateRevision;
    const currentRevision = currentHierarchy.aggregateRevision;
    const result = {
      ...report,
      measurement: {
        evidenceLevel: "measured" as const,
        source: "packaged-kicad-cli" as const,
        scope: "complete saved hierarchy" as const,
        applicability: checkedHierarchy.complete,
        checkedRevision,
        currentRevision,
        revisionStable: checkedRevision === currentRevision,
        capturedAt: new Date().toISOString(),
        kicadCli: { path: cli.path, version: cli.version },
        hierarchy: {
          rootFile: checkedHierarchy.rootFile,
          referencedSheetCount: checkedHierarchy.sheets.length,
          complete: checkedHierarchy.complete,
          referencedFiles: checkedHierarchy.referencedFiles,
          orphanFiles: checkedHierarchy.orphanFiles,
          // Lets readers such as the order gate recompute the aggregate revision from current bytes.
          sheets: checkedHierarchy.sheets.map(({ hierarchyPath, nativePath, identity }) => ({
            hierarchyPath,
            nativePath,
            identity,
          })),
        },
      },
    };
    await writeJson(outFile, result);
    ctx.progress(1, "done");
    const lines = [
      `Complete saved-hierarchy ERC measured by packaged kicad-cli ${cli.version} for aggregate revision ${checkedRevision} across ${checkedHierarchy.sheets.length} referenced sheet(s): ${report.counts.errors} errors, ${report.counts.warnings} warnings${checkedRevision === currentRevision ? "" : " (STALE: a referenced schematic changed during measurement)"}`,
    ];
    for (const v of report.violations.slice(0, limit)) lines.push(`- ${describeViolation(v)}`);
    return { text: lines.join("\n"), json: result, isError: report.counts.errors > 0 };
  },
});

export const verify_gate = defineTool({
  name: "verify_gate",
  toolset: "verify",
  title: "Release gate",
  description:
    "Evaluate the release gate over saved-file reports/drc.json and packaged-kicad-cli reports/erc.json evidence. The result includes pass status, failure reasons, and warning signatures. acceptWarnings adds current warning signatures to fabdesk.json allowedDrcWarnings.",
  inputSchema: {
    acceptWarnings: z
      .boolean()
      .default(false)
      .describe("Add the current new warning signatures to the allowed baseline"),
    requireErc: z.boolean().default(false).describe("Fail when no ERC report exists"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ acceptWarnings, requireErc }, ctx) => {
    const project = ctx.requireProject();
    const drc = await readJsonOrNull<
      DrcReport & { schematicHierarchy?: { aggregateRevision?: string } }
    >(p(project, PROJECT_FILES.reports, "drc.json"));
    if (!drc) throw new ToolError("reports/drc.json missing", "precondition");
    const erc = await readJsonOrNull<
      ErcReport & { measurement?: { checkedRevision?: string; scope?: string } }
    >(p(project, PROJECT_FILES.reports, "erc.json"));
    if (!erc && requireErc) throw new ToolError("reports/erc.json missing", "precondition");
    const hierarchyClaimed =
      erc?.measurement?.scope === "complete saved hierarchy" ||
      typeof drc.schematicHierarchy?.aggregateRevision === "string";
    const currentHierarchy = hierarchyClaimed ? await inspectSavedHierarchy(ctx, project) : null;
    const staleEvidence = [
      ...(erc?.measurement?.checkedRevision &&
      currentHierarchy &&
      erc.measurement.checkedRevision !== currentHierarchy.aggregateRevision
        ? ["saved-file ERC evidence is stale relative to the current aggregate schematic revision"]
        : []),
      ...(drc.schematicHierarchy?.aggregateRevision &&
      currentHierarchy &&
      drc.schematicHierarchy.aggregateRevision !== currentHierarchy.aggregateRevision
        ? [
            "schematic/PCB parity evidence is stale relative to the current aggregate schematic revision",
          ]
        : []),
      ...(currentHierarchy && !currentHierarchy.complete
        ? ["current saved schematic hierarchy is incomplete"]
        : []),
      ...(currentHierarchy?.complete && currentHierarchy.counts.components === 0
        ? ["current saved schematic hierarchy has no placed symbols; ERC had nothing to check"]
        : []),
    ];
    let allowed = project.manifest().allowedDrcWarnings;
    let gate = ctx.services.kicad.gate(drc, erc ?? undefined, allowed);
    let baselined: string[] = [];
    if (acceptWarnings && gate.newWarningSignatures.length) {
      baselined = gate.newWarningSignatures;
      allowed = [...new Set([...allowed, ...baselined])];
      await project.updateManifest({ allowedDrcWarnings: allowed });
      gate = ctx.services.kicad.gate(drc, erc ?? undefined, allowed);
    }
    if (staleEvidence.length)
      gate = {
        ...gate,
        pass: false,
        reasons: [...gate.reasons, ...staleEvidence],
      };
    await writeJson(p(project, PROJECT_FILES.reports, "gate.json"), {
      at: new Date().toISOString(),
      ...gate,
      allowedDrcWarnings: allowed,
    });
    const text = [
      `Gate: ${gate.pass ? "PASS" : "FAIL"}`,
      ...gate.reasons.map((r) => `- ${r}`),
      ...(gate.newWarningSignatures.length
        ? [
            `New warning signatures (${gate.newWarningSignatures.length}):`,
            ...gate.newWarningSignatures.slice(0, 30).map((s) => `  ${s}`),
          ]
        : []),
      ...(baselined.length
        ? [`Baselined ${baselined.length} warning signature(s) in fabdesk.json.`]
        : []),
      ...(erc ? [] : ["(no saved-file ERC report)"]),
    ].join("\n");
    return { text, json: { ...gate, baselined, ercChecked: Boolean(erc) }, isError: !gate.pass };
  },
});

export type ViagridViolation = {
  kind: "via_off_grid" | "via_stacked" | "pad_near_hole" | "blank_incomplete";
  x: number;
  y: number;
  detail: string;
};

/** A via as `circuit_query vias` reports it: board frame (KiCad, outline top-left at the origin), mm. */
export interface ViagridVia {
  x: number;
  y: number;
  net: string;
  id?: string;
}
/** A pad as `circuit_query pads` reports it: centre and size in mm, board frame. */
export interface ViagridPad {
  x: number;
  y: number;
  width: number;
  height: number;
  component?: string;
  number?: string;
}

/**
 * Pure check behind `verify_viagrid`; exported for tests. Positions are in the board frame the
 * compile draws; they are moved into the blank's frame (centre origin, +y up) here.
 */
export function checkViagrid9055(board: { vias: ViagridVia[]; pads: ViagridPad[] }): {
  violations: ViagridViolation[];
  vias: { total: number; factory: number; claimed: number; added: number };
} {
  const violations: ViagridViolation[] = [];
  const holeKeepoutMm = VIAGRID_9055.holeDrillMm / 2 + 1.0;
  const nearHole = (x: number, y: number, halfWidth = 0, halfHeight = 0): boolean =>
    VIAGRID_9055_HOLES.some(([hx, hy]) => {
      const dx = Math.max(Math.abs(hx - x) - halfWidth, 0);
      const dy = Math.max(Math.abs(hy - y) - halfHeight, 0);
      return Math.hypot(dx, dy) < holeKeepoutMm;
    });
  let factory = 0;
  let claimed = 0;
  let added = 0;
  const taken = new Set<string>();
  const key = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;
  for (const v of board.vias) {
    const [x, y] = boardToViagrid(v.x, v.y);
    const label = v.id ? `via ${v.id}` : "via";
    if (isOnViagrid9055Via(x, y)) {
      const grid = VIAGRID_9055_VIAS.find(([vx, vy]) => Math.hypot(vx - x, vy - y) <= 0.05)!;
      const k = key(grid[0], grid[1]);
      if (taken.has(k)) {
        added += 1;
        violations.push({
          kind: "via_stacked",
          x,
          y,
          detail: `${label} at (${x.toFixed(2)}, ${y.toFixed(2)}) sits on a factory via that is already there (a via was added instead of claiming the blank's; route_unroute and route_run again)`,
        });
        continue;
      }
      taken.add(k);
      factory += 1;
      if (v.net) claimed += 1;
      continue;
    }
    added += 1;
    violations.push({
      kind: "via_off_grid",
      x,
      y,
      detail: `${label} at (${x.toFixed(2)}, ${y.toFixed(2)}) is not a factory via position${v.net ? ` (net ${v.net})` : ""}`,
    });
  }
  if (factory < VIAGRID_9055_VIAS.length)
    violations.push({
      kind: "blank_incomplete",
      x: 0,
      y: 0,
      detail: `the board has ${factory} of the blank's ${VIAGRID_9055_VIAS.length} factory vias: the blank was not drawn (build with the template set on a board without an outline)`,
    });
  for (const pad of board.pads) {
    const [x, y] = boardToViagrid(pad.x, pad.y);
    if (nearHole(x, y, pad.width / 2, pad.height / 2))
      violations.push({
        kind: "pad_near_hole",
        x,
        y,
        detail: `pad ${pad.component ?? "?"}:${pad.number ?? "?"} at (${x.toFixed(2)}, ${y.toFixed(2)}) is within ${holeKeepoutMm} mm of a mounting hole`,
      });
  }
  return { violations, vias: { total: board.vias.length, factory, claimed, added } };
}

export const verify_viagrid = defineTool({
  name: "verify_viagrid",
  toolset: "verify",
  title: "Check the Viagrid rules",
  description:
    "For a project on a Viagrid 9055 blank (project_set_board template=viagrid-9055): reads the vias and pads from the KiCad board on the design server and checks that every via is one of the blank's 180 factory vias (claimed by route_run, none added elsewhere or stacked on a factory via), that the whole blank is there, and that pads stay clear of the four mounting holes. Writes reports/viagrid.json. Run it after route_run and before verify_drc; positions in the report are in the blank's frame (centre origin, +y up).",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const template = project.manifest().board.template;
    const [vias, pads] = await Promise.all([
      ctx.services.design.query(project.dir, "vias"),
      ctx.services.design.query(project.dir, "pads"),
    ]);
    const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
    const result = checkViagrid9055({
      vias: vias.map((r) => ({
        x: num(r["x"]),
        y: num(r["y"]),
        net: String(r["net"] ?? ""),
        ...(r["id"] !== undefined ? { id: String(r["id"]) } : {}),
      })),
      pads: pads.map((r) => ({
        x: num(r["x"]),
        y: num(r["y"]),
        width: num(r["width"]),
        height: num(r["height"]),
        component: String(r["component"] ?? ""),
        number: String(r["number"] ?? ""),
      })),
    });
    await writeReport(project, "viagrid", {
      at: new Date().toISOString(),
      template: template ?? null,
      ...result,
    });
    const lines = [
      `${template === VIAGRID_9055.id ? "Viagrid 9055" : "Viagrid 9055 (template not set in fabdesk.json)"}: ${result.vias.factory} factory vias on the board, ${result.vias.claimed} claimed by routing, ${result.vias.added} added by the router.`,
      result.violations.length
        ? `${result.violations.length} violation(s):\n${result.violations.map((v) => `- [${v.kind}] ${v.detail}`).join("\n")}`
        : "No violations: every via is a factory via and pads clear the mounting holes.",
    ];
    return {
      text: lines.join("\n"),
      json: { template: template ?? null, ...result },
      isError: result.violations.length > 0,
    };
  },
});

export const verify_material = defineTool({
  name: "verify_material",
  toolset: "verify",
  title: "Check material rules",
  description:
    "Run laminate-specific checks on board.kicad_pcb: vias/pads in flex bend zones, plated holes or backside parts on metal-core, missing copper-core pedestals, and 50 Ω widths that do not match the chosen Dk/thickness. Writes reports/material.json.",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const board = project.manifest().board;
    const pcb = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(pcb))) throw new ToolError("board.kicad_pcb is missing", "precondition");
    const pcbText = await readFile(pcb, "utf8");
    const plan = planMaterialApply({
      ...(board.material ? { material: board.material } : {}),
      ...(board.construction ? { construction: board.construction } : {}),
      current: board,
      pcbText,
      ...(board.bendZones ? { bendZones: board.bendZones } : {}),
      ...(board.pedestalPads ? { pedestalPads: board.pedestalPads } : {}),
    });
    const violations = checkMaterialBoard(pcbText, plan);
    await writeReport(project, "material", {
      at: new Date().toISOString(),
      material: plan.material,
      construction: plan.construction,
      violations,
    });
    const title = materialCheckTitle(plan.material);
    const text = violations.length
      ? `${title}: ${violations.length} issue(s).\n${violations.map((v) => `- [${v.kind}] ${v.detail}`).join("\n")}`
      : `${title}: no issues.`;
    return { text, json: { material: plan.material, construction: plan.construction, violations }, isError: violations.length > 0 };
  },
});

export const verifyTools = [verify_erc, verify_gate, verify_viagrid, verify_material];
