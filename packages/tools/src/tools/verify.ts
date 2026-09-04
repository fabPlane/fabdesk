/** Verify toolset: ERC and the release gate (kicad-automation semantics). */
import { z } from "zod/v4";
import { PROJECT_FILES, readJsonOrNull, writeJson } from "../fs";
import { ToolError, defineTool } from "../registry";
import type { DrcReport, ErcReport } from "../services";
import { VIAGRID_9055, VIAGRID_9055_HOLES, isOnViagrid9055Via } from "../templates/viagrid-9055";
import { describeViolation } from "./core";
import { loadCircuitJson, ok, p, requireKicad, requireSchematic, writeReport } from "./common";

export const verify_erc = defineTool({
  name: "verify_erc",
  toolset: "verify",
  title: "Run KiCad ERC",
  description: "Run KiCad electrical rule check on board.kicad_sch, write reports/erc.json and return counts plus the first violations. Requires kicad-cli and a converted schematic (kicad_convert).",
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

export interface ViagridViolation {
  kind: "via_off_grid" | "via_near_hole" | "pad_near_hole" | "via_shorts_nets";
  x: number;
  y: number;
  detail: string;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Nets whose copper touches each factory via. A factory via is copper on both layers, so two nets touching
 * the same one (a top wire over it and a bottom wire under it, say) are shorted through the blank.
 */
function netsTouchingVias(els: Array<Record<string, unknown>>, vias: Array<{ id: string; x: number; y: number; r: number }>): Map<string, Set<string>> {
  const touched = new Map<string, Set<string>>();
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
  for (const el of els) {
    if (el["type"] !== "pcb_trace" || !Array.isArray(el["route"])) continue;
    const net = String(el["subcircuit_connectivity_map_key"] ?? el["source_trace_id"] ?? el["pcb_trace_id"]);
    const route = el["route"] as Array<Record<string, unknown>>;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]!;
      const b = route[i]!;
      if (a["route_type"] !== "wire" || b["route_type"] !== "wire" || a["layer"] !== b["layer"]) continue;
      const half = (num(b["width"]) || 0) / 2;
      for (const via of vias) {
        if (distanceToSegment(via.x, via.y, num(a["x"]), num(a["y"]), num(b["x"]), num(b["y"])) <= via.r + half - 1e-6) {
          let set = touched.get(via.id);
          if (!set) touched.set(via.id, (set = new Set()));
          set.add(net);
        }
      }
    }
    for (const p of route) {
      if (p["route_type"] !== "via") continue;
      for (const via of vias) {
        if (Math.hypot(via.x - num(p["x"]), via.y - num(p["y"])) <= 0.05) {
          let set = touched.get(via.id);
          if (!set) touched.set(via.id, (set = new Set()));
          set.add(net);
        }
      }
    }
  }
  return touched;
}

/** Pure check behind `verify_viagrid`; exported for tests. */
export function checkViagrid9055(circuitJson: unknown[]): { violations: ViagridViolation[]; vias: { total: number; factory: number; claimed: number; added: number } } {
  const els = circuitJson as Array<Record<string, unknown>>;
  const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
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
  const factoryVias: Array<{ id: string; x: number; y: number; r: number }> = [];
  for (const el of els) {
    if (el["type"] !== "pcb_via") continue;
    const x = num(el["x"]);
    const y = num(el["y"]);
    if (el["net_is_assignable"] === true && isOnViagrid9055Via(x, y)) {
      factory += 1;
      if (el["net_assigned"] === true) claimed += 1;
      factoryVias.push({ id: String(el["pcb_via_id"] ?? `${x},${y}`), x, y, r: (num(el["outer_diameter"]) || VIAGRID_9055.viaPadMm) / 2 });
      continue;
    }
    added += 1;
    if (isOnViagrid9055Via(x, y)) {
      violations.push({ kind: "via_off_grid", x, y, detail: `via ${String(el["pcb_via_id"] ?? "")} sits on a factory via but was added as a new via (routing was merged without claiming; re-run route_run)` });
    } else {
      violations.push({ kind: "via_off_grid", x, y, detail: `via ${String(el["pcb_via_id"] ?? "")} at (${x.toFixed(2)}, ${y.toFixed(2)}) is not a factory via position` });
    }
  }
  for (const [id, nets] of netsTouchingVias(els, factoryVias)) {
    if (nets.size < 2) continue;
    const via = factoryVias.find((v) => v.id === id)!;
    violations.push({ kind: "via_shorts_nets", x: via.x, y: via.y, detail: `factory via ${id} at (${via.x}, ${via.y}) is touched by ${nets.size} nets (${[...nets].join(", ")}): the blank's via joins them` });
  }
  for (const el of els) {
    if (el["type"] === "pcb_smtpad" || el["type"] === "pcb_plated_hole") {
      const x = num(el["x"]);
      const y = num(el["y"]);
      const halfWidth = num(el["width"] ?? el["rect_pad_width"] ?? 0) / 2;
      const halfHeight = num(el["height"] ?? el["rect_pad_height"] ?? 0) / 2;
      if (nearHole(x, y, halfWidth, halfHeight)) violations.push({ kind: "pad_near_hole", x, y, detail: `${String(el["type"])} ${String(el["pcb_smtpad_id"] ?? el["pcb_plated_hole_id"] ?? "")} at (${x.toFixed(2)}, ${y.toFixed(2)}) is within ${holeKeepoutMm} mm of a mounting hole` });
    }
  }
  return { violations, vias: { total: factory + added, factory, claimed, added } };
}

export const verify_viagrid = defineTool({
  name: "verify_viagrid",
  toolset: "verify",
  title: "Check the Viagrid rules",
  description:
    "For a project on a Viagrid 9055 blank (project_set_board template=viagrid-9055): every via in circuit.routed.json must be one of the blank's 180 factory vias (claimed by the router), no via may be added anywhere else, and pads must stay clear of the four mounting holes. Writes reports/viagrid.json. Run it after route_run and before kicad_convert.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const template = project.manifest().board.template;
    const { circuitJson, source } = await loadCircuitJson(project, { preferRouted: true });
    const result = checkViagrid9055(circuitJson);
    await writeReport(project, "viagrid", { at: new Date().toISOString(), source, template: template ?? null, ...result });
    const lines = [
      `${template === "viagrid-9055" ? "Viagrid 9055" : "Viagrid 9055 (template not set in fabdesk.json)"}: ${result.vias.factory} factory vias in ${source}, ${result.vias.claimed} claimed by routing, ${result.vias.added} added by the router.`,
      result.violations.length ? `${result.violations.length} violation(s):\n${result.violations.map((v) => `- [${v.kind}] ${v.detail}`).join("\n")}` : "No violations: every via is a factory via and pads clear the mounting holes.",
    ];
    return { text: lines.join("\n"), json: { source, template: template ?? null, ...result }, isError: result.violations.length > 0 };
  },
});

export const verifyTools = [verify_erc, verify_gate, verify_viagrid];
