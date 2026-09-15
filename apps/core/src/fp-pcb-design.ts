/**
 * `DesignService` on a FabPlane PCB bridge: the netlist is compiled by the bridge's compile job,
 * routing by its route job, and everything else (queries, unroute, scope, library search) goes
 * through the typed client on the project's session. Positions come back in millimetres; the
 * client speaks nanometres.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  ElectricalPinType,
  BoardGraphicShapeSchema,
  BoardLayer,
  GlobalLabelSchema,
  JunctionSchema,
  KiCadObjectType,
  LocalLabelSchema,
  NoConnectMarkerSchema,
  SchematicLabelSpinStyle,
  SchematicLineSchema,
  SchematicLineType,
  SchematicTextSchema,
  TextSchema,
} from "@fp-pcb/proto";
import {
  GlobalLabel,
  Junction,
  LocalLabel,
  NoConnect,
  BoardShape,
  BoardText,
  Track,
  Arc,
  Zone,
  LibFootprint,
  LibSymbol,
  SchematicLine,
  SchematicPin,
  SchematicSymbol,
  SchematicText,
  Via,
  createBoardGraphic,
  createBoardText,
  createTrack,
  createVia,
  createZone,
  inspectBoardGeometry as inspectNativeBoardGeometry,
  mm as toNm,
  placeNativeSymbol,
  moveNativeSymbol,
  toVector2,
  toMm,
  type Board,
  type KiCad,
} from "@fp-pcb/client";
import type { FpPcbCompileJob, FpPcbDiagnostic, FpPcbRouteJob } from "@fabdesk/protocol";
import {
  PROJECT_FILES,
  ToolError,
  type BuildError,
  type BuildOptions,
  type BuildResult,
  type ComponentScope,
  type DesignRow,
  type DesignSelect,
  type DesignService,
  type DesignStatus,
  type FootprintHit,
  type NativeSchematicEdit,
  type NativeSchematicSnapshot,
  type PartDescription,
  type PartCompatibility,
  type PcbFootprintEdit,
  type PcbGeometryEdit,
  type PcbGeometrySnapshot,
  type RouteJobOptions,
  type RouteProgress,
  type RouteSummary,
} from "@fabdesk/tools";
import type { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { BOARD_PCB, BOARD_PRO, type FpPcbSessions } from "./fp-pcb-session";
import type { KicadLibraryCatalog } from "./kicad-library-catalog";

/** The `@fp-pcb/compile` frontend that reads `circuit.netlist.json` (its `NETLIST_JSON_KIND`). */
export const NETLIST_JSON_KIND = "netlist-json";

const STAGE_FRACTION: Record<string, number> = {
  queued: 0.05,
  frontend: 0.1,
  validating: 0.15,
  checking: 0.25,
  cleaning: 0.3,
  outlining: 0.35,
  importing: 0.5,
  placing: 0.7,
  schematic: 0.2,
  parity: 0.8,
  saving: 0.85,
};
// Nanometres are integral. Preserve enough decimal places for exact pad/track joins instead of
// rounding inspected coordinates to 1 um and creating tiny disconnected gaps on re-use.
const mm = (nm: number) => Math.round(toMm(nm) * 1_000_000) / 1_000_000;

function toBuildError(d: FpPcbDiagnostic): BuildError {
  return {
    message: d.message,
    type: d.code ?? d.stage,
    ...(d.file ? { file: d.file } : {}),
    ...(d.line !== undefined ? { line: d.line } : {}),
    ...(d.column !== undefined ? { column: d.column } : {}),
  };
}

export function toRouteProgress(job: FpPcbRouteJob): RouteProgress {
  const p = job.progress;
  return {
    state: job.state,
    log: job.log,
    ...(p?.phase ? { phase: p.phase } : {}),
    ...(p?.message ? { message: p.message } : {}),
    ...(p?.pass !== undefined ? { pass: p.pass } : {}),
    ...(p?.routed !== undefined ? { routed: p.routed } : {}),
    ...(p?.total !== undefined ? { total: p.total } : {}),
  };
}

export type FpPcbDesignDeps = {
  bridge: () => FpPcbBridgeClient;
  sessions: FpPcbSessions;
  readText?: (path: string) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
  catalog?: KicadLibraryCatalog;
};

export function createFpPcbDesign(deps: FpPcbDesignDeps): DesignService {
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf8"));
  const exists = deps.exists ?? ((p: string) => Bun.file(p).exists());
  const active = new Map<string, string>(); // projectDir -> session id with a running route

  const build = async (opts: BuildOptions): Promise<BuildResult> => {
    const started = performance.now();
    const entrypoint = opts.entrypoint ?? PROJECT_FILES.netlistJson;
    const entryPath = join(opts.projectDir, entrypoint);
    if (!(await exists(entryPath))) {
      return {
        ok: false,
        errors: [
          {
            type: "missing_entrypoint",
            message: `${entrypoint} not found in ${opts.projectDir}`,
            file: entrypoint,
          },
        ],
        warnings: [],
        counts: { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 },
        durationMs: 0,
      };
    }
    const source = {
      kind: NETLIST_JSON_KIND,
      files: { [entrypoint]: await readText(entryPath) },
      entrypoint,
    };
    opts.progress?.(0.05, "session");
    let sessionWasBare = false;
    const job = await deps.sessions.withRetry(opts.projectDir, (s) => {
      sessionWasBare = !s.path;
      return deps.bridge().compile(
        s.id,
        {
          source,
          ...(s.path ? {} : { project: { path: join(opts.projectDir, BOARD_PRO) } }),
          ...(opts.board ? { board: opts.board } : {}),
          ...(opts.rebuild ? { rebuild: opts.rebuild } : {}),
          autoplace: true,
          save: true,
          netlistPath: PROJECT_FILES.compileNet,
        },
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          onProgress: (j: FpPcbCompileJob) =>
            opts.progress?.(STAGE_FRACTION[j.state] ?? 0.5, j.state),
        },
      );
    });
    // The project may have been created by this job: the session now has a board and a path.
    if (job.state === "cancelled") throw new ToolError("compile cancelled", "cancelled");
    const durationMs = Math.round(performance.now() - started);
    const empty = { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 };
    if (!job.result) {
      // NewProject can write its stub files before a later backend-load failure. The session is
      // still recorded as bare in that case; release it so the next build reconnects through the
      // generated board instead of calling NewProject again and getting "already exists" forever.
      if (
        sessionWasBare &&
        /^NewProject:/i.test(job.error ?? "") &&
        (await exists(join(opts.projectDir, BOARD_PCB)))
      ) {
        await deps.sessions.release(opts.projectDir);
      }
      return {
        ok: false,
        errors: [
          {
            type: "compile_job_failed",
            message:
              job.error ?? `compile job ${job.id} ended in state ${job.state} with no result`,
          },
        ],
        warnings: [],
        counts: empty,
        durationMs,
      };
    }
    const errors = job.result.diagnostics.filter((d) => d.severity === "error").map(toBuildError);
    const warnings = job.result.diagnostics
      .filter((d) => d.severity === "warning")
      .map(toBuildError);
    return {
      ok: job.result.ok && errors.length === 0,
      errors,
      warnings,
      counts: job.result.counts,
      durationMs,
      ...(job.revision !== undefined ? { revision: job.revision } : {}),
      ...(job.removedCopper ? { removedCopper: job.removedCopper } : {}),
      ...(job.rejectedSchematicPath ? { rejectedSchematicPath: job.rejectedSchematicPath } : {}),
    };
  };

  const schematicInspect = async (projectDir: string): Promise<NativeSchematicSnapshot> => {
    const { schematic, board } = await deps.sessions.ensureProject(projectDir);
    const root = await schematic.rootSheet();
    const [symbols, items, nets, erc, revision, pcbRevision] = await Promise.all([
      root.getSymbols(),
      root.getAllItems(),
      schematic.netlist(),
      schematic.erc.run(),
      schematic.revision(),
      board.revision(),
    ]);
    const netByItem = new Map<string, string>();
    for (const net of nets)
      for (const sheet of net.sheets)
        for (const item of sheet.items) netByItem.set(item.value, net.name);
    return {
      revision: Number(revision ?? 0n),
      pcbRevision: Number(pcbRevision ?? 0n),
      symbols: symbols.map((symbol) => ({
        id: symbol.id,
        reference: symbol.reference,
        value: symbol.value,
        footprint: symbol.footprint,
        libId: symbol.libraryId,
        position: { x: mm(symbol.position.x), y: mm(symbol.position.y) },
        rotation: symbol.rotation,
        mirrorX: symbol.mirrorX,
        mirrorY: symbol.mirrorY,
        pins: symbol.pins.map((pin) => ({
          id: pin.id,
          number: pin.number,
          name: pin.name,
          ...(netByItem.get(pin.id) ? { net: netByItem.get(pin.id)! } : {}),
          position: { x: mm(pin.position.x), y: mm(pin.position.y) },
        })),
      })),
      wires: items
        .filter((item): item is SchematicLine => item instanceof SchematicLine && item.isWire)
        .map((wire) => ({
          id: wire.id,
          start: { x: mm(wire.start.x), y: mm(wire.start.y) },
          end: { x: mm(wire.end.x), y: mm(wire.end.y) },
        })),
      localLabels: items
        .filter((item): item is LocalLabel => item instanceof LocalLabel)
        .map((label) => ({
          id: label.id,
          text: label.text,
          position: { x: mm(label.position.x), y: mm(label.position.y) },
        })),
      globalLabels: items
        .filter((item): item is GlobalLabel => item instanceof GlobalLabel)
        .map((label) => ({
          id: label.id,
          text: label.text,
          position: { x: mm(label.position.x), y: mm(label.position.y) },
        })),
      junctions: items
        .filter((item): item is Junction => item instanceof Junction)
        .map((junction) => ({
          id: junction.id,
          position: { x: mm(junction.position.x), y: mm(junction.position.y) },
        })),
      noConnects: items
        .filter((item): item is NoConnect => item instanceof NoConnect)
        .map((marker) => ({
          id: marker.id,
          position: { x: mm(marker.position.x), y: mm(marker.position.y) },
        })),
      texts: items
        .filter((item): item is SchematicText => item instanceof SchematicText)
        .map((note) => ({
          id: note.id,
          text: note.text,
          position: { x: mm(note.position.x), y: mm(note.position.y) },
        })),
      nets: nets.map((net) => ({
        name: net.name,
        itemCount: net.sheets.reduce((count, sheet) => count + sheet.items.length, 0),
        itemIds: net.sheets.flatMap((sheet) => sheet.items.map((item) => item.value)),
      })),
      erc: { errors: erc.errorCount, warnings: erc.warningCount },
    };
  };

  const schematicEdit = async (projectDir: string, edit: NativeSchematicEdit) => {
    const { schematic, session } = await deps.sessions.ensureProject(projectDir);
    const root = await schematic.rootSheet();
    const existing = await root.getSymbols();
    const byReference = new Map(existing.map((symbol) => [symbol.reference, symbol]));
    const createdSymbols: SchematicSymbol[] = [];
    const updatedSymbols: SchematicSymbol[] = [];
    for (const input of edit.symbolUpdates ?? []) {
      const symbol = byReference.get(input.reference);
      if (!symbol)
        throw new ToolError(`cannot update missing schematic symbol ${input.reference}`, "invalid_args");
      if (input.position)
        moveNativeSymbol(symbol, { x: toNm(input.position.x), y: toNm(input.position.y) });
      if (input.newReference !== undefined) {
        if (byReference.has(input.newReference))
          throw new ToolError(`cannot annotate ${input.reference} as existing reference ${input.newReference}`, "invalid_args");
        symbol.reference = input.newReference;
        byReference.delete(input.reference);
        byReference.set(input.newReference, symbol);
      }
      if (input.value !== undefined) symbol.value = input.value;
      if (input.footprint !== undefined) symbol.footprint = input.footprint;
      for (const [name, value] of Object.entries(input.fields ?? {})) {
        const field = symbol.field(name);
        if (!field)
          throw new ToolError(
            `cannot add new field ${name} while updating ${input.reference}; provide it when creating the symbol`,
            "invalid_args",
          );
        field.text = value;
      }
      updatedSymbols.push(symbol);
    }
    const pins = new Map<string, { x: number; y: number }>();
    for (const symbol of existing)
      for (const pin of symbol.pins) pins.set(`${symbol.reference}:${pin.number}`, pin.position);

    for (const input of edit.symbols ?? []) {
      if (byReference.has(input.reference))
        throw new ToolError(
          `schematic already contains ${input.reference}; delete or edit it explicitly before adding it again`,
          "invalid_args",
        );
      const definition = await session.kicad
        .openSymbol(input.libId)
        .then((document) => document.libSymbol())
        .catch((error: unknown) => {
          throw new ToolError(
            `cannot load symbol ${input.libId}: ${error instanceof Error ? error.message : String(error)}`,
            "invalid_args",
          );
        });
      if (!definition) throw new ToolError(`cannot load symbol ${input.libId}`, "invalid_args");
      const placed = placeNativeSymbol(definition, {
        reference: input.reference,
        value: input.value,
        footprint: input.footprint,
        position: { x: toNm(input.position.x), y: toNm(input.position.y) },
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(input.bodyStyle !== undefined ? { bodyStyle: input.bodyStyle } : {}),
        ...(input.rotation !== undefined ? { rotation: input.rotation } : {}),
        ...(input.mirrorX !== undefined ? { mirrorX: input.mirrorX } : {}),
        ...(input.mirrorY !== undefined ? { mirrorY: input.mirrorY } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
      });
      createdSymbols.push(placed.symbol);
      for (const [number, position] of placed.pins)
        pins.set(`${input.reference}:${number}`, position);
      byReference.set(input.reference, placed.symbol);
    }

    const wires: SchematicLine[] = [];
    const addWire = (start: { x: number; y: number }, end: { x: number; y: number }) => {
      if (start.x === end.x && start.y === end.y) return;
      wires.push(
        new SchematicLine(
          create(SchematicLineSchema, {
            start: toVector2(start),
            end: toVector2(end),
            type: SchematicLineType.SLT_WIRE,
          }),
        ),
      );
    };
    for (const wire of edit.wires ?? [])
      addWire(
        { x: toNm(wire.start.x), y: toNm(wire.start.y) },
        { x: toNm(wire.end.x), y: toNm(wire.end.y) },
      );

    const globalLabels: GlobalLabel[] = (edit.globalLabels ?? []).map(
      (label) =>
        new GlobalLabel(
          create(GlobalLabelSchema, {
            position: toVector2({ x: toNm(label.position.x), y: toNm(label.position.y) }),
            text: create(TextSchema, {
              text: label.text,
              position: toVector2({ x: toNm(label.position.x), y: toNm(label.position.y) }),
            }),
            spinStyle: SchematicLabelSpinStyle.SLSS_LEFT,
          }),
        ),
    );
    const localLabels: LocalLabel[] = (edit.localLabels ?? []).map(
      (label) => {
        const position = { x: toNm(label.position.x), y: toNm(label.position.y) };
        return new LocalLabel(
          create(LocalLabelSchema, {
            position: toVector2(position),
            text: create(TextSchema, { text: label.text, position: toVector2(position) }),
            spinStyle: SchematicLabelSpinStyle.SLSS_LEFT,
          }),
        );
      },
    );
    const junctions = (edit.junctions ?? []).map(
      (position) =>
        new Junction(
          create(JunctionSchema, {
            position: toVector2({ x: toNm(position.x), y: toNm(position.y) }),
          }),
        ),
    );
    const noConnects = (edit.noConnects ?? []).map(
      (position) =>
        new NoConnect(
          create(NoConnectMarkerSchema, {
            position: toVector2({ x: toNm(position.x), y: toNm(position.y) }),
          }),
        ),
    );
    const texts = (edit.texts ?? []).map((note) => {
      const position = { x: toNm(note.position.x), y: toNm(note.position.y) };
      return new SchematicText(
        create(SchematicTextSchema, {
          text: create(TextSchema, { text: note.text, position: toVector2(position) }),
        }),
      );
    });

    for (const connection of edit.connections ?? []) {
      if (connection.nodes.length < 2)
        throw new ToolError(`net ${connection.name} needs at least two nodes`, "invalid_args");
      const points = connection.nodes.map((node) => {
        const point = pins.get(`${node.reference}:${node.pin}`);
        if (!point)
          throw new ToolError(
            `net ${connection.name}: unknown schematic pin ${node.reference}:${node.pin}`,
            "invalid_args",
          );
        return point;
      });
      // A routed Manhattan chain can silently merge unrelated nets when independently generated
      // chains cross or share an elbow. Give every endpoint a short outward wire stub and the same
      // label instead: connectivity stays explicit and safe while the rendered schematic still
      // shows a connection at each pin.
      const labelKind = connection.label ?? "local";
      if (labelKind === "none") {
        for (let index = 1; index < points.length; index++) {
          const start = points[index - 1]!;
          const end = points[index]!;
          const elbow = { x: end.x, y: start.y };
          addWire(start, elbow);
          addWire(elbow, end);
        }
        continue;
      }
      for (const [index, pin] of points.entries()) {
        const node = connection.nodes[index]!;
        const symbol = byReference.get(node.reference);
        const center = symbol?.position ?? pin;
        const dx = pin.x - center.x;
        const dy = pin.y - center.y;
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        const step = toNm(2.54);
        const anchor = horizontal
          ? { x: pin.x + (dx >= 0 ? step : -step), y: pin.y }
          : { x: pin.x, y: pin.y + (dy >= 0 ? step : -step) };
        const spinStyle = horizontal
          ? (dx >= 0 ? SchematicLabelSpinStyle.SLSS_LEFT : SchematicLabelSpinStyle.SLSS_RIGHT)
          : (dy >= 0 ? SchematicLabelSpinStyle.SLSS_UP : SchematicLabelSpinStyle.SLSS_BOTTOM);
        addWire(pin, anchor);
        if (labelKind === "global")
          globalLabels.push(new GlobalLabel(create(GlobalLabelSchema, {
            position: toVector2(anchor), text: create(TextSchema, { text: connection.name, position: toVector2(anchor) }),
            spinStyle,
          })));
        else if (labelKind === "local")
          localLabels.push(new LocalLabel(create(LocalLabelSchema, {
            position: toVector2(anchor), text: create(TextSchema, { text: connection.name, position: toVector2(anchor) }),
            spinStyle,
          })));
      }
    }

    const deleteItems = edit.deleteItemIds?.length
      ? await root.getItemsById(edit.deleteItemIds)
      : [];
    const createdItems = [
      ...createdSymbols,
      ...wires,
      ...localLabels,
      ...globalLabels,
      ...junctions,
      ...noConnects,
      ...texts,
    ];
    if (createdItems.length || updatedSymbols.length || deleteItems.length)
      await root.commit("Fabdesk: edit native schematic", async (tx) => {
        if (deleteItems.length) await tx.delete(deleteItems);
        if (updatedSymbols.length) await tx.update(updatedSymbols);
        if (createdItems.length) await tx.create(createdItems);
      });
    const save = edit.save ?? true;
    if (save) await schematic.save();
    return {
      created: {
        symbols: createdSymbols.length,
        wires: wires.length,
        localLabels: localLabels.length,
        globalLabels: globalLabels.length,
        junctions: junctions.length,
        noConnects: noConnects.length,
        texts: texts.length,
      },
      updated: { symbols: updatedSymbols.length },
      deleted: deleteItems.length,
      saved: save,
      revision: Number((await schematic.revision()) ?? 0n),
    };
  };

  const syncSchematicToPcb = async (projectDir: string, dryRun: boolean) => {
    const { schematic, board } = await deps.sessions.ensureProject(projectDir);
    await schematic.save();
    const erc = await schematic.erc.run();
    const blocked = {
      ok: false,
      dryRun,
      erc: { errors: erc.errorCount, warnings: erc.warningCount },
      update: { errors: 0, warnings: 0, newFootprints: 0, report: "" },
      saved: false,
    };
    if (erc.errorCount) return blocked;
    const options = {
      matchMode: "uuid" as const,
      deleteExtraFootprints: false,
      updateFootprints: true,
      updateFields: true,
      removeExtraFields: false,
    };
    const preview = await schematic.syncToBoard(board, { ...options, dryRun: true });
    const update = {
      errors: preview.errorCount,
      warnings: preview.warningCount,
      newFootprints: preview.newFootprintCount,
      report: preview.report,
    };
    if (preview.errorCount || dryRun)
      return {
        ok: preview.errorCount === 0,
        dryRun: true,
        erc: blocked.erc,
        update,
        saved: false,
      };
    const applied = await schematic.syncToBoard(board, options);
    const appliedUpdate = {
      errors: applied.errorCount,
      warnings: applied.warningCount,
      newFootprints: applied.newFootprintCount,
      report: applied.report,
    };
    if (applied.errorCount) {
      await board.undo().catch(() => undefined);
      return { ok: false, dryRun: false, erc: blocked.erc, update: appliedUpdate, saved: false };
    }
    const parity = await board.drc.run({ testFootprintsAgainstSchematic: true });
    if (parity.parityCount) {
      await board.undo().catch(() => undefined);
      return {
        ok: false,
        dryRun: false,
        erc: blocked.erc,
        update: appliedUpdate,
        parity: parity.parityCount,
        saved: false,
      };
    }
    await board.save();
    await schematic.save();
    return {
      ok: true,
      dryRun: false,
      erc: blocked.erc,
      update: appliedUpdate,
      parity: 0,
      saved: true,
    };
  };

  const defineBoardOutline = async (
    projectDir: string,
    pointsMm: Array<{ x: number; y: number }>,
    replace: boolean,
  ) => {
    const { board } = await deps.sessions.ensureProject(projectDir);
    const property = "fabdesk.generated-outline";
    const value = "native-atomic-edit";
    const points = pointsMm.map((point) => ({ x: toNm(point.x), y: toNm(point.y) }));
    const newEdges = points.map((start, index) => {
      const end = points[(index + 1) % points.length]!;
      const edge = new BoardShape(
        create(BoardGraphicShapeSchema, {
          layer: BoardLayer.BL_Edge_Cuts,
          shape: {
            geometry: { case: "segment", value: { start: toVector2(start), end: toVector2(end) } },
          },
        }),
      );
      edge.setCustomProperty(property, value);
      return edge;
    });
    const existing = (await board.getShapes()).filter(
      (shape) =>
        shape.proto.layer === BoardLayer.BL_Edge_Cuts &&
        shape.proto.shape?.geometry.case === "segment",
    );
    const generated = existing.filter((edge) => edge.customProperties[property] === value);
    const segmentKey = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const first = `${a.x},${a.y}`;
      const second = `${b.x},${b.y}`;
      return first < second ? `${first}|${second}` : `${second}|${first}`;
    };
    const keys = (edges: BoardShape[]) =>
      edges
        .flatMap((edge) => {
          const geometry = edge.proto.shape?.geometry;
          return geometry?.case === "segment"
            ? [
                segmentKey(
                  {
                    x: Number(geometry.value.start?.xNm ?? 0n),
                    y: Number(geometry.value.start?.yNm ?? 0n),
                  },
                  {
                    x: Number(geometry.value.end?.xNm ?? 0n),
                    y: Number(geometry.value.end?.yNm ?? 0n),
                  },
                ),
              ]
            : [];
        })
        .sort();
    const matches =
      JSON.stringify(keys(generated.length ? generated : existing)) ===
      JSON.stringify(keys(newEdges));
    if (matches) {
      return {
        created: 0,
        replaced: 0,
        revision: Number((await board.revision()) ?? 0n),
        saved: true,
      };
    }
    if (existing.length && (!generated.length || !replace))
      throw new ToolError(
        generated.length
          ? "the requested outline differs from the Fabdesk-owned outline; preview the board and pass replace=true to update it"
          : "the requested outline differs from a human-authored Edge.Cuts boundary; edit it in KiCad or remove it explicitly",
        "precondition",
      );
    await board.commit("Fabdesk: define native PCB outline", async (tx) => {
      if (generated.length) await tx.delete(generated);
      await tx.create(newEdges);
    });
    await board.save();
    return {
      created: newEdges.length,
      replaced: generated.length,
      revision: Number((await board.revision()) ?? 0n),
      saved: true,
    };
  };

  const placeFootprints = async (
    projectDir: string,
    placements: PcbFootprintEdit[],
  ) => {
    const board = await deps.sessions.board(projectDir);
    const footprints = await board.getFootprints();
    const byReference = new Map(footprints.map((footprint) => [footprint.reference, footprint]));
    const missing = placements
      .map((placement) => placement.reference)
      .filter((reference) => !byReference.has(reference));
    if (missing.length)
      return { moved: [], missing, revision: Number((await board.revision()) ?? 0n), saved: false };
    const moved = placements.flatMap((placement) => {
      const footprint = byReference.get(placement.reference)!;
      let changed = false;
      if (placement.position) {
        const target = { x: toNm(placement.position.x), y: toNm(placement.position.y) };
        const delta = { x: target.x - footprint.position.x, y: target.y - footprint.position.y };
        if (delta.x || delta.y) {
          footprint.translate(delta);
          changed = true;
        }
      }
      if (placement.rotation !== undefined && footprint.orientation !== placement.rotation) {
        footprint.orientation = placement.rotation;
        changed = true;
      }
      if (placement.flip !== undefined && footprint.isFlipped !== placement.flip) {
        footprint.layerId = placement.flip ? BoardLayer.BL_B_Cu : BoardLayer.BL_F_Cu;
        changed = true;
      }
      if (placement.lock !== undefined && footprint.locked !== placement.lock) {
        footprint.locked = placement.lock;
        changed = true;
      }
      return changed ? [footprint] : [];
    });
    if (moved.length)
      await board.commit("Fabdesk: place native PCB footprints", (tx) => tx.update(moved));
    let libraryNormalized = 0;
    if (moved.length) {
      const normalized = await board.updateFootprintsFromLibrary(moved.map((footprint) => footprint.id), { onlyChanged: true });
      if (normalized.missing.length)
        throw new ToolError(`packaged library footprints unavailable for ${normalized.missing.join(", ")}`, "precondition");
      libraryNormalized = normalized.updatedCount;
    }
    await board.save();
    return {
      moved: moved.map((footprint) => footprint.reference),
      missing: [],
      libraryNormalized,
      revision: Number((await board.revision()) ?? 0n),
      saved: true,
    };
  };

  const editBoardGeometry = async (projectDir: string, edit: PcbGeometryEdit) => {
    const board = await deps.sessions.board(projectDir);
    const nets = new Map((await board.nets()).map((item) => [item.name, item.code?.value ?? 0]));
    const net = (name: string) => {
      const code = nets.get(name);
      if (code === undefined) throw new ToolError(`unknown PCB net ${name}`, "invalid_args");
      return { name, code };
    };
    const point = (value: { x: number; y: number }) => ({ x: toNm(value.x), y: toNm(value.y) });
    const polygons = (points: Array<{ x: number; y: number }>, holes: Array<Array<{ x: number; y: number }>> | undefined) => [
      { outline: points.map(point), ...(holes ? { holes: holes.map((hole) => hole.map(point)) } : {}) },
    ];
    const created = [
      ...(edit.tracks ?? []).map((item) =>
        createTrack({ start: point(item.start), end: point(item.end), width: toNm(item.width), layer: item.layer as BoardLayer, ...(item.net ? { net: net(item.net) } : {}) }),
      ),
      ...(edit.vias ?? []).map((item) =>
        createVia({ position: point(item.position), diameter: toNm(item.diameter), drill: toNm(item.drill), layers: item.layers as BoardLayer[], ...(item.net ? { net: net(item.net) } : {}) }),
      ),
      ...(edit.zones ?? []).map((item) =>
        createZone({
          kind: "copper",
          polygons: polygons(item.points, item.holes),
          layers: item.layers as BoardLayer[],
          ...(item.net ? { net: net(item.net) } : {}),
          ...(item.name !== undefined ? { name: item.name } : {}),
          ...(item.clearance !== undefined ? { clearance: toNm(item.clearance) } : {}),
          ...(item.minThickness !== undefined ? { minThickness: toNm(item.minThickness) } : {}),
          ...(item.priority !== undefined ? { priority: item.priority } : {}),
        }),
      ),
      ...(edit.keepouts ?? []).map((item) =>
        createZone({
          kind: "keepout",
          polygons: polygons(item.points, item.holes),
          layers: item.layers as BoardLayer[],
          ...(item.name !== undefined ? { name: item.name } : {}),
          ...(item.copper !== undefined ? { copper: item.copper } : {}),
          ...(item.vias !== undefined ? { vias: item.vias } : {}),
          ...(item.tracks !== undefined ? { tracks: item.tracks } : {}),
          ...(item.pads !== undefined ? { pads: item.pads } : {}),
          ...(item.footprints !== undefined ? { footprints: item.footprints } : {}),
        }),
      ),
      ...(edit.texts ?? []).map((item) =>
        createBoardText({
          text: item.text,
          position: point(item.position),
          layer: item.layer as BoardLayer,
          ...(item.size ? { size: point(item.size) } : {}),
          ...(item.thickness !== undefined ? { thickness: toNm(item.thickness) } : {}),
          ...(item.angle !== undefined ? { angle: item.angle } : {}),
          ...(item.knockout !== undefined ? { knockout: item.knockout } : {}),
        }),
      ),
      ...(edit.graphics ?? []).map((item) => {
        const geometry =
          item.kind === "segment" && item.start && item.end
            ? { kind: "segment" as const, start: point(item.start), end: point(item.end) }
            : item.kind === "rectangle" && item.start && item.end
              ? { kind: "rectangle" as const, topLeft: point(item.start), bottomRight: point(item.end) }
              : item.kind === "arc" && item.start && item.mid && item.end
                ? { kind: "arc" as const, start: point(item.start), mid: point(item.mid), end: point(item.end) }
                : item.kind === "circle" && item.center && item.radiusPoint
                  ? { kind: "circle" as const, center: point(item.center), radiusPoint: point(item.radiusPoint) }
                  : item.kind === "polygon" && item.points
                    ? { kind: "polygon" as const, polygons: polygons(item.points, item.holes) }
                    : null;
        if (!geometry) throw new ToolError(`incomplete ${item.kind} board graphic geometry`, "invalid_args");
        return createBoardGraphic({
          geometry,
          layer: item.layer as BoardLayer,
          ...(item.strokeWidth !== undefined ? { strokeWidth: toNm(item.strokeWidth) } : {}),
          ...(item.filled !== undefined ? { filled: item.filled } : {}),
        });
      }),
    ];
    const deleteIds = edit.deleteItemIds ?? [];
    if (deleteIds.length) {
      const existing = await board.getItemsById(deleteIds);
      const found = new Set(existing.map((item) => item.id));
      const missing = deleteIds.filter((id) => !found.has(id));
      if (missing.length) throw new ToolError(`unknown PCB item ids: ${missing.join(", ")}`, "invalid_args");
    }
    const result = await board.commit("Fabdesk: edit native PCB geometry", async (tx) => {
      const made = created.length ? await tx.create(created) : [];
      if (deleteIds.length) await tx.delete(deleteIds);
      return made;
    });
    await board.save();
    return {
      created: {
        tracks: edit.tracks?.length ?? 0,
        vias: edit.vias?.length ?? 0,
        zones: edit.zones?.length ?? 0,
        keepouts: edit.keepouts?.length ?? 0,
        texts: edit.texts?.length ?? 0,
        graphics: edit.graphics?.length ?? 0,
      },
      createdIds: result.created.map((item) => item.id),
      deletedIds: result.deleted,
      revision: Number((await board.revision()) ?? 0n),
      saved: true,
    };
  };

  const inspectBoardGeometry = async (projectDir: string): Promise<PcbGeometrySnapshot> => {
    const board = await deps.sessions.board(projectDir);
    const snapshot = await inspectNativeBoardGeometry(board);
    const point = (value: { x: number; y: number }) => ({ x: mm(value.x), y: mm(value.y) });
    const polygonValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(polygonValue);
      if (!value || typeof value !== "object") return typeof value === "bigint" ? Number(value) : value;
      const row = value as Record<string, unknown>;
      if (typeof row["xNm"] === "bigint" && typeof row["yNm"] === "bigint")
        return { x: mm(Number(row["xNm"])), y: mm(Number(row["yNm"])) };
      return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "$typeName").map(([key, entry]) => [key, polygonValue(entry)]));
    };
    const layerNames = Object.fromEntries(
      await Promise.all(snapshot.enabledLayers.layers.map(async (layer) => [String(layer), await board.layerName(layer)])),
    );
    return {
      ...(snapshot.revisionStart !== undefined ? { revisionStart: Number(snapshot.revisionStart) } : {}),
      ...(snapshot.revisionEnd !== undefined ? { revisionEnd: Number(snapshot.revisionEnd) } : {}),
      revisionStable: snapshot.revisionStable,
      enabledLayers: snapshot.enabledLayers,
      layerNames,
      pads: snapshot.pads.map((item) => ({ ...item, position: point(item.position), size: point(item.size), drillDiameter: point(item.drillDiameter), polygons: item.polygons.map((shape) => ({ layer: shape.layer, shape: polygonValue(shape.shape) })) })),
      tracks: snapshot.tracks.map((item) => ({ ...item, start: point(item.start), end: point(item.end), width: mm(item.width) })),
      arcs: snapshot.arcs.map((item) => ({ ...item, start: point(item.start), mid: point(item.mid), end: point(item.end), width: mm(item.width) })),
      vias: snapshot.vias.map((item) => ({ ...item, position: point(item.position), diameter: mm(item.diameter), drill: mm(item.drill) })),
      zones: snapshot.zones.map((item) => ({ ...item, clearance: mm(item.clearance), minThickness: mm(item.minThickness), outline: item.outline.map(point), polygons: polygonValue(item.polygons) })),
      texts: snapshot.texts.map((item) => ({ ...item, position: point(item.position), size: point(item.size), thickness: mm(item.thickness) })),
      graphics: snapshot.graphics.map((item) => ({ ...item, start: point(item.start), end: point(item.end), geometry: polygonValue(item.geometry), strokeWidth: mm(item.strokeWidth) })),
      nets: snapshot.nets.map((item) => ({ ...item, ...(item.clearance !== undefined ? { clearance: mm(item.clearance) } : {}), ...(item.trackWidth !== undefined ? { trackWidth: mm(item.trackWidth) } : {}), ...(item.viaDiameter !== undefined ? { viaDiameter: mm(item.viaDiameter) } : {}), ...(item.viaDrill !== undefined ? { viaDrill: mm(item.viaDrill) } : {}) })),
      rules: { ...snapshot.rules, minimums: Object.fromEntries(Object.entries(snapshot.rules.minimums).map(([key, value]) => [key, mm(value)])), custom: polygonValue(snapshot.rules.custom) },
    };
  };

  const query = async (
    projectDir: string,
    select: DesignSelect,
    filter?: string,
  ): Promise<DesignRow[]> => {
    const board = await deps.sessions.board(projectDir);
    const f = filter?.toLowerCase();
    const keep = (...fields: unknown[]) =>
      !f ||
      fields.some((v) =>
        String(v ?? "")
          .toLowerCase()
          .includes(f),
      );
    switch (select) {
      case "components": {
        return (await board.getFootprints())
          .map((fp) => ({
            ref: fp.reference,
            value: fp.value,
            footprint: fp.libraryId,
            x: mm(fp.position.x),
            y: mm(fp.position.y),
            layer: fp.layerId,
            rotation: fp.orientation,
            flipped: fp.isFlipped,
            locked: fp.locked,
            symbolPath: fp.symbolPath,
          }))
          .filter((r) => keep(r.ref, r.value, r.footprint));
      }
      case "nets": {
        const pads = await board.getPads();
        const counts = new Map<string, number>();
        for (const pad of pads) {
          const net = pad.net ?? "";
          if (net) counts.set(net, (counts.get(net) ?? 0) + 1);
        }
        return (await board.nets())
          .map((n) => ({
            name: n.name,
            code: n.code?.value ?? 0,
            pads: counts.get(n.name) ?? 0,
          }))
          .filter((r) => keep(r.name));
      }
      case "pads": {
        const refs = new Map((await board.getFootprints()).map((fp) => [fp.id, fp.reference]));
        return (await board.getPads())
          .map((pad) => ({
            component: refs.get(pad.parent ?? "") ?? pad.parent ?? "",
            number: pad.number,
            net: pad.net ?? "",
            x: mm(pad.position.x),
            y: mm(pad.position.y),
            width: mm(pad.size.x),
            height: mm(pad.size.y),
            id: pad.id,
            layer: pad.layerId,
          }))
          .filter((r) => keep(r.component, r.net, r.number));
      }
      case "vias": {
        return (await board.getTracks())
          .filter((t): t is Via => t instanceof Via)
          .map((v) => ({
            id: v.id,
            net: v.net ?? "",
            x: mm(v.position.x),
            y: mm(v.position.y),
            diameter: mm(v.diameter),
            drill: mm(v.drillDiameter),
          }))
          .filter((r) => keep(r.net, r.id));
      }
      case "tracks": {
        return (await board.getTracks())
          .map((t) => ({
            kind: t.typeName.replace(/^.*\./, ""),
            net: t.net ?? "",
            layer: t.layerId ?? "",
            id: t.id,
            ...(t instanceof Track
              ? {
                  start: { x: mm(t.start.x), y: mm(t.start.y) },
                  end: { x: mm(t.end.x), y: mm(t.end.y) },
                  width: mm(t.width),
                  length: mm(t.length),
                }
              : t instanceof Arc
                ? {
                    start: { x: mm(t.start.x), y: mm(t.start.y) },
                    mid: { x: mm(t.mid.x), y: mm(t.mid.y) },
                    end: { x: mm(t.end.x), y: mm(t.end.y) },
                    width: mm(t.width),
                  }
                : {}),
          }))
          .filter((r) => keep(r.net));
      }
      case "zones":
      case "keepouts": {
        return (await board.getZones())
          .filter((zone) => (select === "keepouts" ? zone.isRuleArea : !zone.isRuleArea))
          .map((zone: Zone) => ({
            id: zone.id,
            name: zone.name,
            net: zone.net ?? "",
            layers: zone.layers,
            clearance: mm(zone.clearance),
            minThickness: mm(zone.minThickness),
            filled: zone.filled,
            points: zone.outlinePoints.map((point) => ({ x: mm(point.x), y: mm(point.y) })),
          }))
          .filter((row) => keep(row.name, row.net));
      }
      case "board_geometry": {
        const shapes = await board.getShapes();
        const footprints = await board.getFootprints();
        const footprintGeometry = footprints.flatMap((footprint) =>
          footprint.items
            .filter(
              (item): item is BoardShape =>
                item instanceof BoardShape &&
                [BoardLayer.BL_F_CrtYd, BoardLayer.BL_B_CrtYd, BoardLayer.BL_F_Fab, BoardLayer.BL_B_Fab].includes(item.layerId),
            )
            .map((shape) => ({
              id: shape.id,
              owner: footprint.reference,
              kind: shape.kind,
              layer: shape.layerId,
              start: { x: mm(shape.start.x), y: mm(shape.start.y) },
              end: { x: mm(shape.end.x), y: mm(shape.end.y) },
            })),
        );
        return [
          ...shapes.map((shape) => ({
            id: shape.id,
            owner: "board",
            kind: shape.kind,
            layer: shape.layerId,
            start: { x: mm(shape.start.x), y: mm(shape.start.y) },
            end: { x: mm(shape.end.x), y: mm(shape.end.y) },
          })),
          ...footprintGeometry,
        ];
      }
      case "texts": {
        return (await board.getTexts())
          .map((text: BoardText) => ({
            id: text.id,
            text: text.text,
            x: mm(text.position.x),
            y: mm(text.position.y),
            layer: text.layerId,
            rotation: text.angle,
            size: { x: mm(text.size.x), y: mm(text.size.y) },
            thickness: mm(text.thickness),
          }))
          .filter((row) => keep(row.text));
      }
      case "unrouted": {
        return (await board.ratsnest()).edges
          .map((e) => ({
            net: e.net,
            from: { x: mm(e.sourcePosition.x), y: mm(e.sourcePosition.y) },
            to: { x: mm(e.targetPosition.x), y: mm(e.targetPosition.y) },
          }))
          .filter((r) => keep(r.net));
      }
    }
  };

  const route = async (
    projectDir: string,
    opts: RouteJobOptions,
    hooks: { onProgress?: (p: RouteProgress) => void; signal?: AbortSignal },
  ): Promise<RouteSummary> => {
    await deps.sessions.board(projectDir); // fails early with a precondition when nothing is built
    const job = await deps.sessions.withRetry(projectDir, async (s) => {
      active.set(projectDir, s.id);
      try {
        return await deps.bridge().route(
          s.id,
          {
            router: opts.router === "freerouting" ? "freerouting" : "js",
            options: {
              ...(opts.nets ? { nets: opts.nets } : {}),
              ...(opts.maxTimeMs ? { maxTimeMs: opts.maxTimeMs } : {}),
              ...(opts.settings ?? {}),
            },
            ...(opts.refillZones !== undefined ? { refillZones: opts.refillZones } : {}),
          },
          {
            ...(hooks.signal ? { signal: hooks.signal } : {}),
            maxMs: (opts.maxTimeMs ?? 120_000) + 5 * 60_000,
            onProgress: (j) => hooks.onProgress?.(toRouteProgress(j)),
          },
        );
      } finally {
        active.delete(projectDir);
      }
    });
    if (job.state === "cancelled") throw new ToolError("route cancelled", "cancelled");
    if (job.state === "failed" || !job.summary)
      throw new ToolError(
        job.error ?? `route job ${job.id} ended in state ${job.state}`,
        "internal",
      );
    // The route job saves before routing (for the DSN export), not after applying: every tool
    // downstream reads the file, so persist what the job put on the board.
    await saveBoard(projectDir);
    const s = job.summary;
    return {
      tracks: s.tracks,
      vias: s.vias,
      claimedVias: s.claimedVias,
      ...(s.preset ? { preset: s.preset } : {}),
      routed: s.routed,
      total: s.total,
      trackLengthNm: s.trackLengthNm,
      elapsedMs: s.elapsedMs,
      wallMs: s.wallMs,
      timedOut: s.timedOut,
      message: s.message,
      unrouted: s.unrouted.map((u) => ({
        net: u.net,
        from: { x: mm(u.from.x), y: mm(u.from.y) },
        to: { x: mm(u.to.x), y: mm(u.to.y) },
      })),
      geometry: s.geometry.map((shape) => ({
        kind: shape.kind,
        id: shape.id,
        layer: shape.layer,
        net: shape.net,
        points: shape.points.map(mm),
        ...(shape.width !== undefined ? { width: mm(shape.width) } : {}),
      })),
      log: s.log,
    };
  };

  /** `SaveDocument` on the project's board, so kicad-cli tools and the app see what the session holds. */
  const saveBoard = async (projectDir: string): Promise<void> => {
    const board = await deps.sessions.board(projectDir);
    await board.save();
  };

  const cancelRoute = async (projectDir?: string): Promise<void> => {
    const ids = projectDir
      ? [active.get(projectDir)].filter((v): v is string => !!v)
      : [...active.values()];
    for (const id of ids)
      await deps
        .bridge()
        .cancelJobs("route", id)
        .catch(() => 0);
  };

  const unroute = async (
    projectDir: string,
    nets?: string[],
  ): Promise<{ tracks: number; vias: number }> => {
    const board = await deps.sessions.board(projectDir);
    const wanted = nets?.length ? new Set(nets) : null;
    // A free prefab via has no net and is part of the blank, not routed copper. Preserve it when
    // unrouting the whole board; an explicitly named-net unroute cannot select it anyway.
    const items = (await board.getTracks()).filter(
      (t) => (!(t instanceof Via) || Boolean(t.net)) && (!wanted || wanted.has(t.net ?? "")),
    );
    const vias = items.filter((t) => t.typeName.endsWith("Via")).length;
    if (items.length) {
      await board.commit(wanted ? `Unroute ${[...wanted].join(", ")}` : "Unroute all", (tx) =>
        tx.delete(items),
      );
      await saveBoard(projectDir);
    }
    return { tracks: items.length - vias, vias };
  };

  const scope = async (
    projectDir: string,
    refs: string[],
    opts: { excludePlaneNets?: boolean; excludeNets?: string[] } = {},
  ): Promise<ComponentScope> => {
    const board = await deps.sessions.board(projectDir);
    const footprints = await board.getFootprints();
    const byRef = new Map(footprints.map((fp) => [fp.reference, fp.id]));
    const components = refs.filter((r) => byRef.has(r));
    const missing = refs.filter((r) => !byRef.has(r));
    const ids = new Set(components.map((r) => byRef.get(r)!));
    const pads: Record<string, number> = {};
    const nets = new Set<string>();
    for (const pad of await board.getPads()) {
      if (!pad.parent || !ids.has(pad.parent)) continue;
      const ref = footprints.find((fp) => fp.id === pad.parent)?.reference ?? pad.parent;
      pads[ref] = (pads[ref] ?? 0) + 1;
      if (pad.net) nets.add(pad.net);
    }
    const excluded: ComponentScope["excluded"] = [];
    const planeNets = new Set(
      (opts.excludePlaneNets ?? true)
        ? (await board.getZones()).map((z) => z.net ?? "").filter(Boolean)
        : [],
    );
    const drop = new Set(opts.excludeNets ?? []);
    const kept: string[] = [];
    for (const net of [...nets].sort()) {
      if (planeNets.has(net)) excluded.push({ net, reason: "owns a copper pour" });
      else if (drop.has(net)) excluded.push({ net, reason: "excluded by request" });
      else kept.push(net);
    }
    return { components, missing, nets: kept, excluded, pads };
  };

  const searchLibraries = async (
    kind: "footprint" | "symbol",
    query: string,
    limit: number,
  ): Promise<FootprintHit[]> => {
    if (deps.catalog?.has(kind)) return deps.catalog.search(kind, query, limit);
    const kicad = await anyKicad();
    const tokens = query
      .toLowerCase()
      .split(/[\s:]+/)
      .filter(Boolean);
    const nicknames = await kicad.libraries.nicknames(kind);
    const scored = nicknames
      .map((n) => ({ n, hit: tokens.filter((t) => n.toLowerCase().includes(t)).length }))
      .sort((a, b) => b.hit - a.hit);
    const hits: FootprintHit[] = [];
    const filter = tokens.join(" ");
    for (const { n, hit } of scored) {
      if (hits.length >= limit) break;
      // Libraries whose name matches take everything matching the rest; others only exact-ish entry hits.
      const entries = await kicad.libraries
        .entries(
          kind,
          n,
          hit ? tokens.filter((t) => !n.toLowerCase().includes(t)).join(" ") : filter,
        )
        .catch(() => []);
      for (const e of entries) {
        if (hits.length >= limit) break;
        hits.push({
          libId: `${n}:${e.name}`,
          nickname: n,
          name: e.name,
          description: e.description ?? "",
        });
      }
    }
    return hits;
  };
  const searchFootprints = (query: string, limit: number) =>
    searchLibraries("footprint", query, limit);
  const searchSymbols = (query: string, limit: number) => searchLibraries("symbol", query, limit);
  const describePart = async (
    kind: "footprint" | "symbol",
    libId: string,
  ): Promise<PartDescription> => {
    if (deps.catalog?.has(kind)) {
      const item = await deps.catalog.describe(kind, libId);
      if (item) return item;
      throw new ToolError(
        `${kind} ${libId} was not found in the bundled KiCad libraries`,
        "not_found",
      );
    }
    const kicad = await anyKicad();
    const item = await kicad.libraries.get(kind, libId);
    if (!item)
      throw new ToolError(
        `${kind} ${libId} was not found in the design server libraries`,
        "not_found",
      );
    if (kind === "symbol" && item instanceof LibSymbol) {
      const pins = item.items.filter(
        (child): child is SchematicPin => child instanceof SchematicPin,
      );
      return {
        kind,
        libId,
        description: item.description,
        pins: pins.map((pin) => ({
          number: pin.number,
          name: pin.name,
          electricalType: ElectricalPinType[pin.electricalType] ?? String(pin.electricalType),
          position: { x: mm(pin.position.x), y: mm(pin.position.y) },
        })),
        fabrication: {
          courtyard: "unsupported",
          fabOutline: "unsupported",
          threeDModels: "unsupported",
          models: [],
          includedInBom: "unsupported",
          includedInPositionFiles: "unsupported",
        },
      };
    }
    if (kind === "footprint" && item instanceof LibFootprint) {
      return {
        kind,
        libId,
        description: item.description,
        anchor: { x: mm(item.anchor.x), y: mm(item.anchor.y) },
        pads: item.pads.map((pad) => ({
          number: pad.number,
          position: {
            x: mm(pad.position.x - item.anchor.x),
            y: mm(pad.position.y - item.anchor.y),
          },
          size: { x: mm(pad.size.x), y: mm(pad.size.y) },
        })),
        package: { assemblyMethod: "unspecified" },
        fabrication: {
          courtyard: "unsupported",
          fabOutline: "unsupported",
          threeDModels: "unsupported",
          models: [],
          includedInBom: "unsupported",
          includedInPositionFiles: "unsupported",
        },
      };
    }
    throw new ToolError(`${libId} did not resolve as a ${kind}`, "invalid_args");
  };
  const checkPartCompatibility = async (
    symbolLibId: string,
    footprintLibId: string,
    role?: "power-only-usb-c",
  ): Promise<PartCompatibility> => {
    const [symbol, footprint] = await Promise.all([
      describePart("symbol", symbolLibId),
      describePart("footprint", footprintLibId),
    ]);
    return evaluatePartCompatibility(symbol, footprint, role);
  };

  /** Any live KiCad for server-wide questions (libraries); a bare session when no project is open. */
  const anyKicad = async (): Promise<KiCad> => (await deps.sessions.session("")).kicad;

  const status = async (): Promise<DesignStatus> => {
    const bridge = deps.bridge();
    try {
      const h = await bridge.health();
      return {
        url: bridge.url,
        ok: h.ok,
        ...(h.kicadCliExists !== undefined ? { kicadCliExists: h.kicadCliExists } : {}),
        ...(h.compile?.frontends ? { frontends: h.compile.frontends } : {}),
        routers: {
          ...(h.jsAutorouter ? { capacity: { ok: h.jsAutorouter.ok, ...(h.jsAutorouter.reason ? { reason: h.jsAutorouter.reason } : {}) } } : {}),
          ...(h.freerouting ? { freerouting: { ok: h.freerouting.ok, ...(h.freerouting.reason ? { reason: h.freerouting.reason } : {}) } } : {}),
        },
      };
    } catch (e) {
      return { url: bridge.url, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };

  return {
    build,
    schematicInspect,
    schematicEdit,
    syncSchematicToPcb,
    defineBoardOutline,
    placeFootprints,
    editBoardGeometry,
    inspectBoardGeometry,
    query,
    route,
    cancelRoute,
    unroute,
    scope,
    searchFootprints,
    searchSymbols,
    describePart,
    checkPartCompatibility,
    status,
    release: (dir) => deps.sessions.release(dir),
  };
}

/** Pure compatibility contract used before any placement or project mutation. */
export function evaluatePartCompatibility(
  symbol: PartDescription,
  footprint: PartDescription,
  role?: "power-only-usb-c",
): PartCompatibility {
  const pins = new Set(
    (symbol.pins ?? [])
      .filter((pin) => pin.electricalType !== "PT_NC")
      .map((pin) => pin.number)
      .filter(Boolean),
  );
  const pads = new Set((footprint.pads ?? []).map((pad) => pad.number).filter(Boolean));
  const matched = [...pins].filter((number) => pads.has(number)).sort();
  const missingPadsForPins = [...pins].filter((number) => !pads.has(number)).sort();
  const padsWithoutPins = [...pads].filter((number) => !pins.has(number)).sort();
  const electricalExtras = padsWithoutPins.filter(
    (number) => !/^(sh|shield|mp|mh|mount|ep)$/i.test(number),
  );
  const issues = missingPadsForPins.map((number) => `symbol pin ${number} has no footprint pad`);
  const warnings = [
    ...electricalExtras.map((number) => `footprint pad ${number} has no symbol pin`),
    ...padsWithoutPins
      .filter((number) => !electricalExtras.includes(number))
      .map((number) => `mechanical/shield pad ${number} has no symbol pin`),
  ];
  let roleResult: PartCompatibility["role"];
  if (role) {
    const symbolRole = symbol.roleSuitability?.find((entry) => entry.role === role);
    const footprintRole = footprint.roleSuitability?.find((entry) => entry.role === role);
    const suitable = Boolean(symbolRole?.suitable && footprintRole?.suitable);
    roleResult = {
      role,
      suitable,
      reasons: [
        ...(symbolRole?.reasons ?? ["symbol role metadata unavailable"]),
        ...(footprintRole?.reasons ?? ["footprint role metadata unavailable"]),
      ],
    };
    if (!suitable) issues.push(`${role} suitability could not be established for both parts`);
  }
  return {
    symbolLibId: symbol.libId,
    footprintLibId: footprint.libId,
    symbol,
    footprint,
    compatible: issues.length === 0,
    pinPad: {
      compatible: missingPadsForPins.length === 0,
      matched,
      missingPadsForPins,
      padsWithoutPins,
    },
    ...(roleResult ? { role: roleResult } : {}),
    issues,
    warnings,
  };
}

/** Exposed for tests. */
export type { Board };
