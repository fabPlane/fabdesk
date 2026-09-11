/** SHARED-003: revision-guarded, previewable native edit transactions with disk rollback. */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { PROJECT_FILES, exists, readJson } from "../fs";
import { ToolError, defineTool } from "../registry";
import type { NativeSchematicEdit, PcbFootprintEdit, PcbGeometryEdit } from "../services";
import { ok, p } from "./common";

const Point = z.object({ x: z.number().finite(), y: z.number().finite() });
const FILES = [PROJECT_FILES.boardPro, PROJECT_FILES.boardSch, PROJECT_FILES.boardPcb] as const;

async function sha(path: string): Promise<string | null> {
  if (!(await exists(path))) return null;
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function revisions(projectDir: string) {
  return {
    schematic: await sha(join(projectDir, PROJECT_FILES.boardSch)),
    pcb: await sha(join(projectDir, PROJECT_FILES.boardPcb)),
  };
}

async function backup(projectDir: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const file of FILES) {
    const source = join(projectDir, file);
    if (await exists(source)) await copyFile(source, join(directory, file));
  }
}

async function restore(projectDir: string, directory: string): Promise<void> {
  for (const file of FILES) {
    const saved = join(directory, file);
    const target = join(projectDir, file);
    if (await exists(saved)) {
      const temporary = `${target}.restore-${randomUUID()}`;
      await copyFile(saved, temporary);
      await rename(temporary, target);
    } else await rm(target, { force: true });
  }
}

const SchematicEdit = z.object({
  symbols: z.array(z.object({
    libId: z.string().min(3), reference: z.string().min(1), value: z.string(), footprint: z.string(), position: Point,
    unit: z.number().int().positive().optional(), bodyStyle: z.number().int().positive().optional(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    mirrorX: z.boolean().optional(), mirrorY: z.boolean().optional(), fields: z.record(z.string(), z.string()).optional(),
  })).max(200).optional(),
  symbolUpdates: z.array(z.object({ reference: z.string().min(1), newReference: z.string().min(1).optional(), position: Point.optional(), value: z.string().optional(), footprint: z.string().optional(), fields: z.record(z.string(), z.string()).optional() })).max(200).optional(),
  connections: z.array(z.object({ name: z.string().min(1), nodes: z.array(z.object({ reference: z.string(), pin: z.string() })).min(2), label: z.enum(["local", "global", "none"]).optional() })).max(500).optional(),
  wires: z.array(z.object({ start: Point, end: Point })).max(1000).optional(),
  localLabels: z.array(z.object({ text: z.string(), position: Point })).max(500).optional(),
  globalLabels: z.array(z.object({ text: z.string(), position: Point })).max(500).optional(),
  junctions: z.array(Point).max(1000).optional(), noConnects: z.array(Point).max(1000).optional(),
  texts: z.array(z.object({ text: z.string(), position: Point })).max(200).optional(),
  deleteItemIds: z.array(z.string()).max(1000).optional(),
});

const FootprintEdit = z.object({
  reference: z.string().min(1), position: Point.optional(), rotation: z.number().finite().optional(),
  flip: z.boolean().optional(), lock: z.boolean().optional(),
});

const Polygon = z.object({ points: z.array(Point).min(3).max(5000), holes: z.array(z.array(Point).min(3).max(5000)).max(100).optional() });
const Layer = z.number().int();
const PcbGeometry = z.object({
  tracks: z.array(z.object({ start: Point, end: Point, width: z.number().positive(), layer: Layer, net: z.string().min(1).optional() })).max(5000).optional(),
  vias: z.array(z.object({ position: Point, diameter: z.number().positive(), drill: z.number().positive(), layers: z.array(Layer).min(2), net: z.string().min(1).optional() })).max(2000).optional(),
  zones: z.array(Polygon.extend({ layers: z.array(Layer).min(1), net: z.string().min(1).optional(), name: z.string().optional(), clearance: z.number().nonnegative().optional(), minThickness: z.number().positive().optional(), priority: z.number().int().optional() })).max(200).optional(),
  keepouts: z.array(Polygon.extend({ layers: z.array(Layer).min(1), name: z.string().optional(), copper: z.boolean().optional(), vias: z.boolean().optional(), tracks: z.boolean().optional(), pads: z.boolean().optional(), footprints: z.boolean().optional() })).max(200).optional(),
  texts: z.array(z.object({ text: z.string(), position: Point, layer: Layer, size: Point.optional(), thickness: z.number().positive().optional(), angle: z.number().finite().optional(), knockout: z.boolean().optional() })).max(1000).optional(),
  graphics: z.array(z.object({ kind: z.enum(["segment", "rectangle", "arc", "circle", "polygon"]), layer: Layer, start: Point.optional(), end: Point.optional(), mid: Point.optional(), center: Point.optional(), radiusPoint: Point.optional(), points: z.array(Point).min(3).max(5000).optional(), holes: z.array(z.array(Point).min(3).max(5000)).max(100).optional(), strokeWidth: z.number().nonnegative().optional(), filled: z.boolean().optional() })).max(2000).optional(),
  deleteItemIds: z.array(z.string().min(1)).max(5000).optional(),
});

export const native_edit_transaction = defineTool({
  name: "native_edit_transaction",
  toolset: "circuit",
  title: "Preview or apply an atomic native edit",
  description:
    "Preview or atomically apply explicit native KiCad schematic, footprint, outline, copper, zone, keepout, text, and graphic changes. Revision mismatches reject the transaction; rejected changes restore the prior files.",
  inputSchema: {
    mode: z.enum(["preview", "apply"]).default("preview"),
    expectedSchematicRevision: z.string().length(64).nullable().optional(),
    expectedPcbRevision: z.string().length(64).nullable().optional(),
    schematic: SchematicEdit.optional(),
    outline: z.object({ points: z.array(Point).min(3).max(100), replace: z.boolean().default(false) }).optional(),
    footprints: z.array(FootprintEdit).max(500).optional(),
    geometry: PcbGeometry.optional(),
    removeCopperNets: z.array(z.string().min(1)).max(500).optional(),
  },
  annotations: { idempotentHint: false },
  handler: async ({ mode, expectedSchematicRevision, expectedPcbRevision, schematic, outline, footprints, geometry, removeCopperNets }, ctx) => {
    const project = ctx.requireProject();
    const before = await revisions(project.dir);
    if (expectedSchematicRevision !== undefined && before.schematic !== expectedSchematicRevision)
      throw new ToolError(`stale schematic revision: expected ${expectedSchematicRevision}, actual ${before.schematic}`, "precondition");
    if (expectedPcbRevision !== undefined && before.pcb !== expectedPcbRevision)
      throw new ToolError(`stale PCB revision: expected ${expectedPcbRevision}, actual ${before.pcb}`, "precondition");
    const plan = {
      schematic: schematic ? "edit native schematic" : null,
      outline: outline ? `${outline.points.length}-segment outline` : null,
      footprints: footprints?.map((edit) => edit.reference) ?? [],
      geometry: geometry
        ? {
            tracks: geometry.tracks?.length ?? 0,
            vias: geometry.vias?.length ?? 0,
            zones: geometry.zones?.length ?? 0,
            keepouts: geometry.keepouts?.length ?? 0,
            texts: geometry.texts?.length ?? 0,
            graphics: geometry.graphics?.length ?? 0,
            deleteItemIds: geometry.deleteItemIds ?? [],
          }
        : null,
      removeCopperNets: removeCopperNets ?? [],
    };
    if (mode === "preview") return ok("Native edit preview validated; canonical files were not changed.", { status: "preview", before, after: before, plan });

    const transactionId = `native-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const root = p(project, ".fabdesk/native-revisions");
    const directory = join(root, transactionId);
    await backup(project.dir, directory);
    await writeFile(join(directory, "metadata.json"), JSON.stringify({ transactionId, createdAt: new Date().toISOString(), before, plan }, null, 2));
    try {
      if (schematic) await ctx.services.design.schematicEdit(project.dir, { ...(schematic as NativeSchematicEdit), save: true });
      if (outline) await ctx.services.design.defineBoardOutline(project.dir, outline.points, outline.replace);
      if (footprints?.length) {
        const placed = await ctx.services.design.placeFootprints(project.dir, footprints as PcbFootprintEdit[]);
        if (placed.missing.length) throw new ToolError(`unknown footprints: ${placed.missing.join(", ")}`, "invalid_args");
      }
      if (geometry) await ctx.services.design.editBoardGeometry(project.dir, geometry as PcbGeometryEdit);
      if (removeCopperNets?.length) await ctx.services.design.unroute(project.dir, removeCopperNets);
      const after = await revisions(project.dir);
      const pcbGeometry = geometry || footprints?.length || outline ? await ctx.services.design.inspectBoardGeometry(project.dir) : undefined;
      if (pcbGeometry && !pcbGeometry.revisionStable) throw new ToolError("PCB geometry changed during inspection", "precondition");
      await writeFile(join(root, "last-accepted.json"), JSON.stringify({ transactionId, before, after }, null, 2));
      return ok(`Atomic native edit ${transactionId} accepted.`, { status: "accepted", transactionId, before, after, plan, ...(pcbGeometry ? { pcbGeometry } : {}) });
    } catch (error) {
      await ctx.services.design.release(project.dir).catch(() => undefined);
      await restore(project.dir, directory);
      throw new ToolError(`native edit rejected; canonical files restored: ${error instanceof Error ? error.message : String(error)}`, error instanceof ToolError ? error.code : "internal");
    }
  },
});

export const native_edit_rollback = defineTool({
  name: "native_edit_rollback",
  toolset: "circuit",
  title: "Rollback the last accepted native edit",
  description: "Restore the exact native KiCad files saved before an accepted native_edit_transaction. The current revisions must still match that transaction's after revisions, preventing rollback over newer work.",
  inputSchema: { transactionId: z.string().optional() },
  annotations: { destructiveHint: true, idempotentHint: true },
  handler: async ({ transactionId }, ctx) => {
    const project = ctx.requireProject();
    const root = p(project, ".fabdesk/native-revisions");
    const accepted = await readJson<{ transactionId: string; before: Awaited<ReturnType<typeof revisions>>; after: Awaited<ReturnType<typeof revisions>> }>(join(root, "last-accepted.json")).catch(() => null);
    if (!accepted) throw new ToolError("no accepted native edit is available to roll back", "precondition");
    if (transactionId && transactionId !== accepted.transactionId) throw new ToolError(`last accepted transaction is ${accepted.transactionId}, not ${transactionId}`, "precondition");
    const current = await revisions(project.dir);
    if (JSON.stringify(current) !== JSON.stringify(accepted.after)) throw new ToolError("native files changed after the accepted transaction; refusing stale rollback", "precondition");
    await ctx.services.design.release(project.dir).catch(() => undefined);
    await restore(project.dir, join(root, accepted.transactionId));
    return ok(`Rolled back ${accepted.transactionId}.`, { status: "rolled-back", transactionId: accepted.transactionId, before: current, after: await revisions(project.dir) });
  },
});

export const nativeEditTools = [native_edit_transaction, native_edit_rollback];
