/** SHARED-002: one revision-bound view of the saved native KiCad design. */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, exists, jailPath, projectRelative, readJsonOrNull, writeJson } from "../fs";
import { ToolError, defineTool } from "../registry";
import type { DesignRow, DrcReport, ErcReport } from "../services";
import { compactHierarchy, inspectSavedHierarchy, ok, p, requireKicad } from "./common";
import { kicadIpcSessionDiagnostics } from "./diagnostic-evidence";

type Finding = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  objects: string[];
  coordinates: Array<{ x: number; y: number }>;
};

async function revision(path: string): Promise<{ sha256: string; bytes: number; mtime: string }> {
  const [data, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.byteLength,
    mtime: metadata.mtime.toISOString(),
  };
}

const point = (row: DesignRow): { x: number; y: number } | null => {
  const x = Number(row["x"]);
  const y = Number(row["y"]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};

export const design_inspect = defineTool({
  name: "design_inspect",
  toolset: "circuit",
  title: "Inspect saved native design",
  description:
    "Inspect the exact complete saved schematic hierarchy and board revision in one result. Defaults to compact whole-project schematic truth; optionally expands one sheet's live KiCad IPC authoring details. Saved-file ERC/parity and live session diagnostics remain separately labelled.",
  inputSchema: {
    refreshChecks: z
      .boolean()
      .default(true)
      .describe(
        "Run packaged-kicad-cli full-severity ERC and parity-enabled DRC for these exact saved files",
      ),
    schematicDetail: z.enum(["summary", "authoring", "full"]).default("summary"),
    responseMode: z
      .enum(["full", "report-reference"])
      .default("full")
      .describe(
        "Return the complete inspection inline, or a bounded reference to the complete saved report",
      ),
    sheet: z
      .string()
      .min(1)
      .optional()
      .describe("Sheet path, name, or native filename for bounded authoring expansion"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async ({ refreshChecks, schematicDetail, responseMode, sheet }, ctx) => {
    const project = ctx.requireProject();
    const schematicPath = p(project, PROJECT_FILES.boardSch);
    const boardPath = p(project, PROJECT_FILES.boardPcb);
    if (!(await exists(schematicPath)) || !(await exists(boardPath)))
      throw new ToolError(
        "native inspection requires both board.kicad_sch and board.kicad_pcb",
        "precondition",
      );

    const cli = await requireKicad(ctx);
    const hierarchy = await inspectSavedHierarchy(ctx, project, cli);
    const [
      schematic,
      components,
      nets,
      pads,
      tracks,
      vias,
      zones,
      keepouts,
      boardGeometry,
      footprintGeometry,
      texts,
      remaining,
      geometrySnapshot,
      runtime,
    ] = await Promise.all([
      ctx.services.design.schematicInspect(project.dir, sheet),
      ctx.services.design.query(project.dir, "components"),
      ctx.services.design.query(project.dir, "nets"),
      ctx.services.design.query(project.dir, "pads"),
      ctx.services.design.query(project.dir, "tracks"),
      ctx.services.design.query(project.dir, "vias"),
      ctx.services.design.query(project.dir, "zones"),
      ctx.services.design.query(project.dir, "keepouts"),
      ctx.services.design.query(project.dir, "board_geometry"),
      ctx.services.design.query(project.dir, "footprint_geometry"),
      ctx.services.design.query(project.dir, "texts"),
      ctx.services.design.query(project.dir, "unrouted"),
      ctx.services.design.inspectBoardGeometry(project.dir),
      ctx.services.design.status(),
    ]);
    const [schematicRevision, pcbRevision] = await Promise.all([
      revision(schematicPath),
      revision(boardPath),
    ]);
    const previousRelease = await readJsonOrNull<{
      capturedAt?: string;
      revisions?: { schematic?: string; pcb?: string };
      pass?: boolean;
    }>(p(project, PROJECT_FILES.reports, "release.json"));
    const releaseEvidence = previousRelease
      ? {
          capturedAt: previousRelease.capturedAt ?? null,
          pass: previousRelease.pass ?? false,
          stale:
            previousRelease.revisions?.schematic !== hierarchy.aggregateRevision ||
            previousRelease.revisions?.pcb !== pcbRevision.sha256,
        }
      : { status: "missing" as const };

    let erc: ErcReport | { status: "missing" } = { status: "missing" };
    let drc: (DrcReport & { schematicParityChecked: true }) | { status: "missing" } = {
      status: "missing",
    };
    if (refreshChecks && hierarchy.complete) {
      erc = await ctx.services.kicad.runErc(cli, {
        schematic: schematicPath,
        outFile: p(project, PROJECT_FILES.reports, "inspection-erc.json"),
        severity: "all",
        signal: ctx.signal,
      });
      const checked = await ctx.services.kicad.runDrc(cli, {
        board: boardPath,
        outFile: p(project, PROJECT_FILES.reports, "inspection-drc.json"),
        severity: "all",
        schematicParity: true,
        signal: ctx.signal,
      });
      drc = { ...checked, schematicParityChecked: true };
    }

    const findings: Finding[] = [];
    const padsByKey = new Map(pads.map((pad) => [`${pad["component"]}:${pad["number"]}`, pad]));
    for (const symbol of schematic.symbols) {
      for (const pin of symbol.pins) {
        const key = `${symbol.reference}:${pin.number}`;
        const pad = padsByKey.get(key);
        if (!pad) {
          findings.push({
            code: "missing-pcb-pad",
            severity: "error",
            message: `${key} has no PCB pad.`,
            objects: [symbol.id, key],
            coordinates: [pin.position],
          });
          continue;
        }
        if (pin.net !== undefined && String(pad["net"] ?? "") !== pin.net) {
          findings.push({
            code: "pin-pad-net-mismatch",
            severity: "error",
            message: `${key} is ${pin.net} in the schematic but ${String(pad["net"] ?? "<none>")} on the PCB.`,
            objects: [symbol.id, String(pad["id"] ?? key)],
            coordinates: [pin.position, ...(point(pad) ? [point(pad)!] : [])],
          });
        }
      }
    }
    const componentPoints = components.flatMap((component) => {
      const at = point(component);
      return at ? [{ ref: String(component["ref"]), ...at }] : [];
    });
    for (let a = 0; a < componentPoints.length; a++)
      for (let b = a + 1; b < componentPoints.length; b++) {
        const left = componentPoints[a]!;
        const right = componentPoints[b]!;
        if (Math.hypot(left.x - right.x, left.y - right.y) < 1)
          findings.push({
            code: "placement-crowding",
            severity: "warning",
            message: `${left.ref} and ${right.ref} anchors are less than 1 mm apart.`,
            objects: [left.ref, right.ref],
            coordinates: [
              { x: left.x, y: left.y },
              { x: right.x, y: right.y },
            ],
          });
      }
    if (components.length >= 3 && texts.length === 0)
      findings.push({
        code: "missing-board-markings",
        severity: "warning",
        message: "The PCB has no functional text or markings.",
        objects: [],
        coordinates: [],
      });
    if (schematic.symbols.length >= 5) {
      const xs = schematic.symbols.map((symbol) => symbol.position.x);
      const ys = schematic.symbols.map((symbol) => symbol.position.y);
      if (Math.max(...xs) - Math.min(...xs) < 35 && Math.max(...ys) - Math.min(...ys) < 35)
        findings.push({
          code: "schematic-crowding",
          severity: "warning",
          message: "Schematic symbols are crowded into a sub-35 mm composition.",
          objects: schematic.symbols.map((symbol) => symbol.id),
          coordinates: schematic.symbols.map((symbol) => symbol.position),
        });
    }

    const { erc: sessionErc, ...schematicSnapshot } = schematic;
    const result = {
      contract: { name: "fabdesk.native-inspection", version: "2.0.0" },
      capturedAt: new Date().toISOString(),
      runtime: {
        runtimeId: ctx.services.runtimeId,
        fabdeskVersion: ctx.services.version,
        channel: ctx.services.channel,
        bridge: runtime,
        kicadCli: cli ? { path: cli.path, version: cli.version } : { status: "unavailable" },
      },
      revisions: {
        schematic: {
          documentRevision: schematic.revision,
          sha256: hierarchy.aggregateRevision,
          aggregateRevision: hierarchy.aggregateRevision,
          rootFileRevision: schematicRevision,
          referencedSheetCount: hierarchy.sheets.length,
        },
        pcb: { documentRevision: schematic.pcbRevision, ...pcbRevision },
      },
      schematic: {
        scope: "complete-saved-hierarchy" as const,
        hierarchy: compactHierarchy(hierarchy),
        authoring:
          schematicDetail === "summary"
            ? {
                scope: schematic.scope ?? {
                  kind: "current/root-sheet",
                  hierarchyPath: "/",
                  nativePath: null,
                  name: "root",
                },
                counts: {
                  symbols: schematic.symbols.length,
                  wires: schematic.wires.length,
                  projectNets: schematic.nets.length,
                },
                netScope: "complete-live-ipc-session" as const,
                sessionDiagnostics: kicadIpcSessionDiagnostics(sessionErc),
              }
            : schematicDetail === "authoring"
              ? {
                  scope: schematic.scope,
                  revision: schematic.revision,
                  symbols: schematic.symbols,
                  projectNetCount: schematic.nets.length,
                  netScope: "complete-live-ipc-session" as const,
                  sessionDiagnostics: kicadIpcSessionDiagnostics(sessionErc),
                }
              : {
                  ...schematicSnapshot,
                  netScope: "complete-live-ipc-session" as const,
                  sessionDiagnostics: kicadIpcSessionDiagnostics(sessionErc),
                },
      },
      pcb: {
        components,
        nets,
        pads,
        tracks,
        vias,
        zones,
        keepouts,
        geometry: [...boardGeometry, ...footprintGeometry],
        geometrySnapshot,
        texts,
        remainingConnections: remaining,
      },
      checks: {
        savedFileErc: {
          source: "packaged-kicad-cli" as const,
          scope: "complete saved hierarchy" as const,
          revision: hierarchy.aggregateRevision,
          applicability: hierarchy.complete,
          report: erc,
        },
        savedFileDrc: {
          source: "packaged-kicad-cli" as const,
          scope: "saved board.kicad_pcb with complete-hierarchy schematic parity" as const,
          revision: pcbRevision.sha256,
          schematicRevision: hierarchy.aggregateRevision,
          applicability: hierarchy.complete,
          report: drc,
        },
      },
      releaseEvidence,
      findings,
    };
    const reportPath = await jailPath(
      project.dir,
      `${PROJECT_FILES.reports}/native-inspection.json`,
    );
    await writeJson(reportPath, result);
    const savedReport = await readFile(reportPath);
    const summary = `Native inspection of ${hierarchy.complete ? "complete" : "incomplete"} saved hierarchy ${hierarchy.aggregateRevision.slice(0, 12)} (${hierarchy.counts.components} components, ${hierarchy.counts.nets} nets, ${hierarchy.counts.sheets} sheets) and PCB ${pcbRevision.sha256.slice(0, 12)}: ${findings.length} actionable finding(s), ${remaining.length} remaining connection(s), runtime ${ctx.services.runtimeId ?? "unattested-development"}.`;
    if (responseMode === "full") return ok(summary, result, { isError: !hierarchy.complete });
    const checkSummary = (
      check: (typeof result.checks)["savedFileErc"] | (typeof result.checks)["savedFileDrc"],
    ) => ({
      applicability: check.applicability,
      revision: check.revision,
      ...(check.report && "status" in check.report
        ? { status: check.report.status }
        : { status: "measured" as const, counts: check.report.counts }),
    });
    return ok(
      `${summary} Complete report: ${projectRelative(project.dir, reportPath)} (${savedReport.byteLength} bytes).`,
      {
        status: "report-reference",
        contract: result.contract,
        capturedAt: result.capturedAt,
        report: {
          path: projectRelative(project.dir, reportPath),
          bytes: savedReport.byteLength,
          sha256: createHash("sha256").update(savedReport).digest("hex"),
        },
        revisions: result.revisions,
        counts: {
          components: hierarchy.counts.components,
          nets: hierarchy.counts.nets,
          sheets: hierarchy.counts.sheets,
          pads: pads.length,
          tracks: tracks.length,
          vias: vias.length,
          zones: zones.length,
          keepouts: keepouts.length,
          geometry: boardGeometry.length + footprintGeometry.length,
          texts: texts.length,
          remainingConnections: remaining.length,
          findings: findings.length,
        },
        freshness: {
          hierarchyComplete: hierarchy.complete,
          savedFileErc: checkSummary(result.checks.savedFileErc),
          savedFileDrc: checkSummary(result.checks.savedFileDrc),
          releaseEvidence: result.releaseEvidence,
        },
      },
      { isError: !hierarchy.complete },
    );
  },
});

export const inspectionTools = [design_inspect];
