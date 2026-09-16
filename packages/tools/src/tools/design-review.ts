/** One compact, revision-stable visual and electrical review after any authoring method. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, exists, readJsonOrNull } from "../fs";
import { defineTool, type ToolOutput } from "../registry";
import { verify_drc } from "./core";
import { ok, p, writeReport } from "./common";
import { render_view } from "./render";
import { schematic_inspect } from "./schematic";
import { verify_erc, verify_gate } from "./verify";

type Metrics = {
  symbols: number;
  nets: number;
  ercErrors: number;
  ercWarnings: number;
  drcErrors: number;
  drcWarnings: number;
  unconnected: number;
  parity: number;
};

async function identity(path: string): Promise<{ sha256: string; bytes: number } | null> {
  if (!(await exists(path))) return null;
  const data = await readFile(path);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function total(value: unknown): number {
  return Object.values(record(value)).reduce<number>((sum, count) => sum + number(count), 0);
}

function delta(current: Metrics, previous?: Metrics): Partial<Metrics> | null {
  if (!previous) return null;
  return Object.fromEntries(
    Object.entries(current).map(([key, value]) => [key, value - previous[key as keyof Metrics]]),
  ) as Partial<Metrics>;
}

export const design_review = defineTool({
  name: "design_review",
  toolset: "core",
  title: "See and check the current design",
  description:
    "Render the saved schematic and PCB, run revision-stable ERC, DRC, connectivity, schematic parity, and the release gate, and return one compact pass/fail result with deltas from the preceding review. It never changes native design files and treats an empty electrical model as a failure.",
  inputSchema: {
    render: z.enum(["both", "schematic", "pcb", "none"]).default("both"),
    maxWidth: z.number().int().min(320).max(2400).default(1200),
    limit: z.number().int().min(1).max(20).default(5),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async ({ render, maxWidth, limit }, ctx) => {
    const project = ctx.requireProject();
    const schematicPath = p(project, PROJECT_FILES.boardSch);
    const pcbPath = p(project, PROJECT_FILES.boardPcb);
    const before = {
      schematic: await identity(schematicPath),
      pcb: await identity(pcbPath),
    };
    const missing = [
      ...(!before.schematic ? [PROJECT_FILES.boardSch] : []),
      ...(!before.pcb ? [PROJECT_FILES.boardPcb] : []),
    ];
    if (missing.length) {
      const report = {
        at: new Date().toISOString(),
        pass: false,
        reasons: missing.map((file) => `${file} is missing`),
        revisions: { before, after: before, stable: true },
      };
      const reportPath = await writeReport(project, "design-review", report);
      return {
        ...ok(`Design review: FAIL\n${report.reasons.map((reason) => `- ${reason}`).join("\n")}`, {
          ...report,
          reportPath,
        }),
        isError: true,
      };
    }

    ctx.progress(0.05, "inspecting schematic");
    const schematic = await schematic_inspect.handler({ detail: "summary" }, ctx);
    const schematicJson = record(schematic.json);
    const schematicCounts = record(schematicJson["counts"]);

    const images: NonNullable<ToolOutput["images"]> = [];
    const renders: Record<string, unknown> = {};
    if (render === "both" || render === "schematic") {
      ctx.progress(0.15, "rendering schematic");
      const result = await render_view.handler({ document: "schematic", maxWidth }, ctx);
      renders["schematic"] = result.json;
      images.push(...(result.images ?? []));
    }
    if (render === "both" || render === "pcb") {
      ctx.progress(0.3, "rendering PCB");
      const result = await render_view.handler({ document: "pcb", maxWidth }, ctx);
      renders["pcb"] = result.json;
      images.push(...(result.images ?? []));
    }

    ctx.progress(0.5, "running ERC");
    const erc = await verify_erc.handler({ severity: "all", limit }, ctx);
    ctx.progress(0.65, "running DRC and parity");
    const drc = await verify_drc.handler({ severity: "all", schematicParity: true, limit }, ctx);
    ctx.progress(0.85, "evaluating release gate");
    const gate = await verify_gate.handler({ acceptWarnings: false, requireErc: true }, ctx);

    const ercJson = record(erc.json);
    const drcJson = record(drc.json);
    const gateJson = record(gate.json);
    const ercCounts = record(ercJson["counts"]);
    const drcCounts = record(drcJson["counts"]);
    const byRule = record(drcJson["byRule"]);
    const metrics: Metrics = {
      symbols: number(schematicCounts["symbols"]),
      nets: number(schematicCounts["nets"]),
      ercErrors: number(ercCounts["errors"]),
      ercWarnings: number(ercCounts["warnings"]),
      drcErrors: number(drcCounts["errors"]),
      drcWarnings: number(drcCounts["warnings"]),
      unconnected: number(drcCounts["unconnected"]),
      parity: total(byRule["schematicParity"]),
    };
    const meaningfulElectricalModel = metrics.symbols > 0 && metrics.nets > 0;
    const after = {
      schematic: await identity(schematicPath),
      pcb: await identity(pcbPath),
    };
    const revisionStable = JSON.stringify(before) === JSON.stringify(after);
    const reasons = [
      ...(!meaningfulElectricalModel
        ? [`electrical model is not meaningful (${metrics.symbols} symbols, ${metrics.nets} nets)`]
        : []),
      ...(metrics.ercErrors ? [`ERC has ${metrics.ercErrors} error(s)`] : []),
      ...(metrics.drcErrors ? [`DRC has ${metrics.drcErrors} error(s)`] : []),
      ...(metrics.unconnected ? [`PCB has ${metrics.unconnected} unconnected item(s)`] : []),
      ...(metrics.parity ? [`schematic/PCB parity has ${metrics.parity} finding(s)`] : []),
      ...(!revisionStable ? ["native files changed during review"] : []),
      ...(Array.isArray(gateJson["reasons"])
        ? (gateJson["reasons"] as unknown[]).map(String)
        : []),
    ];
    const uniqueReasons = [...new Set(reasons)];
    const pass =
      meaningfulElectricalModel &&
      revisionStable &&
      metrics.ercErrors === 0 &&
      metrics.drcErrors === 0 &&
      metrics.unconnected === 0 &&
      metrics.parity === 0 &&
      gateJson["pass"] === true;
    const previous = await readJsonOrNull<{ metrics?: Metrics }>(
      p(project, PROJECT_FILES.reports, "design-review.json"),
    );
    const report = {
      at: new Date().toISOString(),
      pass,
      reasons: uniqueReasons,
      meaningfulElectricalModel,
      metrics,
      delta: delta(metrics, previous?.metrics),
      revisions: { before, after, stable: revisionStable },
      renders,
      reports: {
        erc: p(project, PROJECT_FILES.reports, "erc.json"),
        drc: p(project, PROJECT_FILES.reports, "drc.json"),
        gate: p(project, PROJECT_FILES.reports, "gate.json"),
      },
      actionable: {
        erc: Array.isArray(ercJson["violations"])
          ? ercJson["violations"].slice(0, limit)
          : [],
        drc: Array.isArray(drcJson["violations"])
          ? drcJson["violations"].slice(0, limit)
          : [],
        unconnected: Array.isArray(drcJson["unconnected"])
          ? drcJson["unconnected"].slice(0, limit)
          : [],
        parity: Array.isArray(drcJson["schematicParity"])
          ? drcJson["schematicParity"].slice(0, limit)
          : [],
      },
    };
    const reportPath = await writeReport(project, "design-review", report);
    ctx.progress(1, pass ? "review passed" : "review failed");
    const summary = [
      `Design review: ${pass ? "PASS" : "FAIL"}`,
      `Schematic: ${metrics.symbols} symbols, ${metrics.nets} nets; ERC ${metrics.ercErrors} errors/${metrics.ercWarnings} warnings`,
      `PCB: DRC ${metrics.drcErrors} errors/${metrics.drcWarnings} warnings, ${metrics.unconnected} unconnected, ${metrics.parity} parity findings`,
      ...(report.delta ? [`Delta from previous review: ${JSON.stringify(report.delta)}`] : []),
      ...uniqueReasons.map((reason) => `- ${reason}`),
      `Full evidence: ${reportPath}`,
    ].join("\n");
    return {
      ...ok(summary, { ...report, reportPath }, images.length ? { images } : {}),
      isError: !pass,
    };
  },
});

export const designReviewTools = [design_review];
