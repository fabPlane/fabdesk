import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import {
  findKicadCli,
  kicadVersionAtLeast,
  measureGlb,
  readSavedBoardModels,
} from "@fabdesk/kicad";
import type { PcbModelGap } from "@fabdesk/protocol";
import { jailPath, ensureDir } from "../fs";
import { ToolError, type ToolContext } from "../registry";
import { requireKicad, ok } from "./common";

export function pcbCreatorVersion(text: string): string | null {
  return (
    /^\s*\(generator_version\s+"(\d+\.\d+[^"\r\n]*)"\)/m.exec(text.slice(0, 4096))?.[1] ?? null
  );
}

/** Use a compatible installed exporter for previews without changing the user's settings. */
export async function boardPreviewCli(ctx: ToolContext, text: string) {
  const configured = await requireKicad(ctx), version = pcbCreatorVersion(text);
  if (!version || kicadVersionAtLeast(configured.version, version)) return configured;
  const compatible = await findKicadCli(undefined, { minimumVersion: version, ...(configured.trace ? { trace: configured.trace } : {}) });
  if (compatible) return compatible;
  throw new ToolError(`This board was saved with KiCad ${version}. Install that version or newer to prepare its views. Your PCB has not been changed.`, "precondition");
}

/** Advisory only: the saving application version is not a file-format compatibility guarantee. */
export async function pcbModelReadiness(ctx: ToolContext, paths: string[]) {
  const project = ctx.requireProject();
  const cli = await ctx.services.kicad.resolveCli();
  const boards = await Promise.all(
    paths.map(async (path) => {
      if (!path.toLowerCase().endsWith(".kicad_pcb"))
        throw new ToolError("Choose a KiCad PCB file", "invalid_args");
      const source = await readFile(await jailPath(project.dir, path), "utf8");
      const savedWith = pcbCreatorVersion(source);
      return {
        path,
        savedWith,
        newer: !!savedWith && !!cli && !kicadVersionAtLeast(cli.version, savedWith),
      };
    }),
  );
  const newest = boards
    .map((b) => b.savedWith)
    .filter((v): v is string => !!v)
    .sort((a, b) => (kicadVersionAtLeast(a, b) ? -1 : 1))[0];
  const needsSetup = !cli || boards.some((b) => b.newer);
  const candidate = needsSetup
    ? await findKicadCli(undefined, { ...(newest ? { minimumVersion: newest } : {}) })
    : null;
  return ok("Checked the local PCB exporter; actual exports still validate compatibility.", {
    exporter: cli ? { path: cli.path, version: cli.version } : null,
    suggested:
      candidate && candidate.path !== cli?.path
        ? { path: candidate.path, version: candidate.version }
        : null,
    boards,
    needsSetup,
  });
}

export function displayCoverage(board: string, roots: ReturnType<typeof measureGlb>["roots"]) {
  const counts = new Map<string, number>();
  for (const node of roots)
    if (node.bounds && node.vertices) counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  const footprints = readSavedBoardModels(board).filter(
    (f) =>
      !f.dnp &&
      // Bare mounting holes and fiducials are already geometry in the board body.
      (f.models.length > 0 || !/mounting.?hole|fiducial/i.test(f.footprint)),
  );
  const details: PcbModelGap[] = footprints.flatMap((f) => {
    const visible = f.models.filter((m) => !m.hidden);
    const loaded = f.ref ? (counts.get(f.ref) ?? 0) : 0;
    const reason: PcbModelGap["reason"] | null = !f.models.length
      ? "unassigned"
      : !visible.length
        ? "hidden"
        : loaded === 0
          ? "not-loaded"
          : loaded < visible.length
            ? "partial"
            : null;
    return reason
      ? [
          {
            ref: f.ref ?? f.footprint,
            footprint: f.footprint,
            reason,
            models: visible.map((m) => m.declared),
          },
        ]
      : [];
  });
  return {
    total: footprints.length,
    loaded: footprints.length - details.length,
    missing: details.map((f) => f.ref),
    details,
  };
}

/** A fresh immutable export; never reuse an old file after a failed KiCad process. */
export async function renderPcbDisplay(ctx: ToolContext, path: string, expected: string) {
  const project = ctx.requireProject();
  if (!path.toLowerCase().endsWith(".kicad_pcb"))
    throw new ToolError("Choose a KiCad PCB file", "invalid_args");
  const board = await jailPath(project.dir, path);
  const original = await readFile(board, "utf8");
  const revision = (text: string) => createHash("sha256").update(text).digest("hex");
  if (revision(original) !== expected)
    throw new ToolError(
      "PCB changed. Refresh the board before loading its 3D model.",
      "precondition",
    );
  const cli = await requireKicad(ctx);
  const relativePath = `renders/pcb-models/${randomUUID()}.glb`;
  const output = await jailPath(project.dir, relativePath);
  await ensureDir(await jailPath(project.dir, "renders/pcb-models"));
  try {
    const result = await ctx.services.kicad.exportGlb(cli, {
      board,
      output,
      mechanical: true,
      signal: ctx.signal,
    });
    if (revision(await readFile(board, "utf8")) !== expected)
      throw new ToolError("PCB changed during export. Refresh and try again.", "precondition");
    const bytes = await readFile(output);
    if (bytes.length > 50 * 1024 * 1024)
      throw new ToolError("PCB model exceeds the 50 MB viewer limit.", "precondition");
    const measured = measureGlb(bytes);
    if (!measured.roots.some((r) => r.bounds && r.vertices))
      throw new ToolError("KiCad exported an empty model.", "precondition");
    return ok("Exported PCB geometry from the saved KiCad design.", {
      modelPath: relativePath,
      pcbRevision: expected,
      coverage: displayCoverage(original, measured.roots),
      bounds: {
        minX: Math.min(...measured.roots.flatMap((r) => (r.bounds ? [r.bounds.minX] : []))),
        minY: Math.min(...measured.roots.flatMap((r) => (r.bounds ? [r.bounds.minY] : []))),
        minZ: Math.min(...measured.roots.flatMap((r) => (r.bounds ? [r.bounds.minZ] : []))),
        maxX: Math.max(...measured.roots.flatMap((r) => (r.bounds ? [r.bounds.maxX] : []))),
        maxY: Math.max(...measured.roots.flatMap((r) => (r.bounds ? [r.bounds.maxY] : []))),
        maxZ: Math.max(...measured.roots.flatMap((r) => (r.bounds ? [r.bounds.maxZ] : []))),
      },
      warnings: result.warnings,
    });
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
}
