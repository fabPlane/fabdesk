import { nativeProjectPath } from "../native-layout";
/** SHARED-003: revision-guarded, previewable native edit transactions with disk rollback. */
import { readCopper, recordRemoval, qualityText } from "../routing-quality";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { PROJECT_FILES, exists, jailPath, projectRelative, readJson, writeJson } from "../fs";
import {
  ToolError,
  NativeRevisionConflict,
  defineTool,
  mutationInputObject,
  type ProjectHandle,
  type ToolContext,
} from "../registry";
import type { NativeSchematicEdit, PcbFootprintEdit, PcbGeometryEdit } from "../services";
import { inspectSavedHierarchy, ok, p, requireKicad } from "./common";

const Point = mutationInputObject({ x: z.number().finite(), y: z.number().finite() });
const PadEndpoint = mutationInputObject({ reference: z.string().min(1), pad: z.string().min(1) });
const CopperEndpoint = z
  .union([Point, PadEndpoint])
  .describe("Exact millimetre point or a footprint pad resolved to its exact saved-board position");
const FILES = [PROJECT_FILES.boardPro, PROJECT_FILES.boardSch, PROJECT_FILES.boardPcb] as const;

type BackupFile = {
  path: string;
  existed: boolean;
  bytes: number | null;
  sha256: string | null;
};

type TransactionMetadata = {
  transactionId: string;
  createdAt: string;
  before: Awaited<ReturnType<typeof revisions>>;
  plan: unknown;
  files: BackupFile[];
};

async function sha(path: string): Promise<string | null> {
  if (!(await exists(path))) return null;
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function revisions(projectDir: string) {
  return {
    schematic: await sha(nativeProjectPath(projectDir, PROJECT_FILES.boardSch)),
    pcb: await sha(nativeProjectPath(projectDir, PROJECT_FILES.boardPcb)),
  };
}

async function boundRevisions(ctx: ToolContext, project: ProjectHandle) {
  const files = await revisions(project.dir);
  if (files.schematic === null) return files;
  const hierarchy = await inspectSavedHierarchy(ctx, project);
  return { ...files, schematic: hierarchy.aggregateRevision };
}

async function backup(
  projectDir: string,
  directory: string,
  paths: readonly string[],
): Promise<BackupFile[]> {
  await mkdir(directory, { recursive: true });
  const files: BackupFile[] = [];
  for (const requestedPath of paths) {
    const source = await jailPath(projectDir, requestedPath);
    const path = projectRelative(projectDir, source);
    const saved = await jailPath(directory, path);
    const data = await readFile(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (data) {
      await mkdir(dirname(saved), { recursive: true });
      await copyFile(source, saved);
    }
    files.push({
      path,
      existed: data !== null,
      bytes: data?.byteLength ?? null,
      sha256: data ? createHash("sha256").update(data).digest("hex") : null,
    });
  }
  return files;
}

type RestorePlanEntry = { path: string; target: string; data: Buffer | null };

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function readOptional(path: string): Promise<Buffer | null> {
  return readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/**
 * Validates the complete manifest and every backup before restore() touches a canonical file.
 * Nothing here writes, renames, or deletes; the returned plan holds the exact validated bytes.
 */
async function preflightRestore(
  projectDir: string,
  directory: string,
  files: unknown,
): Promise<RestorePlanEntry[]> {
  if (!Array.isArray(files) || files.length === 0)
    throw new ToolError("native transaction backup manifest is missing or empty", "precondition");
  // Backups must stay inside the project as well as the transaction directory, so a redirected
  // transaction directory cannot make restoration read files from outside the project.
  const backupRoot = await jailPath(projectDir, projectRelative(projectDir, directory)).catch(
    () => {
      throw new ToolError(
        "native transaction backup directory escapes the project",
        "precondition",
      );
    },
  );
  const plan: RestorePlanEntry[] = [];
  const seen = new Set<string>();
  for (const [index, file] of (files as unknown[]).entries()) {
    const entry = file as Partial<BackupFile> | null;
    const invalid = (reason: string, code: ToolError["code"] = "precondition") =>
      new ToolError(`backup manifest entry ${index} ${reason}`, code);
    if (typeof entry !== "object" || entry === null || typeof entry.path !== "string")
      throw invalid("is malformed");
    // Only paths written by backup() are accepted: normalized, project-relative, and jailed.
    const target = await jailPath(projectDir, entry.path).catch(() => {
      throw invalid("has an unsafe path", "invalid_args");
    });
    if (projectRelative(projectDir, target) !== entry.path)
      throw invalid("has an unsafe path", "invalid_args");
    const saved = await jailPath(backupRoot, entry.path)
      .then((path) => jailPath(projectDir, projectRelative(projectDir, path)))
      .catch(() => {
        throw invalid("has an unsafe path", "invalid_args");
      });
    const label = `${index} (${entry.path})`;
    if (seen.has(entry.path))
      throw new ToolError(`backup manifest entry ${label} duplicates a path`, "precondition");
    seen.add(entry.path);
    const consistent =
      typeof entry.existed === "boolean" &&
      (entry.existed
        ? Number.isSafeInteger(entry.bytes) &&
          (entry.bytes as number) >= 0 &&
          typeof entry.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(entry.sha256)
        : entry.bytes === null && entry.sha256 === null);
    if (!consistent)
      throw new ToolError(`backup manifest entry ${label} has inconsistent fields`, "precondition");
    const current = await lstat(target).catch(() => null);
    if (current?.isDirectory())
      throw new ToolError(`backup manifest entry ${label} targets a directory`, "precondition");
    let data: Buffer | null = null;
    if (entry.existed) {
      data = await readOptional(saved).catch(() => null);
      if (!data || data.byteLength !== entry.bytes || digest(data) !== entry.sha256)
        throw new ToolError(
          `backup integrity check failed for manifest entry ${label}`,
          "internal",
        );
    }
    plan.push({ path: entry.path, target, data });
  }
  return plan;
}

async function restore(projectDir: string, directory: string, files: unknown): Promise<number> {
  const plan = await preflightRestore(projectDir, directory, files);
  // Stage every replacement from the validated bytes and verify it before the first canonical
  // rename. This makes manifest, path, and backup failures leave canonical files untouched; it
  // does not make multi-file replacement atomic across arbitrary filesystem or process failures.
  const staged = new Map<RestorePlanEntry, string>();
  const createdDirectories: string[] = [];
  let committed = false;
  try {
    for (const entry of plan) {
      if (!entry.data) continue;
      const created = await mkdir(dirname(entry.target), { recursive: true });
      if (created) createdDirectories.push(created);
      const temporary = `${entry.target}.restore-${randomUUID()}`;
      await writeFile(temporary, entry.data, { flag: "wx" }).catch(
        async (error: NodeJS.ErrnoException) => {
          // "wx" never opens an existing file, so only a file this call created is removed.
          if (error.code !== "EEXIST") await rm(temporary, { force: true });
          throw error;
        },
      );
      staged.set(entry, temporary);
      const check = await readFile(temporary);
      if (!check.equals(entry.data))
        throw new ToolError(`restoration staging failed for ${entry.path}`, "internal");
    }
    let restored = 0;
    for (const entry of plan) {
      const temporary = staged.get(entry);
      if (temporary) {
        await rename(temporary, entry.target);
        staged.delete(entry);
      } else await rm(entry.target, { force: true });
      const restoredData = await readOptional(entry.target);
      if (entry.data ? !restoredData || !restoredData.equals(entry.data) : restoredData !== null)
        throw new ToolError(`restoration integrity check failed for ${entry.path}`, "internal");
      restored++;
    }
    committed = true;
    return restored;
  } finally {
    for (const temporary of staged.values()) await rm(temporary, { force: true });
    // rmdir removes only empty directories, so restored files are never removed with them.
    if (!committed)
      for (const created of createdDirectories.reverse())
        await rmdir(created).catch(() => undefined);
  }
}

async function transactionPaths(
  ctx: ToolContext,
  project: ProjectHandle,
  schematicAffecting: boolean,
  captureReference = false,
): Promise<string[]> {
  const paths = new Set<string>(FILES);
  if (captureReference || (await exists(p(project, ".fabdesk/removed-copper.json"))))
    paths.add(".fabdesk/removed-copper.json");
  if (schematicAffecting) {
    const hierarchy = await inspectSavedHierarchy(ctx, project);
    if (!hierarchy.complete)
      throw new ToolError(
        "cannot safely edit an incomplete saved schematic hierarchy",
        "precondition",
      );
    for (const referenced of hierarchy.referencedFiles) {
      const source = await jailPath(project.dir, referenced);
      paths.add(projectRelative(project.dir, source));
    }
  }
  return [...paths].sort();
}

async function transactionMetadata(directory: string): Promise<TransactionMetadata> {
  const path = await jailPath(directory, "metadata.json");
  const metadata = await readJson<Omit<TransactionMetadata, "files"> & { files?: BackupFile[] }>(
    path,
  ).catch(() => null);
  if (!metadata || typeof metadata !== "object" || typeof metadata.transactionId !== "string")
    throw new ToolError("native transaction backup metadata is missing or invalid", "precondition");
  // A present manifest is validated in full by restore(); it never falls back to the H6 default.
  if (metadata.files !== undefined) return { ...metadata, files: metadata.files };
  // H6 metadata predates manifests. Preserve its three-root-file rollback behavior for existing
  // accepted transactions; every new transaction records and restores its explicit file manifest.
  const files = await Promise.all(
    FILES.map(async (file): Promise<BackupFile> => {
      const saved = await jailPath(directory, file);
      const data = await readFile(saved).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return {
        path: file,
        existed: data !== null,
        bytes: data?.byteLength ?? null,
        sha256: data ? createHash("sha256").update(data).digest("hex") : null,
      };
    }),
  );
  return { ...metadata, files };
}

const SchematicEdit = mutationInputObject({
  symbols: z
    .array(
      mutationInputObject({
        libId: z.string().min(3),
        reference: z.string().min(1),
        value: z.string(),
        footprint: z.string().optional(),
        position: Point,
        unit: z.number().int().positive().optional(),
        bodyStyle: z.number().int().positive().optional(),
        fields: z.record(z.string(), z.string()).optional(),
      }),
    )
    .max(200)
    .optional(),
  symbolUpdates: z
    .array(
      mutationInputObject({
        reference: z.string().min(1),
        newReference: z.string().min(1).optional(),
        position: Point.optional(),
        value: z.string().optional(),
        footprint: z.string().optional(),
        fields: z.record(z.string(), z.string()).optional(),
      }),
    )
    .max(200)
    .optional(),
  connections: z
    .array(
      mutationInputObject({
        name: z.string().min(1),
        nodes: z.array(mutationInputObject({ reference: z.string(), pin: z.string() })).min(1),
        label: z.enum(["local", "global", "none"]).optional(),
      }).refine((connection) => connection.label !== "none" || connection.nodes.length >= 2, {
        message: "direct wire connections require at least two nodes",
        path: ["nodes"],
      }),
    )
    .max(500)
    .optional(),
  wires: z
    .array(mutationInputObject({ start: Point, end: Point }))
    .max(1000)
    .optional(),
  localLabels: z
    .array(mutationInputObject({ text: z.string(), position: Point }))
    .max(500)
    .optional(),
  globalLabels: z
    .array(mutationInputObject({ text: z.string(), position: Point }))
    .max(500)
    .optional(),
  junctions: z.array(Point).max(1000).optional(),
  noConnects: z.array(Point).max(1000).optional(),
  texts: z
    .array(mutationInputObject({ text: z.string(), position: Point }))
    .max(200)
    .optional(),
  deleteItemIds: z.array(z.string()).max(1000).optional(),
});

const FootprintEdit = mutationInputObject({
  reference: z.string().min(1),
  position: Point.optional(),
  rotation: z.number().finite().optional(),
  flip: z.boolean().optional(),
  lock: z.boolean().optional(),
});

const Polygon = mutationInputObject({
  points: z.array(Point).min(3).max(5000),
  holes: z.array(z.array(Point).min(3).max(5000)).max(100).optional(),
});
const Layer = z
  .union([z.number().int(), z.string().min(3)])
  .describe(
    "KiCad layer name such as F.Cu, B.Cu, F.SilkS, B.SilkS, or Edge.Cuts; numeric IDs remain accepted",
  );

const LAYERS: Record<string, number> = {
  "F.Cu": 3,
  "B.Cu": 34,
  "B.Adhes": 35,
  "F.Adhes": 36,
  "B.Paste": 37,
  "F.Paste": 38,
  "B.SilkS": 39,
  "F.SilkS": 40,
  "B.Mask": 41,
  "F.Mask": 42,
  "User.Drawings": 43,
  "User.Comments": 44,
  "Eco1.User": 45,
  "Eco2.User": 46,
  "Edge.Cuts": 47,
  Margin: 48,
  "B.CrtYd": 49,
  "F.CrtYd": 50,
  "B.Fab": 51,
  "F.Fab": 52,
};

export function layerId(layer: string | number): number {
  if (typeof layer === "number") return layer;
  const inner = /^In([1-9]|[12]\d|30)\.Cu$/.exec(layer);
  if (inner) return 3 + Number(inner[1]);
  const value = LAYERS[layer];
  if (value === undefined) throw new ToolError(`unknown KiCad PCB layer ${layer}`, "invalid_args");
  return value;
}
const PcbGeometry = mutationInputObject({
  tracks: z
    .array(
      mutationInputObject({
        start: CopperEndpoint,
        end: CopperEndpoint,
        width: z.number().positive(),
        layer: Layer,
        net: z.string().min(1).optional(),
      }),
    )
    .max(5000)
    .optional(),
  vias: z
    .array(
      mutationInputObject({
        position: Point,
        diameter: z.number().positive(),
        drill: z.number().positive(),
        layers: z.array(Layer).min(2),
        net: z.string().min(1).optional(),
      }),
    )
    .max(2000)
    .optional(),
  zones: z
    .array(
      Polygon.extend({
        layers: z.array(Layer).min(1),
        net: z.string().min(1).optional(),
        name: z.string().optional(),
        clearance: z.number().nonnegative().optional(),
        minThickness: z.number().positive().optional(),
        priority: z.number().int().optional(),
      }),
    )
    .max(200)
    .optional(),
  keepouts: z
    .array(
      Polygon.extend({
        layers: z.array(Layer).min(1),
        name: z.string().optional(),
        copper: z.boolean().optional(),
        vias: z.boolean().optional(),
        tracks: z.boolean().optional(),
        pads: z.boolean().optional(),
        footprints: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
  texts: z
    .array(
      mutationInputObject({
        text: z.string(),
        position: Point,
        layer: Layer,
        size: Point.optional(),
        thickness: z.number().positive().optional(),
        angle: z.number().finite().optional(),
        knockout: z.boolean().optional(),
      }),
    )
    .max(1000)
    .optional(),
  graphics: z
    .array(
      mutationInputObject({
        kind: z.enum(["segment", "rectangle", "arc", "circle", "polygon"]),
        layer: Layer,
        start: Point.optional(),
        end: Point.optional(),
        mid: Point.optional(),
        center: Point.optional(),
        radiusPoint: Point.optional(),
        points: z.array(Point).min(3).max(5000).optional(),
        holes: z.array(z.array(Point).min(3).max(5000)).max(100).optional(),
        strokeWidth: z.number().nonnegative().optional(),
        filled: z.boolean().optional(),
      }),
    )
    .max(2000)
    .optional(),
  deleteItemIds: z.array(z.string().min(1)).max(5000).optional(),
});

export const native_edit_transaction = defineTool({
  name: "native_edit_transaction",
  toolset: "circuit",
  title: "Preview or apply an atomic native edit",
  description:
    "Preview or atomically apply explicit native KiCad schematic, footprint, outline, copper, zone, keepout, text, and graphic changes. Revision mismatches reject the transaction; ordinary failures restore the prior files. Saved-revision or unsaved-work conflicts preserve the live session and may leave earlier operations applied; the error identifies the backup record.",
  inputSchema: {
    mode: z.enum(["preview", "apply"]).default("preview"),
    expectedSchematicRevision: z.string().length(64).nullable().optional(),
    expectedPcbRevision: z.string().length(64).nullable().optional(),
    schematic: SchematicEdit.optional(),
    outline: mutationInputObject({
      points: z.array(Point).min(3).max(100),
      replace: z.boolean().default(false),
    }).optional(),
    footprints: z.array(FootprintEdit).max(500).optional(),
    geometry: PcbGeometry.optional(),
    removeCopperNets: z.array(z.string().min(1)).max(500).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async (
    {
      mode,
      expectedSchematicRevision,
      expectedPcbRevision,
      schematic,
      outline,
      footprints,
      geometry,
      removeCopperNets,
    },
    ctx,
  ) => {
    const project = ctx.requireProject();
    const before = await boundRevisions(ctx, project);
    if (expectedSchematicRevision !== undefined && before.schematic !== expectedSchematicRevision)
      throw new ToolError(
        `stale schematic revision: expected ${expectedSchematicRevision}, actual ${before.schematic}`,
        "precondition",
      );
    if (expectedPcbRevision !== undefined && before.pcb !== expectedPcbRevision)
      throw new ToolError(
        `stale PCB revision: expected ${expectedPcbRevision}, actual ${before.pcb}`,
        "precondition",
      );
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
    if (mode === "preview")
      return ok(
        "Native edit is structurally valid; canonical files were not changed. ERC, DRC, connectivity, and presentation were not evaluated.",
        {
          status: "preview",
          before,
          after: before,
          plan,
          validation: { structural: true, designChecksRun: false },
        },
      );

    const copperBefore =
      geometry?.deleteItemIds?.length || removeCopperNets?.length
        ? await readCopper(project.dir)
        : null;
    const transactionId = `native-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const root = p(project, ".fabdesk/native-revisions");
    const directory = join(root, transactionId);
    const files = await backup(
      project.dir,
      directory,
      await transactionPaths(ctx, project, schematic !== undefined, copperBefore !== null),
    );
    await writeJson(join(directory, "metadata.json"), {
      transactionId,
      createdAt: new Date().toISOString(),
      before,
      plan,
      files,
    } satisfies TransactionMetadata);
    const changes: Record<string, unknown> = {};
    try {
      if (schematic)
        changes["schematic"] = await ctx.services.design.schematicEdit(project.dir, {
          ...(schematic as NativeSchematicEdit),
          save: true,
        });
      if (outline)
        changes["outline"] = await ctx.services.design.defineBoardOutline(
          project.dir,
          outline.points,
          outline.replace,
          expectedPcbRevision ? { expectedSourceSha256: expectedPcbRevision } : {},
        );
      if (footprints?.length) {
        const placed = await ctx.services.design.placeFootprints(
          project.dir,
          footprints as PcbFootprintEdit[],
        );
        if (placed.missing.length)
          throw new ToolError(`unknown footprints: ${placed.missing.join(", ")}`, "invalid_args");
        changes["footprints"] = placed;
      }
      // Replacement copper must remove the old route before creating the candidate. The surrounding
      // native-file backup makes both operations one recoverable transaction if either step fails.
      if (removeCopperNets?.length)
        changes["removedCopper"] = await ctx.services.design.unroute(project.dir, removeCopperNets);
      if (geometry) {
        const pads = geometry.tracks?.some(
          (track) => "reference" in track.start || "reference" in track.end,
        )
          ? await ctx.services.design.query(project.dir, "pads")
          : [];
        const padPosition = (endpoint: z.infer<typeof CopperEndpoint>) => {
          if (!("reference" in endpoint)) return endpoint;
          const pad = pads.find(
            (row) =>
              String(row["component"]) === endpoint.reference &&
              String(row["number"]) === endpoint.pad,
          );
          if (!pad)
            throw new ToolError(
              `unknown PCB pad ${endpoint.reference}:${endpoint.pad}`,
              "invalid_args",
            );
          return { x: Number(pad["x"]), y: Number(pad["y"]) };
        };
        const resolved = {
          ...geometry,
          ...(geometry.tracks
            ? {
                tracks: geometry.tracks.map((track) => ({
                  ...track,
                  start: padPosition(track.start),
                  end: padPosition(track.end),
                  layer: layerId(track.layer),
                })),
              }
            : {}),
          ...(geometry.vias
            ? { vias: geometry.vias.map((via) => ({ ...via, layers: via.layers.map(layerId) })) }
            : {}),
          ...(geometry.zones
            ? {
                zones: geometry.zones.map((zone) => ({
                  ...zone,
                  layers: zone.layers.map(layerId),
                })),
              }
            : {}),
          ...(geometry.keepouts
            ? {
                keepouts: geometry.keepouts.map((keepout) => ({
                  ...keepout,
                  layers: keepout.layers.map(layerId),
                })),
              }
            : {}),
          ...(geometry.texts
            ? { texts: geometry.texts.map((item) => ({ ...item, layer: layerId(item.layer) })) }
            : {}),
          ...(geometry.graphics
            ? {
                graphics: geometry.graphics.map((item) => ({
                  ...item,
                  layer: layerId(item.layer),
                })),
              }
            : {}),
        } as PcbGeometryEdit;
        changes["geometry"] = await ctx.services.design.editBoardGeometry(project.dir, resolved);
      }
      const removedCopperFacts = copperBefore
        ? await recordRemoval(project.dir, copperBefore, await readCopper(project.dir))
        : null;
      const after = await boundRevisions(ctx, project);
      await writeJson(join(root, "last-accepted.json"), { transactionId, before, after });
      return ok(
        `Atomic native edit ${transactionId} accepted; design checks were not run.${removedCopperFacts ? `\n${qualityText({ nets: removedCopperFacts.nets, pairs: [], reference: [], lengthConvention: "chord" })}` : ""}`,
        {
          ...(removedCopperFacts ? { removedCopperFacts } : {}),
          status: "accepted",
          transactionId,
          before,
          after,
          plan,
          changes,
          validation: { structural: true, designChecksRun: false },
        },
      );
    } catch (error) {
      // Conflict refusal preserves external saved bytes and unsaved live edits. Rollback must
      // not overwrite the former or release the latter.
      if (error instanceof NativeRevisionConflict) {
        throw new NativeRevisionConflict(
          `native edit ${transactionId} refused; session and current files preserved; ` +
            `completed operations: ${Object.keys(changes).join(", ") || "none"}; ` +
            `earlier operations may remain applied; pre-edit backup: .fabdesk/native-revisions/${transactionId}/metadata.json; ` +
            `save live work before explicit recovery: ${error.message}`,
        );
      }
      await ctx.services.design.release(project.dir).catch(() => undefined);
      const restoredFiles = await restore(project.dir, directory, files);
      throw new ToolError(
        `native edit ${transactionId} rejected; canonical files restored: ${error instanceof Error ? error.message : String(error)} (${restoredFiles} file(s))`,
        error instanceof ToolError ? error.code : "internal",
      );
    }
  },
});

export const native_edit_rollback = defineTool({
  name: "native_edit_rollback",
  toolset: "circuit",
  title: "Rollback the last accepted native edit",
  description:
    "Restore the exact native KiCad files saved before an accepted native_edit_transaction. The current revisions must still match that transaction's after revisions, preventing rollback over newer work.",
  inputSchema: { transactionId: z.string().optional() },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ transactionId }, ctx) => {
    const project = ctx.requireProject();
    const root = p(project, ".fabdesk/native-revisions");
    const accepted = await readJson<{
      transactionId: string;
      before: Awaited<ReturnType<typeof revisions>>;
      after: Awaited<ReturnType<typeof revisions>>;
    }>(join(root, "last-accepted.json")).catch(() => null);
    if (!accepted)
      throw new ToolError("no accepted native edit is available to roll back", "precondition");
    if (transactionId && transactionId !== accepted.transactionId)
      throw new ToolError(
        `last accepted transaction is ${accepted.transactionId}, not ${transactionId}`,
        "precondition",
      );
    const current = await boundRevisions(ctx, project);
    if (JSON.stringify(current) !== JSON.stringify(accepted.after))
      throw new ToolError(
        "native files changed after the accepted transaction; refusing stale rollback",
        "precondition",
      );
    const directory = await jailPath(root, accepted.transactionId)
      .then((path) => jailPath(project.dir, projectRelative(project.dir, path)))
      .catch(() => {
        throw new ToolError("native transaction backup directory is invalid", "precondition");
      });
    const metadata = await transactionMetadata(directory);
    if (metadata.transactionId !== accepted.transactionId)
      throw new ToolError("native transaction backup identity mismatch", "precondition");
    await preflightRestore(project.dir, directory, metadata.files);
    if (!ctx.services.design.withSavedFilesRecovery)
      throw new ToolError(
        "native saved-file recovery is unavailable in this runtime",
        "unavailable",
      );
    const restoredFiles = await ctx.services.design.withSavedFilesRecovery(
      project.dir,
      async () => {
        const immediatelyBefore = await boundRevisions(ctx, project);
        if (JSON.stringify(immediatelyBefore) !== JSON.stringify(accepted.after))
          throw new ToolError(
            "native files changed before rollback; refusing stale rollback",
            "precondition",
          );
        return restore(project.dir, directory, metadata.files);
      },
    );
    return ok(`Rolled back ${accepted.transactionId}.`, {
      status: "rolled-back",
      transactionId: accepted.transactionId,
      restoredFiles,
      before: current,
      after: await boundRevisions(ctx, project),
    });
  },
});

export const pcb_edit_copper = defineTool({
  name: "pcb_edit_copper",
  toolset: "circuit",
  title: "Atomically edit PCB copper",
  description:
    "Atomically validate and apply native tracks, vias, copper deletion by inspected ID, or removal of named routed nets in one recoverable transaction. The normal mode=apply path validates before saving and restores prior files if rejected; use mode=preview only when a non-mutating forecast is specifically needed. For reroutes, write a project-local JSON candidate and pass candidateFile with removeNets so old copper is replaced in one recoverable transaction. Applying named-net removal without replacement requires an explicit commitRemovalOnly acknowledgement. Track endpoints accept exact millimetre points or semantic {reference,pad} endpoints resolved from the saved board. Rejects stale PCB revisions. To re-route what an edit or a measurement opened, board_route (last-mile actions) supersedes hand-written copper edits: it tries router and pair steps on the whole board and keeps only what improves A1-A9.",
  inputSchema: {
    mode: z.enum(["preview", "apply"]).default("apply"),
    expectedPcbRevision: z.string().length(64).optional(),
    checkDrc: z.boolean().default(false).describe("After applying, run a saved-board PCB-only DRC and return its actual counts; errors leave the requested edit saved for repair."),
    tracks: PcbGeometry.shape.tracks,
    vias: PcbGeometry.shape.vias,
    candidateFile: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Project-relative JSON file containing {tracks:[...], vias:[...]}; keeps large generated routes durable and out of the tool-call payload",
      ),
    deleteItemIds: PcbGeometry.shape.deleteItemIds,
    removeNets: z.array(z.string().min(1)).max(500).optional(),
    commitRemovalOnly: z
      .boolean()
      .default(false)
      .describe(
        "Explicitly acknowledge that named-net copper removal should persist without replacement geometry",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async (
    {
      mode,
      checkDrc,
      expectedPcbRevision,
      tracks,
      vias,
      candidateFile,
      deleteItemIds,
      removeNets,
      commitRemovalOnly,
    },
    ctx,
  ) => {
    if (checkDrc && mode === "preview") throw new ToolError("checkDrc requires mode=apply", "invalid_args");
    if (candidateFile && (tracks?.length || vias?.length))
      throw new ToolError(
        "candidateFile cannot be combined with inline tracks or vias",
        "invalid_args",
      );
    let candidate: {
      tracks?: z.infer<typeof PcbGeometry>["tracks"];
      vias?: z.infer<typeof PcbGeometry>["vias"];
    } = {};
    if (candidateFile) {
      const project = ctx.requireProject();
      const path = await jailPath(project.dir, candidateFile);
      const metadata = await stat(path).catch(() => null);
      if (!metadata?.isFile())
        throw new ToolError(`copper candidate not found: ${candidateFile}`, "not_found");
      if (metadata.size > 5_000_000)
        throw new ToolError(`copper candidate exceeds 5 MB: ${candidateFile}`, "invalid_args");
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        throw new ToolError(
          `copper candidate is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          "invalid_args",
        );
      }
      const parsed = PcbGeometry.pick({ tracks: true, vias: true }).strict().safeParse(raw);
      if (!parsed.success)
        throw new ToolError(
          `invalid copper candidate: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
          "invalid_args",
        );
      candidate = parsed.data;
    }
    const replacementTracks = candidate.tracks ?? tracks;
    const replacementVias = candidate.vias ?? vias;
    const replacementCount = (replacementTracks?.length ?? 0) + (replacementVias?.length ?? 0);
    if (
      mode === "apply" &&
      (removeNets?.length ?? 0) > 0 &&
      replacementCount === 0 &&
      !commitRemovalOnly
    )
      throw new ToolError(
        "named-net copper removal has no replacement; supply candidateFile or inline replacement geometry for an atomic reroute, or set commitRemovalOnly=true to explicitly persist removal alone",
        "precondition",
      );
    const result = await native_edit_transaction.handler(
      {
        mode,
        ...(expectedPcbRevision ? { expectedPcbRevision } : {}),
        ...(replacementTracks || replacementVias || deleteItemIds
          ? {
              geometry: {
                ...(replacementTracks ? { tracks: replacementTracks } : {}),
                ...(replacementVias ? { vias: replacementVias } : {}),
                ...(deleteItemIds ? { deleteItemIds } : {}),
              },
            }
          : {}),
        ...(removeNets ? { removeCopperNets: removeNets } : {}),
      },
      ctx,
    );
    if (checkDrc && !result.isError) {
      const project = ctx.requireProject(), cli = await requireKicad(ctx), board = p(project, PROJECT_FILES.boardPcb), revision = await sha(board);
      const temporary = await jailPath(project.dir, `.fabdesk/native-checks/${randomUUID()}.json`);
      await mkdir(dirname(temporary), { recursive: true });
      try {
        const report = await ctx.services.kicad.runDrc(cli, { board, outFile: temporary, severity: "all", schematicParity: false, signal: ctx.signal });
        if (await sha(board) !== revision) throw new ToolError("Saved PCB changed during the post-edit DRC; inspect the current board before checking again", "precondition");
        const receipt = { ...report, pcbRevision: { sha256: revision }, schematicParityChecked: false };
        const path = await jailPath(project.dir, "reports/copper-drc.json"); await writeJson(path, receipt);
        return { ...result, text: `${result.text}\nSaved-board PCB-only DRC: ${report.counts.errors} errors, ${report.counts.unconnected} opens.`, json: { ...(result.json as Record<string, unknown>), ...(candidateFile ? { candidateFile } : {}), drc: { ...receipt, path } }, isError: report.counts.errors > 0 || report.counts.unconnected > 0 };
      } finally { await rm(temporary, { force: true }); }
    }
    if (candidateFile && result.json && typeof result.json === "object")
      return { ...result, json: { ...(result.json as Record<string, unknown>), candidateFile } };
    return result;
  },
});

export const pcb_edit_graphics = defineTool({
  name: "pcb_edit_graphics",
  toolset: "circuit",
  title: "Atomically edit PCB outline and graphics",
  description:
    "Atomically validate and apply a native board outline, zones, keepouts, text, graphics, or deletion by inspected ID in one recoverable transaction. The normal mode=apply path validates before saving and restores prior files if rejected; use mode=preview only when a non-mutating forecast is specifically needed. Uses millimetres and rejects stale PCB revisions.",
  inputSchema: {
    mode: z.enum(["preview", "apply"]).default("apply"),
    expectedPcbRevision: z.string().length(64).optional(),
    outline: mutationInputObject({
      points: z.array(Point).min(3).max(100),
      replace: z.boolean().default(false),
    }).optional(),
    zones: PcbGeometry.shape.zones,
    keepouts: PcbGeometry.shape.keepouts,
    texts: PcbGeometry.shape.texts,
    graphics: PcbGeometry.shape.graphics,
    deleteItemIds: PcbGeometry.shape.deleteItemIds,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: (
    { mode, expectedPcbRevision, outline, zones, keepouts, texts, graphics, deleteItemIds },
    ctx,
  ) =>
    native_edit_transaction.handler(
      {
        mode,
        ...(expectedPcbRevision ? { expectedPcbRevision } : {}),
        ...(outline ? { outline } : {}),
        ...(zones || keepouts || texts || graphics || deleteItemIds
          ? {
              geometry: {
                ...(zones ? { zones } : {}),
                ...(keepouts ? { keepouts } : {}),
                ...(texts ? { texts } : {}),
                ...(graphics ? { graphics } : {}),
                ...(deleteItemIds ? { deleteItemIds } : {}),
              },
            }
          : {}),
      },
      ctx,
    ),
});

export const nativeEditTools = [
  native_edit_transaction,
  native_edit_rollback,
  pcb_edit_copper,
  pcb_edit_graphics,
];
