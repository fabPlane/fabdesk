/** Sim toolset: SPICE netlist and simulation. */
import { readFile } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, ensureDir } from "../fs";
import { defineTool, ToolError } from "../registry";
import type { SimAnalysis } from "../services";
import { ok, p, requireKicad, requireSchematic, table, writeReport } from "./common";

export const sim_spice_netlist = defineTool({
  name: "sim_spice_netlist",
  toolset: "sim",
  title: "Generate SPICE netlist",
  description: "Export a SPICE netlist from the saved native schematic to exports/circuit.cir and return it.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    await ensureDir(p(project, PROJECT_FILES.exports));
    const output = p(project, PROJECT_FILES.exports, "circuit.cir");
    await ctx.services.kicad.exportNetlist(cli, { schematic, output, format: "spice", signal: ctx.signal });
    const netlist = await readFile(output, "utf8");
    return ok(`SPICE netlist (${PROJECT_FILES.exports}/circuit.cir):\n\`\`\`\n${netlist}\n\`\`\``, { path: output, netlist });
  },
});

export const sim_run = defineTool({
  name: "sim_run",
  toolset: "sim",
  title: "Run SPICE simulation",
  description:
    "Export the saved native schematic to SPICE and simulate it: op, tran, or ac. Engine spicey is bundled; ngspice requires an available binary. Writes reports/spice.json and returns node voltages or branch currents.",
  inputSchema: {
    analysis: z.enum(["op", "tran", "ac"]).default("op"),
    engine: z.enum(["spicey", "ngspice"]).default("spicey"),
    stopS: z.number().positive().optional().describe("tran: stop time in seconds"),
    stepS: z.number().positive().optional().describe("tran: step in seconds"),
    startHz: z.number().positive().optional().describe("ac: start frequency"),
    stopHz: z.number().positive().optional().describe("ac: stop frequency"),
    points: z.number().int().positive().optional().describe("ac: points per decade"),
    limit: z.number().int().min(1).max(500).default(40).describe("Rows in the text summary"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async ({ analysis, engine, stopS, stepS, startHz, stopHz, points, limit }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    await ensureDir(p(project, PROJECT_FILES.exports));
    const exported = p(project, PROJECT_FILES.exports, "circuit.cir");
    await ctx.services.kicad.exportNetlist(cli, { schematic, output: exported, format: "spice", signal: ctx.signal });
    const netlist = await readFile(exported, "utf8");
    let an: SimAnalysis;
    if (analysis === "op") an = { type: "op" };
    else if (analysis === "tran") {
      if (!stopS) throw new ToolError("tran analysis needs stopS", "invalid_args");
      an = { type: "tran", stopS, ...(stepS ? { stepS } : {}) };
    } else {
      if (!startHz || !stopHz) throw new ToolError("ac analysis needs startHz and stopHz", "invalid_args");
      an = { type: "ac", startHz, stopHz, ...(points ? { points } : {}) };
    }
    let ngspicePath: string | undefined;
    if (engine === "ngspice") {
      const found = await ctx.services.sim.findNgspice(ctx.services.settings().ngspicePath);
      if (!found) throw new ToolError("ngspice not found; install it, set Settings.ngspicePath, or use engine=spicey", "unavailable");
      ngspicePath = found;
    }
    ctx.progress(0.2, `running ${analysis} (${engine})`);
    const result = await ctx.services.sim.runSpiceSimulation({ netlist, analysis: an, engine, ...(ngspicePath ? { ngspicePath } : {}), signal: ctx.signal });
    await writeReport(project, "spice", { at: new Date().toISOString(), ...result });
    ctx.progress(1, "done");
    const rows = result.rows.slice(0, limit).map((r) => Object.fromEntries(result.columns.map((c, i) => [c, fmt(r[i])])));
    const text = [`${result.analysis} via ${result.engine} in ${Math.round(result.durationMs)} ms; ${result.rows.length} row(s)${result.rows.length > limit ? ` (showing ${limit})` : ""}`, table(rows, result.columns), ...(result.notes ?? [])].join("\n");
    return ok(text, result);
  },
});

function fmt(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return "";
  if (v === 0) return "0";
  const a = Math.abs(v);
  return a >= 1e-3 && a < 1e6 ? Number(v.toPrecision(5)).toString() : v.toExponential(3);
}

export const simTools = [sim_spice_netlist, sim_run];
