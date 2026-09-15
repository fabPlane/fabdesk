/** Native KiCad schematic-first authoring and forward annotation. */
import { z } from "zod/v4";
import { defineTool } from "../registry";
import { ok, table, writeReport } from "./common";

const Point = z.object({
  x: z.number().finite().describe("Schematic X coordinate in millimetres"),
  y: z.number().finite().describe("Schematic Y coordinate in millimetres"),
});

export const schematic_inspect = defineTool({
  name: "schematic_inspect",
  toolset: "circuit",
  title: "Inspect native schematic",
  description:
    "Inspect board.kicad_sch as KiCad currently holds it: symbols, absolute pin coordinates, wires, labels, connectivity, and live ERC counts.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const snapshot = await ctx.services.design.schematicInspect(project.dir);
    const symbols = snapshot.symbols.map((symbol) => ({
      ref: symbol.reference,
      value: symbol.value,
      symbol: symbol.libId,
      footprint: symbol.footprint,
      at: `${symbol.position.x},${symbol.position.y}`,
      pins: symbol.pins
        .map(
          (pin) =>
            `${pin.number}${pin.name ? `/${pin.name}` : ""}@${pin.position.x},${pin.position.y}`,
        )
        .join(" "),
    }));
    const text = [
      `Native schematic revision ${snapshot.revision}: ${snapshot.symbols.length} symbols, ${snapshot.wires.length} wires, ${snapshot.localLabels.length} local labels, ${snapshot.globalLabels.length} global labels, ${snapshot.junctions.length} junctions, ${snapshot.noConnects.length} no-connects, ${snapshot.texts.length} notes, ${snapshot.nets.length} nets.`,
      `ERC: ${snapshot.erc.errors} errors, ${snapshot.erc.warnings} warnings.`,
      ...(symbols.length
        ? [table(symbols)]
        : ["No symbols yet."]),
    ].join("\n\n");
    return ok(text, snapshot);
  },
});

export const schematic_edit = defineTool({
  name: "schematic_edit",
  toolset: "circuit",
  title: "Edit native schematic",
  description:
    "Apply one undoable edit batch directly to board.kicad_sch. Supports rotated or mirrored library symbols, symbol movement, safely labelled pin stubs, explicit wires, local and global labels, junctions, no-connect markers, notes, and deletion by inspected ID. Creates native KiCad files when absent. Coordinates are millimetres on KiCad's 1.27 mm schematic grid.",
  inputSchema: {
    symbols: z
      .array(
        z.object({
          libId: z.string().min(3).describe("Exact KiCad symbol ID, such as Device:R"),
          reference: z.string().min(1).describe("Unique annotated reference, such as R1"),
          value: z.string(),
          footprint: z.string().min(3).describe("Exact KiCad footprint ID"),
          position: Point,
          unit: z.number().int().positive().optional(),
          bodyStyle: z.number().int().positive().optional(),
          rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
          mirrorX: z.boolean().default(false),
          mirrorY: z.boolean().default(false),
          fields: z.record(z.string(), z.string()).optional(),
        }),
      )
      .max(200)
      .default([]),
    symbolUpdates: z
      .array(
        z.object({
          reference: z.string().min(1),
          newReference: z.string().min(1).optional(),
          position: Point.optional(),
          value: z.string().optional(),
          footprint: z.string().min(3).optional(),
          fields: z.record(z.string(), z.string()).optional(),
        }),
      )
      .max(200)
      .default([]),
    connections: z
      .array(
        z.object({
          name: z.string().min(1).describe("Electrical net name"),
          nodes: z
            .array(z.object({ reference: z.string().min(1), pin: z.string().min(1) }))
            .min(2)
            .describe("Symbol pin endpoints joined electrically by matching labels on short visible wire stubs"),
          label: z.enum(["local", "global", "none"]).default("local"),
        }),
      )
      .max(500)
      .default([]),
    wires: z
      .array(z.object({ start: Point, end: Point }))
      .max(1000)
      .default([]),
    localLabels: z
      .array(z.object({ text: z.string().min(1), position: Point }))
      .max(500)
      .default([]),
    globalLabels: z
      .array(z.object({ text: z.string().min(1), position: Point }))
      .max(500)
      .default([]),
    junctions: z.array(Point).max(1000).default([]),
    noConnects: z.array(Point).max(1000).default([]),
    texts: z
      .array(z.object({ text: z.string().min(1), position: Point }))
      .max(200)
      .default([]),
    deleteItemIds: z.array(z.string().min(1)).max(1000).default([]),
    save: z.boolean().default(true),
  },
  annotations: { idempotentHint: false },
  handler: async (edit, ctx) => {
    const project = ctx.requireProject();
    const result = await ctx.services.design.schematicEdit(project.dir, edit);
    return ok(
      `Native schematic revision ${result.revision}: created ${result.created.symbols} symbols, ${result.created.wires} wires, ${result.created.localLabels} local/${result.created.globalLabels} global labels, ${result.created.junctions} junctions, ${result.created.noConnects} no-connects and ${result.created.texts} notes; updated ${result.updated.symbols} symbols; deleted ${result.deleted} items; ${result.saved ? "saved" : "left in memory"}.`,
      result,
    );
  },
});

export const schematic_review = defineTool({
  name: "schematic_review",
  toolset: "circuit",
  title: "Review schematic quality",
  description:
    "Review the native schematic for presentation and maintainability findings: missing footprints, duplicate references, excessive global labels, absent notes on non-trivial designs, off-grid placement and cramped symbol layout. Writes reports/schematic-review.json without changing native files.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const snapshot = await ctx.services.design.schematicInspect(project.dir);
    const findings: Array<{ code: string; severity: "warning" | "info"; message: string }> = [];
    const references = new Map<string, number>();
    for (const symbol of snapshot.symbols) {
      references.set(symbol.reference, (references.get(symbol.reference) ?? 0) + 1);
      if (!symbol.footprint && !symbol.libId.startsWith("power:"))
        findings.push({ code: "missing-footprint", severity: "warning", message: `${symbol.reference} has no footprint assignment.` });
      const gridError = [symbol.position.x, symbol.position.y].some(
        (coordinate) => Math.abs(coordinate / 1.27 - Math.round(coordinate / 1.27)) > 0.02,
      );
      if (gridError)
        findings.push({ code: "off-grid-symbol", severity: "warning", message: `${symbol.reference} is off the 1.27 mm schematic grid at ${symbol.position.x},${symbol.position.y}.` });
    }
    for (const [reference, count] of references)
      if (count > 1)
        findings.push({ code: "duplicate-reference", severity: "warning", message: `${reference} occurs ${count} times.` });
    if (snapshot.symbols.length >= 5 && snapshot.texts.length === 0)
      findings.push({ code: "missing-notes", severity: "info", message: "No functional-block notes, interface constraints, or design calculations are present." });
    if (snapshot.globalLabels.length > Math.max(2, snapshot.localLabels.length))
        findings.push({ code: "global-label-overuse", severity: "warning", message: `${snapshot.globalLabels.length} global labels versus ${snapshot.localLabels.length} local labels.` });
    if (snapshot.symbols.length >= 6 && snapshot.junctions.length === 0)
        findings.push({ code: "no-junctions", severity: "info", message: "No explicit junctions appear in a non-trivial schematic." });
    const labels = [...snapshot.localLabels, ...snapshot.globalLabels];
    for (let left = 0; left < labels.length; left++)
      for (let right = left + 1; right < labels.length; right++) {
        const a = labels[left]!, b = labels[right]!;
        if (Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) < 2.54)
          findings.push({ code: "label-collision", severity: "warning", message: `Labels ${a.text} and ${b.text} are less than 2.54 mm apart.` });
      }
    if (snapshot.symbols.length >= 5 && snapshot.wires.length === 0 && labels.length >= snapshot.symbols.length)
      findings.push({ code: "label-only-connectivity", severity: "warning", message: "Connectivity is label-only; add short visible pin stubs or functional-block wiring for readability." });
    const xs = snapshot.symbols.map((symbol) => symbol.position.x);
    const ys = snapshot.symbols.map((symbol) => symbol.position.y);
    const extent = xs.length
      ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
      : null;
    if (extent && snapshot.symbols.length >= 5 && extent.maxX - extent.minX < 35 && extent.maxY - extent.minY < 35)
      findings.push({ code: "cramped-layout", severity: "info", message: "Symbols occupy a sub-35 mm area, which may obscure functional blocks and signal flow." });
    const review = {
      at: new Date().toISOString(),
      revision: snapshot.revision,
      counts: {
        symbols: snapshot.symbols.length,
        wires: snapshot.wires.length,
        localLabels: snapshot.localLabels.length,
        globalLabels: snapshot.globalLabels.length,
        junctions: snapshot.junctions.length,
        noConnects: snapshot.noConnects.length,
        notes: snapshot.texts.length,
      },
      extent,
      erc: snapshot.erc,
      findings,
    };
    await writeReport(project, "schematic-review", review);
    return ok(
      `Schematic review at revision ${snapshot.revision}: ${findings.length} finding(s), ERC ${snapshot.erc.errors} errors/${snapshot.erc.warnings} warnings.${findings.length ? `\n${findings.map((finding) => `- [${finding.severity}] ${finding.code}: ${finding.message}`).join("\n")}` : "\nNo presentation risks detected by the current checks."}`,
      review,
    );
  },
});

export const pcb_update_from_schematic = defineTool({
  name: "pcb_update_from_schematic",
  toolset: "circuit",
  title: "Update PCB from schematic",
  description:
    "Run KiCad's native Update PCB from Schematic. Always saves and ERC-checks board.kicad_sch, then performs a dry-run update. With apply=false it only previews the report. With apply=true it updates board.kicad_pcb, requires zero PCB↔schematic parity conflicts, and saves only on success. ERC errors always block the board update. Board-only footprints are preserved by default.",
  inputSchema: {
    apply: z
      .boolean()
      .default(false)
      .describe("False previews; true applies and saves after parity passes"),
  },
  annotations: { idempotentHint: true },
  longRunning: true,
  handler: async ({ apply }, ctx) => {
    const project = ctx.requireProject();
    ctx.progress(0.2, "ERC");
    const result = await ctx.services.design.syncSchematicToPcb(project.dir, !apply);
    await writeReport(project, "schematic-sync", { at: new Date().toISOString(), ...result });
    ctx.progress(1, result.ok ? "done" : "blocked");
    const mode = apply ? "Update" : "Preview";
    const text = [
      `${mode}: ${result.ok ? "OK" : "BLOCKED"}.`,
      `ERC: ${result.erc.errors} errors, ${result.erc.warnings} warnings.`,
      `Board update: ${result.update.errors} errors, ${result.update.warnings} warnings, ${result.update.newFootprints} new footprints.`,
      ...(result.parity !== undefined ? [`Schematic parity: ${result.parity} conflicts.`] : []),
      result.saved
        ? "Native schematic and PCB saved."
        : apply
          ? "PCB was not saved."
          : "Preview made no PCB changes.",
      ...(result.update.report ? [`Report:\n${result.update.report}`] : []),
    ].join("\n");
    return { text, json: result, isError: !result.ok };
  },
});

export const schematicTools = [schematic_inspect, schematic_edit, schematic_review, pcb_update_from_schematic];
