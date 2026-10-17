/** Native KiCad schematic-first authoring and forward annotation. */
import { z } from "zod/v4";
import { ToolError, defineTool, mutationInputObject } from "../registry";
import { selectSchematic } from "./schematic-selection";
import { compactHierarchy, inspectSavedHierarchy, ok, table, writeReport } from "./common";
import {
  formatKicadIpcSessionDiagnostics,
  kicadIpcSessionDiagnostics,
} from "./diagnostic-evidence";

const Point = mutationInputObject({
  x: z.number().finite().describe("Schematic X coordinate in millimetres"),
  y: z.number().finite().describe("Schematic Y coordinate in millimetres"),
});

export const schematic_inspect = defineTool({
  name: "schematic_inspect",
  toolset: "circuit",
  title: "Inspect native schematic",
  description:
    "Inspect selected native schematic objects using the union of references, netNames and objectIds; optional expand=nets includes their connected electrical objects. Pins are absolute sheet millimetres. Reuse wire.start/end and label.position in schematic_edit; junctions use junction.position as {x,y}, deleteItemIds uses object.id. Inspect-to-edit: {junctions:[result.junctions[0].position],deleteItemIds:[result.wires[0].id],sheet:result.scope.identity}. Selectors request object detail even with summary. Inspect the complete saved native schematic hierarchy. The default is a compact packaged-KiCad project summary; request authoring or full for bounded live KiCad IPC details on the root/current or one selected sheet. Live session diagnostics include issue descriptions, itemIds and danglingItemIds (up to 200 issues; issueCount reports the total) and are never presented as saved-file ERC.",
  inputSchema: {
    detail: z
      .enum(["summary", "authoring", "full"])
      .default("summary")
      .describe(
        "summary=count/check overview; authoring=symbols and pins; full=all wires, labels, nets and deletion IDs",
      ),
    sheet: z
      .string()
      .min(1)
      .optional()
      .describe(
        "For authoring/full detail, select inspected scope.identity (uuid:path), or one unambiguous hierarchy path, sheet name, or native filename",
      ),
    references: z
      .array(z.string().min(1))
      .max(200)
      .default([])
      .describe("Component references on selected sheet; union with netNames and objectIds"),
    netNames: z
      .array(z.string().min(1))
      .max(200)
      .default([])
      .describe("Exact project net names; includes connected physical objects on selected sheet"),
    objectIds: z
      .array(z.string().min(1))
      .max(1000)
      .default([])
      .describe("Inspected native IDs on selected sheet; union with other selectors"),
    kinds: z
      .array(z.enum(["symbols", "pins", "wires", "labels", "junctions", "noConnects", "texts"]))
      .default(["symbols", "pins", "wires", "labels", "junctions", "noConnects", "texts"]),
    expand: z
      .enum(["none", "nets"])
      .default("none")
      .describe(
        "nets includes complete electrical nets of reference/ID seeds on the selected sheet, without adding other pins of connected symbols",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe(
        "Native object budget including pins/containers. Default: 1000 for targeted calls; unlimited for untargeted full/authoring calls. Explicit limits report truncation",
      ),
    sheetOffset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("First hierarchy summary sheet to return"),
    sheetLimit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(25)
      .describe("Maximum per-sheet summary rows"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (
    {
      detail,
      sheet,
      sheetOffset,
      sheetLimit,
      references,
      netNames,
      objectIds,
      kinds,
      expand,
      limit,
    },
    ctx,
  ) => {
    const project = ctx.requireProject();
    const hierarchy = await inspectSavedHierarchy(ctx, project);
    const hierarchyResult = compactHierarchy(hierarchy, sheetOffset, sheetLimit);
    const targeted = references.length + netNames.length + objectIds.length > 0;
    if (detail === "summary" && !targeted) {
      const text = `Complete saved hierarchy ${hierarchy.complete ? "COMPLETE" : "INCOMPLETE"} at ${hierarchy.aggregateRevision}: ${hierarchy.counts.components} components, ${hierarchy.counts.nets} nets, ${hierarchy.counts.sheets} sheets; ${hierarchy.orphanFiles.length} orphan schematic file(s). Evidence: packaged-kicad-cli saved-file netlist; no live IPC authoring details requested.`;
      return {
        text,
        json: {
          contract: { name: "fabdesk.schematic-inspection", version: "4.0.0" },
          scope: "complete-saved-hierarchy",
          hierarchy: hierarchyResult,
        },
        isError: !hierarchy.complete,
      };
    }
    const source = await ctx.services.design.schematicInspect(project.dir, sheet);
    const selection = selectSchematic(source, {
      references,
      netNames,
      objectIds,
      kinds:
        detail === "authoring" && !targeted
          ? kinds.filter((k) => k === "symbols" || k === "pins")
          : kinds,
      expand,
      limit: limit ?? (targeted ? 1000 : null),
    });
    const snapshot = { ...source, ...selection };
    const coordinates = {
      units: "mm",
      gridSpacing: 1.27,
      origin: "sheet top-left",
      xAxis: "right",
      yAxis: "down",
      pinPosition: "absolute sheet coordinates, including rotation and mirroring",
    };

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
      `${snapshot.scope?.kind ?? "current/root-sheet"} authoring detail for ${snapshot.scope?.hierarchyPath ?? "/"}, live KiCad IPC revision ${snapshot.revision}: ${source.symbols.length} symbols, ${source.wires.length} wires, ${source.localLabels.length} local labels, ${source.globalLabels.length} global labels, ${source.junctions.length} junctions, ${source.noConnects.length} no-connects, ${source.texts.length} notes, ${source.nets.length} project-wide live nets (sheet totals; selected objects below). Complete saved hierarchy: ${hierarchy.counts.components} components, ${hierarchy.counts.nets} nets, ${hierarchy.counts.sheets} sheets at ${hierarchy.aggregateRevision} (${hierarchy.complete ? "complete" : "incomplete"}).`,
      `Selected ${snapshot.selection.returned}/${snapshot.selection.matched} native objects${snapshot.selection.truncated ? " (TRUNCATED; raise limit before editing omitted objects)" : ""}.`,
      formatKicadIpcSessionDiagnostics(snapshot.erc),
      ...(symbols.length ? [table(symbols)] : ["No symbols yet."]),
    ].join("\n\n");
    const counts = {
      symbols: source.symbols.length,
      wires: source.wires.length,
      localLabels: source.localLabels.length,
      globalLabels: source.globalLabels.length,
      junctions: source.junctions.length,
      noConnects: source.noConnects.length,
      notes: source.texts.length,
      projectNets: source.nets.length,
    };
    const sessionDiagnostics = kicadIpcSessionDiagnostics(snapshot.erc);
    const contract = { name: "fabdesk.schematic-inspection", version: "4.0.0" } as const;
    const compact = {
      contract,
      scope: snapshot.scope ?? {
        kind: "current/root-sheet",
        hierarchyPath: "/",
        nativePath: null,
        name: "root",
      },
      hierarchy: hierarchyResult,
      coordinates,
      selection: snapshot.selection,
      revision: snapshot.revision,
      pcbRevision: snapshot.pcbRevision,
      netScope: targeted
        ? ("selected-sheet-projection" as const)
        : ("bounded-live-ipc-session" as const),
      counts,
      sessionDiagnostics,
    };
    const { erc: _sessionErc, ...fullSnapshot } = snapshot;
    return ok(
      text,
      detail === "full" || targeted
        ? {
            contract,
            ...fullSnapshot,
            coordinates,
            hierarchy: hierarchyResult,
            counts,
            netScope: targeted
              ? ("selected-sheet-projection" as const)
              : ("bounded-live-ipc-session" as const),
            sessionDiagnostics,
          }
        : { ...compact, symbols: snapshot.symbols },
    );
  },
});

export const schematic_edit = defineTool({
  name: "schematic_edit",
  toolset: "circuit",
  title: "Edit native schematic",
  description:
    "Apply one undoable edit batch directly to board.kicad_sch. Multi-unit parts share reference/libId/value/footprint with distinct unit numbers; place every required unit, including power units. Use symbolUpdates {reference,unit} for a placed unit or deleteItemIds from schematic_inspect to replace it. Supports rotated or mirrored library symbols, symbol movement, safely labelled pin stubs, explicit wires, local and global labels, junctions, no-connect markers, notes, and deletion by inspected ID. Creates native KiCad files when absent. Coordinates are absolute sheet millimetres, origin top-left, +X right, +Y down, on KiCad's 1.27 mm grid. Off-grid arguments are preserved and reported as gridProblems. Each batch uses one commit; changedObjectIds and revision describe the applied result.",
  inputSchema: {
    sheet: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Select inspected scope.identity (uuid:path), or an unambiguous hierarchy path/name/native filename; default root",
      ),
    symbols: z
      .array(
        mutationInputObject({
          libId: z.string().min(3).describe("Exact KiCad symbol ID, such as Device:R"),
          reference: z
            .string()
            .min(1)
            .describe("Annotated reference; distinct units of one part share it, such as U1"),
          value: z.string(),
          footprint: z
            .union([z.literal(""), z.string().min(3)])
            .optional()
            .describe(
              "Exact KiCad footprint ID; omit or use an empty string for non-physical symbols such as power flags",
            ),
          position: Point,
          unit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Library unit number; repeat reference with distinct units, including power units",
            ),
          bodyStyle: z.number().int().positive().optional(),
          rotation: z
            .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
            .default(0),
          mirrorX: z.boolean().default(false),
          mirrorY: z.boolean().default(false),
          fields: z.record(z.string(), z.string()).optional(),
        }),
      )
      .max(200)
      .default([]),
    symbolUpdates: z
      .array(
        mutationInputObject({
          reference: z.string().min(1),
          unit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Select one unit when the reference has multiple placed units"),
          newReference: z.string().min(1).optional(),
          position: Point.optional(),
          rotation: z
            .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
            .optional(),
          mirrorX: z.boolean().optional(),
          mirrorY: z.boolean().optional(),
          value: z.string().optional(),
          footprint: z.union([z.literal(""), z.string().min(3)]).optional(),
          fields: z.record(z.string(), z.string()).optional(),
        }),
      )
      .max(200)
      .default([]),
    connections: z
      .array(
        mutationInputObject({
          name: z.string().min(1).describe("Electrical net name"),
          nodes: z
            .array(mutationInputObject({ reference: z.string().min(1), pin: z.string().min(1) }))
            .min(1)
            .describe(
              "Symbol pin endpoints joined electrically by matching labels on short visible wire stubs",
            ),
          label: z.enum(["local", "global", "none"]).default("local"),
        }).refine((connection) => connection.label !== "none" || connection.nodes.length >= 2, {
          message: "direct wire connections require at least two nodes",
          path: ["nodes"],
        }),
      )
      .max(500)
      .default([]),
    wires: z
      .array(mutationInputObject({ start: Point, end: Point }))
      .max(1000)
      .default([]),
    localLabels: z
      .array(mutationInputObject({ text: z.string().min(1), position: Point }))
      .max(500)
      .default([]),
    globalLabels: z
      .array(mutationInputObject({ text: z.string().min(1), position: Point }))
      .max(500)
      .default([]),
    junctions: z.array(Point).max(1000).default([]),
    noConnects: z.array(Point).max(1000).default([]),
    texts: z
      .array(mutationInputObject({ text: z.string().min(1), position: Point }))
      .max(200)
      .default([]),
    deleteItemIds: z.array(z.string().min(1)).max(1000).default([]),
    save: z.boolean().default(true),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async (edit, ctx) => {
    const project = ctx.requireProject();
    for (const symbol of edit.symbols) {
      if (
        !symbol.footprint ||
        !/usb[_ -]?c|type[_ -]?c/i.test(`${symbol.libId} ${symbol.footprint}`)
      )
        continue;
      const compatibility = await ctx.services.design.checkPartCompatibility(
        symbol.libId,
        symbol.footprint,
        "power-only-usb-c",
      );
      if (!compatibility.compatible)
        throw new ToolError(
          `incompatible USB-C symbol/footprint ${symbol.libId} + ${symbol.footprint}: ${compatibility.issues.join("; ")}`,
          "invalid_args",
        );
    }
    const reported = await ctx.services.design.schematicEdit(project.dir, edit);
    return ok(
      `Native schematic revision ${reported.revision}: created ${reported.created.symbols} symbols, ${reported.created.wires} wires, ${reported.created.localLabels} local/${reported.created.globalLabels} global labels, ${reported.created.junctions} junctions, ${reported.created.noConnects} no-connects and ${reported.created.texts} notes; updated ${reported.updated.symbols} symbols; deleted ${reported.deleted} items; ${reported.saved ? "saved" : "left in memory"}.`,
      reported,
    );
  },
});

export const schematic_review = defineTool({
  name: "schematic_review",
  toolset: "circuit",
  title: "Review schematic quality",
  description:
    "Review one explicitly scoped live KiCad sheet for presentation and maintainability findings, while binding the report to the complete saved hierarchy revision. Writes reports/schematic-review.json without changing native files.",
  inputSchema: {
    sheet: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Hierarchy path, sheet name, or native filename; default is the current/root sheet",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ sheet }, ctx) => {
    const project = ctx.requireProject();
    const hierarchy = await inspectSavedHierarchy(ctx, project);
    const snapshot = await ctx.services.design.schematicInspect(project.dir, sheet);
    const findings: Array<{ code: string; severity: "warning" | "info"; message: string }> = [];
    const references = new Map<string, number>();
    for (const symbol of snapshot.symbols) {
      references.set(symbol.reference, (references.get(symbol.reference) ?? 0) + 1);
      if (!symbol.footprint && !symbol.libId.startsWith("power:"))
        findings.push({
          code: "missing-footprint",
          severity: "warning",
          message: `${symbol.reference} has no footprint assignment.`,
        });
      const gridError = [symbol.position.x, symbol.position.y].some(
        (coordinate) => Math.abs(coordinate / 1.27 - Math.round(coordinate / 1.27)) > 0.02,
      );
      if (gridError)
        findings.push({
          code: "off-grid-symbol",
          severity: "warning",
          message: `${symbol.reference} is off the 1.27 mm schematic grid at ${symbol.position.x},${symbol.position.y}.`,
        });
    }
    for (const [reference, count] of references)
      if (count > 1)
        findings.push({
          code: "duplicate-reference",
          severity: "warning",
          message: `${reference} occurs ${count} times.`,
        });
    if (snapshot.symbols.length >= 5 && snapshot.texts.length === 0)
      findings.push({
        code: "missing-notes",
        severity: "info",
        message:
          "No functional-block notes, interface constraints, or design calculations are present.",
      });
    if (snapshot.globalLabels.length > Math.max(2, snapshot.localLabels.length))
      findings.push({
        code: "global-label-overuse",
        severity: "warning",
        message: `${snapshot.globalLabels.length} global labels versus ${snapshot.localLabels.length} local labels.`,
      });
    if (snapshot.symbols.length >= 6 && snapshot.junctions.length === 0)
      findings.push({
        code: "no-junctions",
        severity: "info",
        message: "No explicit junctions appear in a non-trivial schematic.",
      });
    const labels = [...snapshot.localLabels, ...snapshot.globalLabels];
    for (let left = 0; left < labels.length; left++)
      for (let right = left + 1; right < labels.length; right++) {
        const a = labels[left]!,
          b = labels[right]!;
        if (
          a.text !== b.text &&
          Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) < 2.54
        )
          findings.push({
            code: "label-collision",
            severity: "warning",
            message: `Labels ${a.text} and ${b.text} are less than 2.54 mm apart.`,
          });
      }
    const noteBoxes = snapshot.texts.map((note) => ({
      note,
      minX: note.position.x,
      maxX: note.position.x + Math.max(5, note.text.length * 0.75),
      minY: note.position.y - 1.8,
      maxY: note.position.y + 0.6,
    }));
    const overlaps = (a: (typeof noteBoxes)[number], b: (typeof noteBoxes)[number]) =>
      a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
    for (let left = 0; left < noteBoxes.length; left++)
      for (let right = left + 1; right < noteBoxes.length; right++)
        if (overlaps(noteBoxes[left]!, noteBoxes[right]!))
          findings.push({
            code: "overlapping-notes",
            severity: "warning",
            message: `Notes "${noteBoxes[left]!.note.text}" and "${noteBoxes[right]!.note.text}" overlap.`,
          });
    for (const box of noteBoxes)
      for (const symbol of snapshot.symbols)
        if (
          symbol.position.x >= box.minX - 1.27 &&
          symbol.position.x <= box.maxX + 1.27 &&
          symbol.position.y >= box.minY - 1.27 &&
          symbol.position.y <= box.maxY + 1.27
        )
          findings.push({
            code: "note-symbol-overlap",
            severity: "warning",
            message: `Note "${box.note.text}" overlaps or crowds ${symbol.reference}.`,
          });
    const wireLengths = snapshot.wires.map((wire) =>
      Math.hypot(wire.end.x - wire.start.x, wire.end.y - wire.start.y),
    );
    const longWires = wireLengths.filter((length) => length > 5.08).length;
    if (snapshot.symbols.length >= 5 && labels.length > snapshot.symbols.length * 1.5)
      findings.push({
        code: "label-density",
        severity: "info",
        message: `${labels.length} labels for ${snapshot.symbols.length} symbols. Review the render for label legibility and traceable signal flow.`,
      });
    if (
      snapshot.symbols.length >= 5 &&
      snapshot.wires.length >= snapshot.symbols.length &&
      longWires === 0
    )
      findings.push({
        code: "stub-dominated-connectivity",
        severity: "info",
        message:
          "All wire segments are at most 5.08 mm long. Review the render for traceable signal flow; segment length alone does not establish readability.",
      });
    if (
      snapshot.symbols.length >= 5 &&
      snapshot.wires.length === 0 &&
      labels.length >= snapshot.symbols.length
    )
      findings.push({
        code: "label-only-connectivity",
        severity: "info",
        message:
          "No wires are present and labels are used throughout the sheet. Review the render for label legibility and traceable signal flow.",
      });
    const xs = snapshot.symbols.map((symbol) => symbol.position.x);
    const ys = snapshot.symbols.map((symbol) => symbol.position.y);
    const extent = xs.length
      ? {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
        }
      : null;
    if (
      extent &&
      snapshot.symbols.length >= 5 &&
      extent.maxX - extent.minX < 35 &&
      extent.maxY - extent.minY < 35
    )
      findings.push({
        code: "cramped-layout",
        severity: "info",
        message:
          "Symbols occupy a sub-35 mm area, which may obscure functional blocks and signal flow.",
      });
    if (extent && snapshot.symbols.length >= 8) {
      const width = Math.max(1, extent.maxX - extent.minX),
        height = Math.max(1, extent.maxY - extent.minY);
      const utilization = (width * height) / (267 * 180);
      if (utilization < 0.12)
        findings.push({
          code: "poor-sheet-utilization",
          severity: "info",
          message: `Symbol extent uses about ${(utilization * 100).toFixed(1)}% of the A4 drawing area; spacing functional blocks more broadly may improve readability.`,
        });
    }
    const review = {
      contract: { name: "fabdesk.schematic-review", version: "4.0.0" },
      at: new Date().toISOString(),
      applicability: "selected-sheet-authoring-presentation",
      scope: snapshot.scope ?? {
        kind: "current/root-sheet",
        hierarchyPath: "/",
        nativePath: null,
        name: "root",
      },
      hierarchy: {
        rootFile: hierarchy.rootFile,
        referencedSheetCount: hierarchy.sheets.length,
        aggregateRevision: hierarchy.aggregateRevision,
        complete: hierarchy.complete,
        source: hierarchy.source,
      },
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
      sessionDiagnostics: kicadIpcSessionDiagnostics(snapshot.erc),
      findings,
    };
    await writeReport(project, "schematic-review", review);
    return ok(
      `Schematic presentation review of ${snapshot.scope?.hierarchyPath ?? "current/root sheet"} at live IPC revision ${snapshot.revision}, bound to saved hierarchy ${hierarchy.aggregateRevision} (${hierarchy.complete ? "complete" : "incomplete"}): ${findings.length} finding(s).${findings.length ? `\n${findings.map((finding) => `- [${finding.severity}] ${finding.code}: ${finding.message}`).join("\n")}` : "\nNo presentation risks detected by the current checks."}`,
      review,
    );
  },
});

export const pcb_update_from_schematic = defineTool({
  name: "pcb_update_from_schematic",
  toolset: "circuit",
  title: "Atomically update PCB from schematic",
  description:
    "Atomically validate and run KiCad's native Update PCB from Schematic. The normal apply=true path performs its own dry-run validation, requires zero PCB↔schematic parity conflicts, and saves the PCB only on success. Use apply=false only when a forecast without PCB changes is specifically needed. Both modes save the live schematic before checking it. Live-session diagnostic errors block the board update but are not saved-file or release-authoritative ERC. Board-only footprints are preserved by default.",
  inputSchema: {
    apply: z
      .boolean()
      .default(true)
      .describe(
        "True atomically validates, applies, and saves the PCB; false previews without changing the PCB (both save the live schematic)",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ apply }, ctx) => {
    const project = ctx.requireProject();
    ctx.progress(0.2, "KiCad IPC session diagnostics");
    const result = await ctx.services.design.syncSchematicToPcb(project.dir, !apply);
    const { erc: sessionErc, ...syncResult } = result;
    const reported = {
      contract: { name: "fabdesk.schematic-pcb-sync", version: "2.0.0" },
      ...syncResult,
      sessionDiagnostics: kicadIpcSessionDiagnostics(sessionErc),
    };
    await writeReport(project, "schematic-sync", { at: new Date().toISOString(), ...reported });
    ctx.progress(1, result.ok ? "done" : "blocked");
    const mode = apply ? "Update" : "Preview";
    const text = [
      `${mode}: ${result.ok ? "OK" : "BLOCKED"}.`,
      formatKicadIpcSessionDiagnostics(sessionErc),
      `Board update: ${result.update.errors} errors, ${result.update.warnings} warnings, ${result.update.newFootprints} new footprints.`,
      ...(result.parity !== undefined ? [`Schematic parity: ${result.parity} conflicts.`] : []),
      result.saved
        ? "Native schematic and PCB saved."
        : apply
          ? "PCB was not saved."
          : "Preview made no PCB changes.",
      ...(result.update.report ? [`Report:\n${result.update.report}`] : []),
    ].join("\n");
    return { text, json: reported, isError: !result.ok };
  },
});

export const schematicTools = [
  schematic_inspect,
  schematic_edit,
  schematic_review,
  pcb_update_from_schematic,
];
