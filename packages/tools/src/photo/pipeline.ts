import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  CircuitIntent,
  PickedPart,
  PhotoPipelineSession,
  PhotoPipelineStepId,
  PhotoSighting,
} from "@fabdesk/protocol";
import { emptyPhotoSteps, PhotoSighting as PhotoSightingSchema } from "@fabdesk/protocol";
import { PROJECT_FILES, exists, jailPath, writeJson } from "../fs";
import { ToolError, type ToolContext } from "../registry";
import { p } from "../tools/common";
import { inferCircuit } from "./infer";
import { pickParts } from "./parts";
import { draftBoard, draftSchematic, writeNetlist, writePublishMeta } from "./draft";
import { HeuristicVisionProvider, type ScaleHint, type VisionPhoto } from "./vision";

export const PHOTO_FILES = {
  sighting: "photo/sighting.json",
  intent: "photo/intent.json",
  draft: "photo/draft.json",
  session: "photo/session.json",
  publish: "photo/publish.json",
} as const;

export async function loadSighting(ctx: ToolContext): Promise<PhotoSighting | null> {
  const path = p(ctx.requireProject(), PHOTO_FILES.sighting);
  if (!(await exists(path))) return null;
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const parsed = PhotoSightingSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

export function newPhotoSession(projectId: string): PhotoPipelineSession {
  return {
    id: `ph_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    projectId,
    status: "running",
    currentStep: "read",
    steps: emptyPhotoSteps(),
    error: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
}

export async function saveSession(ctx: ToolContext, session: PhotoPipelineSession): Promise<void> {
  await writeJson(p(ctx.requireProject(), PHOTO_FILES.session), session);
}

function emit(ctx: ToolContext, session: PhotoPipelineSession, step?: PhotoPipelineStepId, note?: string): void {
  ctx.services.bus.emit({
    ts: Date.now(),
    topic: "photo.progress",
    session,
    ...(step ? { step } : {}),
    ...(note ? { note } : {}),
  });
}

export function markStep(
  session: PhotoPipelineSession,
  id: PhotoPipelineStepId,
  status: "running" | "done" | "failed",
  note?: string,
  artifact?: string,
): PhotoPipelineSession {
  const steps = session.steps.map((s) =>
    s.id === id
      ? {
          ...s,
          status,
          ...(note ? { note } : {}),
          ...(artifact ? { artifact } : {}),
        }
      : s,
  );
  return {
    ...session,
    currentStep: status === "running" ? id : session.currentStep,
    steps,
  };
}

export async function analyzePhotos(
  ctx: ToolContext,
  args: {
    photos: string[];
    description?: string;
    hint?: ScaleHint;
    items?: PhotoSighting["items"];
    openSourceSuspected?: boolean;
    sides?: PhotoSighting["photos"][number]["side"][];
  },
): Promise<{ sighting: PhotoSighting; session: PhotoPipelineSession }> {
  const project = ctx.requireProject();
  let session = newPhotoSession(project.id);
  ctx.services.bus.emit({ ts: Date.now(), topic: "photo.started", session });
  session = markStep(session, "read", "running");
  await saveSession(ctx, session);
  emit(ctx, session, "read", "Reading photos");
  ctx.progress(0.1, "reading photos");

  const vision = ctx.services.vision ?? new HeuristicVisionProvider();
  const loaded: VisionPhoto[] = [];
  for (const [i, rel] of args.photos.entries()) {
    const abs = await jailPath(project.dir, rel);
    const bytes = new Uint8Array(await readFile(abs));
    loaded.push({
      path: rel,
      bytes,
      mime: mimeOf(rel),
      ...(args.sides?.[i] ? { side: args.sides[i] } : {}),
    });
  }
  const sighting = await vision.analyze({
    photos: loaded,
    ...(args.description ? { description: args.description } : {}),
    ...(args.hint ? { hint: args.hint } : {}),
    ...(args.items ? { items: args.items } : {}),
    ...(args.openSourceSuspected ? { openSourceSuspected: true } : {}),
  });
  await writeJson(p(project, PHOTO_FILES.sighting), sighting);
  session = markStep(session, "read", "done", `${sighting.items.length} items`, PHOTO_FILES.sighting);
  await saveSession(ctx, session);
  emit(ctx, session, "read", "Sighting written");
  return { sighting, session };
}

export async function continueToProject(
  ctx: ToolContext,
  sighting: PhotoSighting,
  description: string,
  session: PhotoPipelineSession,
): Promise<{
  session: PhotoPipelineSession;
  intent: CircuitIntent;
  parts: PickedPart[];
  draft: Record<string, unknown>;
}> {
  const project = ctx.requireProject();
  try {
    ctx.progress(0.2, "inferring circuit");
    session = markStep(session, "infer", "running");
    await saveSession(ctx, session);
    emit(ctx, session, "infer");
    const intent = inferCircuit(sighting, description);
    await writeJson(p(project, PHOTO_FILES.intent), intent);
    session = markStep(session, "infer", "done", `${intent.blocks.length} blocks`, PHOTO_FILES.intent);
    await saveSession(ctx, session);

    ctx.progress(0.3, "picking parts");
    session = markStep(session, "parts", "running");
    await saveSession(ctx, session);
    emit(ctx, session, "parts");
    const parts = await pickParts(sighting, intent, (query, kind) =>
      kind === "symbol"
        ? ctx.services.design.searchSymbols(query, 8)
        : ctx.services.design.searchFootprints(query, 8),
    );
    session = markStep(session, "parts", "done", `${parts.length} parts`);
    await saveSession(ctx, session);

    ctx.progress(0.4, "drafting schematic and board");
    session = markStep(session, "draft", "running");
    await saveSession(ctx, session);
    emit(ctx, session, "draft");
    const netlist = await writeNetlist(ctx, sighting, intent, parts);
    await draftSchematic(ctx, parts, intent);
    const { placements } = await draftBoard(ctx, sighting, parts);
    const publish = await writePublishMeta(ctx, sighting);
    const nextBoard = {
      ...project.manifest().board,
      widthMm: sighting.scale.boardWidthMm,
      heightMm: sighting.scale.boardHeightMm,
    };
    await project.updateManifest({
      board: nextBoard,
      source: {
        kind: "photo",
        photos: sighting.photos.map((photo) => photo.path),
        startedAt: new Date().toISOString(),
      },
    });
    session = markStep(session, "draft", "done", "schematic + PCB", PROJECT_FILES.netlistJson);
    await saveSession(ctx, session);

    ctx.progress(0.75, "routing");
    session = markStep(session, "verify", "running", "routing");
    await saveSession(ctx, session);
    emit(ctx, session, "verify", "routing");
    const route = await ctx.services.design.route(
      project.dir,
      { router: "fab_router" },
      { signal: ctx.signal },
    );
    ctx.progress(0.88, "ERC/DRC");
    const cli = await ctx.services.kicad.resolveCli();
    let erc = { counts: { errors: 0, warnings: 0 } };
    let drc = { counts: { errors: 0, warnings: 0, unconnected: 0 } };
    if (cli) {
      const sch = p(project, PROJECT_FILES.boardSch);
      const pcb = p(project, PROJECT_FILES.boardPcb);
      if (await exists(sch)) {
        erc = await ctx.services.kicad.runErc(cli, { schematic: sch, outFile: p(project, PROJECT_FILES.reports, "erc.json") });
      }
      if (await exists(pcb)) {
        drc = await ctx.services.kicad.runDrc(cli, { board: pcb, outFile: p(project, PROJECT_FILES.reports, "drc.json") });
      }
    }
    const draft = {
      sightingPath: PHOTO_FILES.sighting,
      intentPath: PHOTO_FILES.intent,
      netlist,
      parts,
      placements,
      publish,
      route: { routed: route.routed, total: route.total, open: route.unrouted.length },
      erc: erc.counts,
      drc: drc.counts,
    };
    await writeJson(p(project, PHOTO_FILES.draft), draft);
    session = markStep(session, "verify", "done", `DRC ${drc.counts.errors} errors`, PHOTO_FILES.draft);
    session = {
      ...session,
      status: "completed",
      currentStep: null,
      endedAt: new Date().toISOString(),
    };
    await saveSession(ctx, session);
    ctx.services.bus.emit({ ts: Date.now(), topic: "photo.done", session });
    ctx.progress(1, "done");
    return { session, intent, parts, draft };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    session = {
      ...session,
      status: "failed",
      error: message,
      endedAt: new Date().toISOString(),
      steps: session.steps.map((s) => (s.status === "running" ? { ...s, status: "failed", note: message } : s)),
    };
    await saveSession(ctx, session).catch(() => {});
    ctx.services.bus.emit({ ts: Date.now(), topic: "photo.failed", session, error: message });
    throw e instanceof ToolError ? e : new ToolError(message, "internal");
  }
}

function mimeOf(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext] ?? "image/png";
}
