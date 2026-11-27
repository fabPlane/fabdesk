import { snapshotProjectDependencies, visiblePublishedFile } from "@fabdesk/tools";
/** Hono application: auth + origin guard, control API, tools/jobs, MCP, events. */
import { readFile, stat, mkdir } from "node:fs/promises";
import { threadTitleFrom } from "../thread-title";
import { withRouterRuntime } from "./router-runtime";
import { basename, extname, isAbsolute, join } from "node:path";
import { Hono, type Context } from "hono";
import {
  isEditableSketchSource,
  MAX_EDITABLE_SKETCH_BYTES,
  AgentPreference,
  AgentEffortPreference,
  CreateProject,
  CreateThread,
  DevicePushRegistration,
  PairClaim,
  pairingUrlFromEndpoints,
  OpenCatalogIndex,
  OrderVendorId,
  PatchThread,
  ResolveApproval,
  ResolveInput,
  SendMessage,
  RouterCatalogId,
  Settings,
  CLIENT_FUNNEL_EVENTS,
  funnelHandoffFromRecord,
  type ClientFunnelEvent,
  SpeechCloudSecret,
  StartFinishIt,
  StartOrder,
  TailscaleServeRequest,
  type AgentId,
  type AgentInfo,
  type AuthState,
  type CoreEndpoint,
  type DevicePushResult,
  type DoctorReport,
  type Health,
  type Me,
  type PairClaimResult,
  type PrivacyStatus,
  type RelayPhase,
  type RemoteStatus,
  type TailscaleState,
} from "@fabdesk/protocol";
import { z } from "zod/v4";
import {
  PROJECT_FILES,
  inspectProjectBoardSources,
  readProjectBom,
  makeContext,
  ToolError,
  jailPath,
  toolRoutes,
  writeAtomic,
  type ContextFactory,
  type CoreServices,
  type ToolRegistry,
} from "@fabdesk/tools";
import { extractToken, originAllowed, type TokenSet } from "../auth";
import type { AuthFacade } from "../auth-facade";
import type { EventBus } from "../bus";
import type { CoreConfig } from "../config";
import type { Store } from "../db";
import type { Funnel } from "../funnel";
import type { JobRunner } from "../jobs";
import type { McpSessionManager } from "../mcp-sessions";
import { InvalidParentDirectory, type ProjectStore } from "../projects";
import type { AgentRunManager } from "../agent-runs";
import type { FinishItManager } from "../finish-it";
import type { DeviceStore } from "../devices";
import type { RemoteListener } from "../remote";
import { VIA_HEADER, type RelayState } from "../relay";
import { listenAddresses, machineName, serveFor } from "../net";
import { tailscaleProvider, type TailscaleProvider } from "../tailscale";
import { logger, errMsg } from "../log";
import { allowedCloneUrl, fetchOpenCatalog, findCatalogProject } from "../opensource/catalog";
import { createPreviewCache, resolveCatalogPreview } from "../opensource/preview";
import {
  assessOrderReadiness,
  loadOrderCheckEvidence,
  orderVendors,
  startOrderSession,
} from "../opensource/order";
import { hydrateClonedBoard, listKicadPcbFiles, remixCatalogProject } from "../opensource/remix";
import { parsePublicGitHubUrl } from "../github-import";
import { applyErrorReporting, captureCoreException } from "../sentry";
import { parseTopics, sseResponse } from "./sse";
import { cloudRoutes } from "./cloud-routes";
import { resolveNativeBoardBinding } from "../assembly-board-binding";
import { commentRoutes } from "./comment-routes";
import { outputTrashRoutes } from "./output-trash-routes";
import { createSpeechService, SpeechProviderError, type SpeechService } from "../speech";

export type AppDeps = {
  /** The relay link, for `/v1/remote` and `/health`; optional so tests without a relay still build an app. */
  relay?: { state(): RelayState; phase(): RelayPhase } | undefined;
  /** Endpoints outside `listenAddresses` (the relay), merged into what pairing advertises. */
  extraEndpoints?: (() => CoreEndpoint[]) | undefined;
  config: CoreConfig;
  store: Store;
  bus: EventBus;
  jobs: JobRunner;
  projects: ProjectStore;
  tokens: TokenSet;
  registry: ToolRegistry;
  ctxFactory: ContextFactory;
  services: CoreServices;
  mcp: McpSessionManager;
  auth: AuthFacade;
  runs: AgentRunManager | null;
  finishIt?: FinishItManager | null;
  doctor: () => Promise<DoctorReport>;
  agents: () => Promise<AgentInfo[]>;
  shutdown: (reason: string) => void;
  startedAt: number;
  extraOrigins?: string[];
  devices: DeviceStore;
  remote: RemoteListener;
  /**
   * Which listener this app instance answers on. The remote listener is reachable from the
   * tailnet, so it does not serve MCP (whose DNS-rebinding allowlist is bound to loopback),
   * shutdown, or device administration.
   */
  listener: "local" | "remote";
  /** What the Tailscale CLI reports, for endpoint discovery. The shared provider when absent. */
  tailscale?: TailscaleProvider;
  /** After a successful `PATCH /settings`, e.g. to push the portable slice to fabplane.com. */
  onSettingsChanged?: (settings: Settings) => void;
  /** Whether undecided installations must answer the first-install privacy screen. */
  privacy?: () => PrivacyStatus;
  /** Speak-to-the-agent transcription. Tests inject a fake provider. */
  speech?: SpeechService;
  /** Onboarding funnel snapshot + website handoff. */
  funnel?: Funnel;
};

export type Env = { Variables: { token?: string; principalSubject?: string } };

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".tsx": "text/x-tsx; charset=utf-8",
  ".ts": "text/x-typescript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".glb": "model/gltf-binary",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
  ".kicad_pcb": "text/plain; charset=utf-8",
  ".kicad_sch": "text/plain; charset=utf-8",
  ".kicad_pro": "application/json",
};

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const speech =
    deps.speech ?? createSpeechService({ settings: deps.store.settings, home: deps.config.home });

  app.onError((err, c) => {
    if (err instanceof InvalidParentDirectory)
      return c.json({ error: "invalid_parent_directory", message: err.message }, 400);
    if (err instanceof ToolError) {
      const status =
        err.code === "invalid_args"
          ? 400
          : err.code === "not_found"
            ? 404
            : err.code === "precondition"
              ? 412
              : err.code === "unavailable"
                ? 503
                : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof z.ZodError)
      return c.json({ error: z.prettifyError(err), code: "invalid_args" }, 400);
    logger.error("unhandled", { path: c.req.path, error: errMsg(err) });
    // Route pattern, not the concrete path: file routes carry project-relative names.
    captureCoreException(err, { "http.method": c.req.method, "http.route": c.req.routePath });
    return c.json({ error: errMsg(err), code: "internal" }, 500);
  });

  // Origin guard: browsers on foreign origins are rejected before anything else. Allowed browser
  // origins (the Electron renderer on file:// or the Vite dev server, WebMCP pages) get CORS headers,
  // and their preflights are answered before the bearer check since browsers send them without auth.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin") ?? null;
    if (!originAllowed(origin, deps.extraOrigins ?? []))
      return c.json({ error: "forbidden origin" }, 403);
    const applyCors = (headers: Headers) => {
      if (origin === null || origin === "") return;
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "authorization, content-type, last-event-id, mcp-session-id, mcp-protocol-version",
      );
      headers.set(
        "Access-Control-Expose-Headers",
        "mcp-session-id, content-disposition, content-length",
      );
      headers.set("Access-Control-Max-Age", "600");
    };
    if (c.req.method === "OPTIONS") {
      const preflight = new Response(null, { status: 204 });
      applyCors(preflight.headers);
      return preflight;
    }
    await next();
    applyCors(c.res.headers);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: deps.config.version,
      pid: process.pid,
      channel: deps.config.channel,
      authMode: deps.auth.mode,
      uptimeMs: Date.now() - deps.startedAt,
      mcpSessions: deps.mcp.activeCount(),
      coreId: deps.store.settings.coreId(),
      relay: deps.relay?.phase() ?? "off",
      ...(deps.config.runtimeId ? { runtimeId: deps.config.runtimeId } : {}),
    } satisfies Health),
  );

  // Claiming a pairing code is how a phone gets its first credential, so it cannot carry one.
  // The short-lived, one-time pairing token minted by `/v1/devices/pair/start` is the credential.
  app.post("/v1/devices/pair/claim", async (c) => {
    const body = PairClaim.parse(await c.req.json());
    let issued: ReturnType<DeviceStore["claim"]>;
    try {
      issued = deps.devices.claim(body);
    } catch (e) {
      return c.json({ error: errMsg(e), code: "unauthorized" }, 401);
    }
    deps.bus.emit({
      topic: "device.paired",
      ts: Date.now(),
      deviceId: issued.device.id,
      label: issued.device.label,
    });
    logger.info("device paired", {
      id: issued.device.id,
      label: issued.device.label,
      platform: issued.device.platform,
    });
    return c.json({
      deviceToken: issued.token,
      device: issued.device,
      core: {
        name: machineName(),
        version: deps.config.version,
        platform: process.platform,
        coreId: deps.store.settings.coreId(),
      },
    } satisfies PairClaimResult);
  });

  // Bearer auth for everything else (`?token=` allowed for SSE / WS which cannot set headers).
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const allowQuery =
      c.req.path === "/events" ||
      c.req.path === "/ws" ||
      c.req.path.startsWith("/opensource/preview/");
    const token = extractToken(c.req.raw, { allowQuery });
    const info = deps.tokens.lookup(token);
    if (!info) return c.json({ error: "unauthorized" }, 401);
    if (info.kind === "run" && info.projectId && (await deps.projects.handle(info.projectId))?.manifest().ideaDraft && c.req.path !== "/mcp" && c.req.method !== "GET")
      return c.json({ error: "Idea drafts cannot change engineering files or create projects through an agent. Use project setup in fabPlane.", code: "draft_project_required" }, 403);
    // The relay link stamps its requests; the listeners strip the header from theirs (serve.ts),
    // so it is the daemon's own knowledge of the path, never the phone's claim.
    if (info.kind === "device" && info.deviceId)
      deps.devices.touch(info.deviceId, {
        via: c.req.header(VIA_HEADER) === "relay" ? "relay" : "direct",
      });
    c.set("token", token as string);
    await next();
  });

  app.get("/doctor", async (c) => c.json(await deps.doctor()));
  app.get("/agents", async (c) => c.json(await deps.agents()));
  app.get("/routers", async (c) => {
    const preferred = deps.store.settings.get().preferredRouter;
    const list = deps.services.routers?.list(preferred ?? undefined) ?? {
        routers: [],
        ...(preferred ? { preferredRouter: preferred } : {}),
      };
    const status = await deps.services.design.status().catch(error => ({ url: "", ok: false, reason: errMsg(error) }));
    return c.json(withRouterRuntime(list, status));
  });
  app.post("/routers/:id/install", async (c) => {
    const id = RouterCatalogId.parse(c.req.param("id"));
    const registry = deps.services.routers;
    if (!registry) return c.json({ error: "router registry unavailable" }, 503);
    return c.json(await registry.install(id));
  });
  app.post("/routers/:id/cancel", async (c) => {
    const id = RouterCatalogId.parse(c.req.param("id"));
    const registry = deps.services.routers;
    if (!registry) return c.json({ error: "router registry unavailable" }, 503);
    return c.json(await registry.cancel(id));
  });
  app.delete("/routers/:id", async (c) => {
    const id = RouterCatalogId.parse(c.req.param("id"));
    const registry = deps.services.routers;
    if (!registry) return c.json({ error: "router registry unavailable" }, 503);
    try {
      const snapshot = await registry.uninstall(id);
      // Removing the router that is the saved default must not leave unpinned routes pointing at it.
      if (deps.store.settings.get().preferredRouter === id && !snapshot.ready) {
        const next = deps.store.settings.patch({ preferredRouter: null });
        try {
          deps.onSettingsChanged?.(next);
        } catch (e) {
          logger.warn("onSettingsChanged failed", { error: errMsg(e) });
        }
      }
      return c.json(snapshot);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get("/events", (c) => {
    const topics = parseTopics(c.req.query("topics"));
    const raw = c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? null;
    const lastEventId =
      raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
    return sseResponse(deps.bus, { topics, lastEventId, signal: c.req.raw.signal });
  });

  /* ---------- projects ---------- */
  app.get("/projects", (c) => c.json(deps.projects.summaries()));
  app.post("/projects", async (c) => {
    const input = await c.req.json();
    if (deps.listener === "remote" && input?.parentDirectory !== undefined) {
      return c.json({ error: "Choosing a parent directory requires the local desktop connection" }, 403);
    }
    const body = CreateProject.parse(input);
    const created = await deps.projects.create(body.name, body.parentDirectory, body.draft);
    if (!created.isDraft) deps.funnel?.record("onboarding_first_project");
    return c.json(created, 201);
  });
  app.post("/projects/:id/promote", async c => {
    const id = c.req.param("id"), input = await c.req.json();
    if (deps.tokens.lookup(c.get("token"))?.kind === "run") return c.json({ error: "Project setup requires the user interface.", code: "forbidden" }, 403);
    if (deps.listener === "remote" && input?.parentDirectory !== undefined) return c.json({ error: "Choosing a parent directory requires the local desktop connection" }, 403);
    const body = CreateProject.omit({ draft: true }).parse(input);
    const busy = deps.runs?.projectBusyMessage(id);
    if (busy || deps.jobs.list().some(job => job.projectId === id && ["queued", "running"].includes(job.status))) return c.json({ error: "Wait for the current reply or task to finish before creating the project.", code: "precondition" }, 412);
    const promoted = await deps.projects.promoteDraft(id, body.name, body.parentDirectory);
    deps.funnel?.record("onboarding_first_project");
    return c.json(promoted);
  });
  app.get("/projects/:id", async (c) => {
    const d = await deps.projects.detail(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  });
  app.get("/projects/:id/board-sources", async (c) => {
    const project = await deps.projects.handle(c.req.param("id"));
    return project ? c.json(await inspectProjectBoardSources(project)) : c.json({ error: "not found" }, 404);
  });
  app.patch("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        manifest: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(await c.req.json());
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    if (body.manifest && ("ideaDraft" in body.manifest || "promotedAt" in body.manifest)) return c.json({ error: "Use project setup to change draft ownership.", code: "precondition" }, 400);
    if (body.manifest) await h.updateManifest(body.manifest as never);
    if (body.name) await deps.projects.rename(id, body.name);
    deps.bus.emit({
      ts: Date.now(),
      topic: "project.changed",
      projectId: id,
      paths: [PROJECT_FILES.manifest],
    });
    return c.json(await deps.projects.detail(id));
  });
  app.delete("/projects/:id", async (c) => {
    // The design server keeps one KiCad process per project session; a deleted project's must go too.
    const handle = await deps.projects.handle(c.req.param("id")).catch(() => null);
    const ok = await deps.projects.delete(c.req.param("id"), {
      purge: c.req.query("purge") === "1",
    });
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
  app.get("/projects/:id/route-runs", (c) => c.json(deps.store.routeRuns.list(c.req.param("id"))));

  app.get("/projects/:id/output-dependencies", async c => {
    const h = await deps.projects.handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    const directory = c.req.query("directory");
    return c.json(await snapshotProjectDependencies(!directory || directory === "." ? h.dir : await jailPath(h.dir, directory)));
  });

  app.get("/projects/:id/files/*", async (c) => {
    const h = await deps.projects.handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    const rel = decodeURIComponent(c.req.path.split("/files/")[1] ?? "");
    const visible = await visiblePublishedFile(h.dir, rel);
    if (visible === null) return c.json({ error: "not found" }, 404);
    const abs = visible ?? await jailPath(h.dir, rel);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return c.json({ error: "not found" }, 404);
    const mime = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
    return new Response(Bun.file(abs), {
      headers: {
        "content-type": mime,
        "content-length": String(st.size),
        "x-mtime": st.mtime.toISOString(),
      },
    });
  });
  app.put("/projects/:id/files/*", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const rel = decodeURIComponent(c.req.path.split("/files/")[1] ?? "");
    if (h.manifest().ideaDraft && rel !== "NOTES.md") return c.json({ error: "Create a project before editing engineering files.", code: "draft_project_required" }, 412);
    if (rel === PROJECT_FILES.manifest) return c.json({ error: "use PATCH /projects/:id" }, 400);
    const abs = await jailPath(h.dir, rel);
    await writeAtomic(abs, new Uint8Array(await c.req.arrayBuffer()));
    deps.store.projects.touch(id);
    return c.json({ ok: true, path: rel });
  });

  commentRoutes(app, deps);
  outputTrashRoutes(app, deps);

  app.get("/projects/:id/sketches", async (c) => {
    const h = await deps.projects.handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    const files = await deps.projects.listFiles(join(h.dir, PROJECT_FILES.sketches));
    return c.json(files.map((f) => ({ ...f, path: `${PROJECT_FILES.sketches}/${f.path}` })));
  });
  app.post("/projects/:id/sketches", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const ct = c.req.header("content-type") ?? "";
    let data: Uint8Array;
    let name: string;
    if (ct.startsWith("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "multipart field `file` required" }, 400);
      data = new Uint8Array(await file.arrayBuffer());
      name = (form.get("name") as string | null) ?? file.name ?? "sketch.png";
    } else {
      data = new Uint8Array(await c.req.arrayBuffer());
      name = c.req.query("name") ?? "sketch.png";
    }
    const sceneFile = /\.excalidraw$/i.test(name);
    if (sceneFile && data.length > MAX_EDITABLE_SKETCH_BYTES) return c.json({ error: "Editable drawings must be 10 MiB or smaller" }, 413);
    const scene = sceneFile && isEditableSketchSource(new TextDecoder().decode(data));
    if (sceneFile ? !scene : !isPng(data) && !isJpeg(data)) return c.json({ error: "PNG, JPEG or a supported .excalidraw drawing required" }, 415);
    const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || "sketch.png";
    const stamped = scene ? safe : /\.(png|jpe?g)$/i.test(safe) ? safe : `${safe}.png`;
    const dir = join(h.dir, PROJECT_FILES.sketches);
    await mkdir(dir, { recursive: true });
    let final = stamped;
    for (let i = 2; await stat(join(dir, final)).catch(() => null); i++)
      final = stamped.replace(/(\.[^.]+)$/, `-${i}$1`);
    const abs = await jailPath(h.dir, `${PROJECT_FILES.sketches}/${final}`);
    await writeAtomic(abs, data);
    return c.json(
      { path: `${PROJECT_FILES.sketches}/${final}`, absolutePath: abs, size: data.length },
      201,
    );
  });

  /* ---------- threads ---------- */
  app.get("/threads", (c) => {
    const q = c.req.query("q");
    const projectId = c.req.query("projectId");
    const archived = c.req.query("archived");
    const folderId = c.req.query("folderId");
    return c.json(
      deps.store.threads.list({
        ...(q ? { q } : {}),
        ...(projectId ? { projectId } : {}),
        ...(archived !== undefined ? { archived: archived === "1" || archived === "true" } : {}),
        ...(folderId !== undefined
          ? { folderId: folderId === "" || folderId === "null" ? null : folderId }
          : {}),
      }),
    );
  });
  /** Supervised mode needs an adapter that can pause; the phone greys the option out from `/agents`. */
  const canSupervise = (agentId: AgentId): boolean =>
    deps.runs?.supportsSupervised(agentId) ?? false;
  app.post("/threads", async (c) => {
    const body = CreateThread.parse(await c.req.json());
    // Check stale persisted selections before SQLite reports an opaque constraint failure.
    if (body.projectId && !deps.store.projects.get(body.projectId))
      return c.json({ code: "project_not_found", error: "The selected project is no longer available. Choose a project again." }, 404);
    if (body.parentThreadId && !deps.store.threads.get(body.parentThreadId))
      return c.json({ code: "parent_thread_not_found", error: "The original chat is no longer available. Start a new chat." }, 404);
    const runtimeMode = body.runtimeMode ?? deps.store.settings.get().defaultRuntimeMode;
    // A default of `supervised` must not make an agent that cannot do it unusable: fall back silently
    // unless the request asked for it by name.
    const mode =
      runtimeMode === "supervised" && !canSupervise(body.agentId)
        ? body.runtimeMode
          ? null
          : "full"
        : runtimeMode;
    if (mode === null) return c.json({ error: "agent cannot run supervised", code: "approval_not_supported" }, 400);
    const t = deps.store.threads.create({
      agentId: body.agentId,
      runtimeMode: mode,
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.title ? { title: body.title } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.parentThreadId ? { parentThreadId: body.parentThreadId } : {}),
      ...(body.branchFromMessageId ? { branchFromMessageId: body.branchFromMessageId } : {}),
    });
    deps.bus.emit({
      ts: Date.now(),
      topic: "thread.created",
      threadId: t.id,
      projectId: t.projectId,
    });
    return c.json(t, 201);
  });
  // Runs in progress, with what the client's live-run store needs. A client that connects (or
  // reconnects) while an agent is working has no `agent.started` to go on; this is its seed.
  app.get("/runs/live", (c) =>
    c.json(
      (deps.runs?.live() ?? []).flatMap(({ runId, threadId }) => {
        const run = deps.store.runs.get(runId);
        return run ? [{ runId, threadId, agentId: run.agentId, startedAt: run.startedAt }] : [];
      }),
    ),
  );
  app.get("/threads/:id", (c) => {
    const t = deps.store.threads.get(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    return c.json({
      ...t,
      run: deps.store.runs.latestForThread(t.id),
      runs: deps.store.runs.historyForThread(t.id),
      running: deps.runs?.isRunning(t.id) ?? false,
      pending: deps.runs?.pending(t.id) ?? { approvals: [], inputs: [] },
    });
  });
  app.patch("/threads/:id", async (c) => {
    const body = compact(PatchThread.parse(await c.req.json()));
    const current = deps.store.threads.get(c.req.param("id"));
    if (!current) return c.json({ error: "not found" }, 404);
    const mode = body.runtimeMode ?? current.runtimeMode ?? "full";
    if (mode === "supervised" && !canSupervise(body.agentId ?? current.agentId))
      return c.json({ error: "agent cannot run supervised", code: "approval_not_supported" }, 400);
    const t = deps.store.threads.patch(current.id, body);
    if (!t) return c.json({ error: "not found" }, 404);
    deps.bus.emit({
      ts: Date.now(),
      topic: "thread.updated",
      threadId: t.id,
      ...(body.title !== undefined ? { title: t.title } : {}),
    });
    return c.json(t);
  });

  /* ---------- supervised mode: decisions (both listeners; a paired phone may answer) ---------- */
  const decidedBy = (c: Context<Env>): "desktop" | "device" =>
    deps.tokens.lookup(c.get("token"))?.kind === "device" ? "device" : "desktop";
  const outcome = (c: Context<Env>, r: "ok" | "not_found" | "resolved") =>
    r === "ok"
      ? c.json({ ok: true })
      : r === "resolved"
        ? c.json({ error: "already resolved" }, 409)
        : c.json({ error: "not found" }, 404);
  // An agent run's own token never resolves a card: approvals and answers come from the person, not the agent.
  const fromAgentRun = (c: Context<Env>) => deps.tokens.lookup(c.get("token"))?.kind === "run";
  app.post("/threads/:id/approvals/:requestId", async (c) => {
    if (!deps.runs) return c.json({ error: "agent runs are disabled in this daemon" }, 503);
    if (fromAgentRun(c)) return c.json({ error: "An agent run cannot resolve approvals.", code: "forbidden" }, 403);
    const body = ResolveApproval.parse(await c.req.json());
    return outcome(
      c,
      deps.runs.resolveApproval(
        c.req.param("id"),
        c.req.param("requestId"),
        body.decision,
        decidedBy(c),
      ),
    );
  });
  app.post("/threads/:id/inputs/:requestId", async (c) => {
    if (!deps.runs) return c.json({ error: "agent runs are disabled in this daemon" }, 503);
    if (fromAgentRun(c)) return c.json({ error: "An agent run cannot answer its own questions.", code: "forbidden" }, 403);
    const body = ResolveInput.parse(await c.req.json());
    return outcome(
      c,
      deps.runs.resolveInput(c.req.param("id"), c.req.param("requestId"), body.answer),
    );
  });
  app.delete("/threads/:id", async (c) => {
    const id = c.req.param("id");
    // Bounded wait: the run's bookkeeping writes to the thread, so let it wind down first. The
    // thread is marked as being deleted meanwhile, so the run ending does not send its queued
    // message (a run on a deleted thread).
    let removed: boolean;
    try {
      await deps.runs?.abortForDelete(id);
      removed = deps.store.threads.delete(id);
    } finally {
      deps.runs?.deleted(id);
    }
    if (!removed) return c.json({ error: "not found" }, 404);
    deps.bus.emit({ ts: Date.now(), topic: "thread.deleted", threadId: id });
    return c.json({ ok: true });
  });
  app.get("/threads/:id/messages", (c) => {
    const t = deps.store.threads.get(c.req.param("id"));
    return t ? c.json(deps.store.threads.messages(t.id)) : c.json({ error: "not found" }, 404);
  });
  app.post("/threads/:id/messages", async (c) => {
    const t = deps.store.threads.get(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    const body = SendMessage.parse(await c.req.json());
    if (body.workspaceContext && body.workspaceContext.projectId !== t.projectId) return c.json({ error: "The workspace context belongs to another project. Reopen this conversation and send again.", code: "precondition" }, 400);
    if (!deps.runs) return c.json({ error: "agent runs are disabled in this daemon" }, 503);
    // The last await before `runs.start`: from the checks below to the lease `start` reserves
    // everything is synchronous, so no other request can take the thread or the project between
    // them and the user message being stored.
    const project = t.projectId ? await deps.projects.handle(t.projectId) : null;
    if (t.projectId && deps.projects.isPromoting(t.projectId)) return c.json({ error: "Project setup is in progress. Your message has not been sent.", code: "precondition" }, 412);
    const agentId: AgentId = body.agentId ?? t.agentId;
    const queue =
      body.queue === true || c.req.query("queue") === "1" || c.req.query("queue") === "true";
    const parts = [
      { type: "text" as const, text: body.content },
      ...(body.workspaceContext ? [{ type: "workspace_context" as const, context: body.workspaceContext }] : []),
      ...body.attachments.map((a) => ({ type: "image" as const, path: a.path, mime: a.mime })),
    ];
    if (deps.runs.isRunning(t.id)) {
      // C5: with a run live, keep the message and send it when the run ends. The agent/model switch
      // is not applied now — the queued message goes out with whatever the thread uses by then.
      if (!queue)
        return c.json(
          { error: "an agent run is already active on this thread", code: "precondition" },
          412,
        );
      const queued = deps.store.threads.addMessage({
        threadId: t.id,
        role: "user",
        contentMd: body.content,
        parts,
        status: "queued",
      });
      deps.bus.emit({ ts: Date.now(), topic: "thread.updated", threadId: t.id });
      return c.json({ queued: true, messageId: queued.id, userMessageId: queued.id }, 202);
    }
    // One agent writes a project at a time (#93). Refused before anything is stored, so the
    // client keeps the draft and a retry does not leave a duplicate user turn. Not queued even
    // with `queue`: a thread's queue drains when its own run ends, and this thread has none.
    const busy = t.projectId ? deps.runs.projectBusyMessage(t.projectId) : null;
    if (busy)
      return c.json({ error: busy.message, code: "precondition", threadId: busy.threadId }, 412);
    const switched = agentId !== t.agentId || (!!body.model && body.model !== t.model);
    if (switched)
      deps.store.threads.patch(t.id, { agentId, ...(body.model ? { model: body.model } : {}) });
    const user = deps.store.threads.addMessage({
      threadId: t.id,
      role: "user",
      contentMd: body.content,
      parts,
    });
    // The first message names a "New chat". Both of these silent edits are announced so a second
    // client (the phone, or the desktop when the phone sent the message) does not keep a stale row.
    const title = t.title === "New chat" ? threadTitleFrom(body.content) : null;
    if (title !== null) deps.store.threads.patch(t.id, { title });
    if (switched || title !== null)
      deps.bus.emit({
        ts: Date.now(),
        topic: "thread.updated",
        threadId: t.id,
        ...(title !== null ? { title } : {}),
      });
    let started: { runId: string; messageId: string };
    try {
      started = await deps.runs.start({
        threadId: t.id,
        project,
        agentId,
        ...((body.model ?? t.model) ? { model: (body.model ?? t.model) as string } : {}),
        prompt: body.content,
        ...(body.workspaceContext ? { workspaceContext: body.workspaceContext } : {}),
        attachments: body.attachments,
      });
    } catch (e) {
      // Refused (thread or project busy): the client keeps its draft, so the stored turn would
      // turn into a duplicate on retry. Other start failures are written into the thread.
      if (e instanceof ToolError && e.code === "precondition") {
        deps.store.threads.deleteMessage(user.id);
        deps.bus.emit({ ts: Date.now(), topic: "thread.updated", threadId: t.id });
      }
      throw e;
    }
    return c.json(
      { runId: started.runId, messageId: started.messageId, userMessageId: user.id },
      202,
    );
  });
  /** Removes a message that is still queued; a sent one is history and stays. */
  app.delete("/threads/:id/messages/:messageId", (c) => {
    const t = deps.store.threads.get(c.req.param("id"));
    const m = deps.store.threads.getMessage(c.req.param("messageId"));
    if (!t || !m || m.threadId !== t.id) return c.json({ error: "not found" }, 404);
    if (m.status !== "queued") return c.json({ error: "message is not queued" }, 409);
    deps.store.threads.deleteMessage(m.id);
    deps.bus.emit({ ts: Date.now(), topic: "thread.updated", threadId: t.id });
    return c.json({ ok: true });
  });
  /**
   * Stops the thread's run and answers once it has ended (the project is free again), or after
   * a bounded wait with `settled: false` if the agent is slow to exit; it keeps the project until
   * it does.
   */
  app.post("/threads/:id/abort", async (c) => {
    const id = c.req.param("id");
    const { aborted, settled } = (await deps.runs?.abortThread(id)) ?? {
      aborted: false,
      settled: true,
    };
    return c.json({ ok: true, aborted, settled });
  });
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json([]);
    return c.json(deps.store.threads.search(q));
  });
  app.get("/projects/import-github/destination", async (c) => {
    if (deps.listener === "remote" && c.req.query("parentDirectory") !== undefined) {
      return c.json({ error: "Choosing a parent directory requires the local desktop connection" }, 403);
    }
    const name = c.req.query("name") ?? "";
    if (!name.trim() || name.length > 80) return c.json({ error: "Enter a project name" }, 400);
    const destination = await deps.projects.importDestination(name, c.req.query("parentDirectory"));
    // The default root is under the host's home directory: a remote caller (phone, relay) gets
    // only the folder name it would create, not the host's absolute path.
    if (deps.listener === "remote")
      return c.json({ ...destination, path: basename(destination.path) });
    return c.json(destination);
  });
  app.post("/projects/import-github", async (c) => {
    const input = await c.req.json();
    if (deps.listener === "remote" && input?.parentDirectory !== undefined) {
      return c.json({ error: "Choosing a parent directory requires the local desktop connection" }, 403);
    }
    const body = z.object({
      url: z.string().min(1),
      name: z.string().trim().min(1).max(80),
      parentDirectory: z.string().optional(),
    }).parse(input);
    const source = parsePublicGitHubUrl(body.url);
    const project = await deps.projects.importFromGit({
      name: body.name,
      gitUrl: source.url,
      ...(body.parentDirectory ? { parentDirectory: body.parentDirectory } : {}),
      signal: c.req.raw.signal,
      failOnCollision: true,
    });
    try {
      const handle = await deps.projects.handle(project.id);
      const boards = handle ? (await listKicadPcbFiles(handle.dir)).map((entry) => entry.path) : [];
      let adoptedBoard: string | null = null;
      if (handle && boards.length === 1) {
        const adopted = await hydrateClonedBoard({
          project: handle, files: [{ path: boards[0]! }],
          resolveCli: () => deps.services.kicad.resolveCli(),
          exportPcbSvg: (cli, opts) => deps.services.kicad.exportPcbSvg(cli, opts),
          boardStats: (cli, opts) => deps.services.kicad.boardStats(cli, opts),
        });
        adoptedBoard = adopted?.pcbPath ?? null;
      }
      c.req.raw.signal.throwIfAborted();
      deps.funnel?.record("onboarding_first_project");
      deps.funnel?.record("onboarding_first_kicad_import");
      return c.json({ project: (await deps.projects.detail(project.id)) ?? project, boards, adoptedBoard }, 201);
    } catch (error) {
      await deps.projects.delete(project.id, { purge: true });
      throw error;
    }
  });
  app.post("/projects/:id/adopt-board", async (c) => {
    const body = z.object({ path: z.string().min(1) }).parse(await c.req.json());
    const handle = await deps.projects.handle(c.req.param("id"));
    if (!handle) return c.json({ error: "project not found" }, 404);
    const boards = await listKicadPcbFiles(handle.dir);
    if (!boards.some((entry) => entry.path === body.path)) return c.json({ error: "board not found in this project" }, 400);
    const adopted = await hydrateClonedBoard({
      project: handle, files: [{ path: body.path }],
      resolveCli: () => deps.services.kicad.resolveCli(),
      exportPcbSvg: (cli, opts) => deps.services.kicad.exportPcbSvg(cli, opts),
      boardStats: (cli, opts) => deps.services.kicad.boardStats(cli, opts),
    });
    if (!adopted) return c.json({ error: "could not load this KiCad board" }, 422);
    deps.funnel?.record("onboarding_first_project");
    deps.funnel?.record("onboarding_first_kicad_import");
    return c.json({ project: await deps.projects.detail(c.req.param("id")), pcbPath: adopted.pcbPath });
  });
  app.get("/projects/:id/finish-it", async (c) => {
    const id = c.req.param("id");
    if (!(await deps.projects.handle(id))) return c.json({ error: "not found" }, 404);
    return c.json({ session: deps.finishIt?.get(id) ?? null, needsWork: deps.finishIt ? await deps.finishIt.needsWork(id) : false });
  });
  app.post("/projects/:id/finish-it", async (c) => {
    if (!deps.finishIt) return c.json({ error: "Finish it is disabled in this daemon" }, 503);
    if (!deps.runs) return c.json({ error: "agent runs are disabled in this daemon" }, 503);
    const id = c.req.param("id");
    if (!(await deps.projects.handle(id))) return c.json({ error: "not found" }, 404);
    const raw = await c.req.json().catch(() => ({}));
    const body = StartFinishIt.parse(raw ?? {});
    const session = await deps.finishIt.start({
      projectId: id,
      ...(body.threadId ? { threadId: body.threadId } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(body.model ? { model: body.model } : {}),
    });
    return c.json({ session }, 202);
  });
  app.post("/projects/:id/finish-it/stop", async (c) => {
    if (!deps.finishIt) return c.json({ error: "Finish it is disabled in this daemon" }, 503);
    const id = c.req.param("id");
    if (!(await deps.projects.handle(id))) return c.json({ error: "not found" }, 404);
    const session = await deps.finishIt.stop(id);
    return c.json({ session });
  });
  app.get("/search/results", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length < 2) return c.json({ titles: [], messages: [], nextOffset: null });
    if (q.length > 200) return c.json({ error: "search query is too long" }, 400);
    const parsedLimit = c.req.query("limit") === undefined ? 30 : Number(c.req.query("limit"));
    const offset = c.req.query("offset") === undefined ? 0 : Number(c.req.query("offset"));
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || !Number.isSafeInteger(offset) || offset < 0) return c.json({ error: "limit and offset must be non-negative integers" }, 400);
    const limit = Math.min(50, parsedLimit);
    return c.json(deps.store.threads.searchResults(q, limit, offset));
  });

  /* ---------- open-source catalog ---------- */
  const previewCache = createPreviewCache();
  let catalogMemo: { origin: string; at: number; pending: Promise<OpenCatalogIndex> } | undefined;
  const catalogFor = (origin: string): Promise<OpenCatalogIndex> => {
    const now = Date.now();
    if (!catalogMemo || catalogMemo.origin !== origin || now - catalogMemo.at > 30_000) {
      catalogMemo = { origin, at: now, pending: fetchOpenCatalog(origin) };
    }
    return catalogMemo.pending;
  };
  app.get("/opensource", async (c) => {
    const index = await fetchOpenCatalog(deps.config.apiOrigin, c.req.query("q") ?? undefined);
    return c.json(index);
  });
  app.get("/opensource/preview/:owner/:slug", async (c) => {
    const index = await catalogFor(deps.config.apiOrigin);
    const project = findCatalogProject(index, `${c.req.param("owner")}/${c.req.param("slug")}`);
    if (!project) return c.json({ error: "not found" }, 404);
    const role = c.req.query("role") === "hero" ? "hero" : "preview";
    const image = await resolveCatalogPreview(project, { cache: previewCache, role });
    const body = new Uint8Array(image.body);
    const fallback = image.contentType.startsWith("image/svg+xml");
    return new Response(body, {
      headers: {
        "content-type": image.contentType,
        "content-length": String(body.byteLength),
        "cache-control": fallback ? "private, no-store" : "private, max-age=3600",
      },
    });
  });
  app.get("/opensource/projects/:owner/:slug", async (c) => {
    const index = await catalogFor(deps.config.apiOrigin);
    const project = findCatalogProject(index, `${c.req.param("owner")}/${c.req.param("slug")}`);
    return project ? c.json(project) : c.json({ error: "not found" }, 404);
  });
  app.post("/opensource/projects/:owner/:slug/remix", async (c) => {
    const index = await catalogFor(deps.config.apiOrigin);
    const source = findCatalogProject(index, `${c.req.param("owner")}/${c.req.param("slug")}`);
    if (!source) return c.json({ error: "not found" }, 404);
    if (!allowedCloneUrl(source.cloneUrl))
      return c.json({ error: "clone url is not an allowed GitHub repository" }, 400);
    const remixed = await remixCatalogProject({
      source,
      projects: deps.projects,
      services: deps.services,
    });
    deps.funnel?.record("onboarding_first_project");
    return c.json(remixed, 201);
  });

  const orderReadiness = async (projectId: string) => {
    const d = await deps.projects.detail(projectId);
    if (!d) return null;
    const evidence = await loadOrderCheckEvidence(d.path, d.manifest.allowedDrcWarnings);
    return assessOrderReadiness(d.files, evidence);
  };
  app.get("/projects/:id/order", async (c) => {
    const readiness = await orderReadiness(c.req.param("id"));
    if (!readiness) return c.json({ error: "not found" }, 404);
    return c.json({ ...readiness, vendors: orderVendors() });
  });
  app.post("/projects/:id/order", async (c) => {
    const readiness = await orderReadiness(c.req.param("id"));
    if (!readiness) return c.json({ error: "not found" }, 404);
    const body = StartOrder.parse(await c.req.json());
    const vendor = OrderVendorId.parse(body.vendor);
    if (!readiness.ready)
      return c.json({ error: "project is not ready to order", ...readiness }, 412);
    const session = startOrderSession(vendor);
    if (!session.enabled)
      return c.json({ error: `${session.label} ordering is not available yet`, session }, 400);
    return c.json(session);
  });

  /* ---------- fabplane.com shopping lists & inventory ---------- */
  app.route("/", cloudRoutes<Env["Variables"]>({ cloud: () => deps.services.cloud, projects: deps.projects, readBom: project => readProjectBom(makeContext({ project, services: deps.services })), canManageSharing: token => deps.tokens.lookup(token)?.kind === "daemon", rasterizeSharePreview: (svg, options) => deps.services.kicad.rasterizeSvg(svg, options) }));

  /* ---------- folders ---------- */
  app.get("/folders", (c) => c.json(deps.store.folders.list()));
  app.post("/folders", async (c) => {
    const body = z
      .object({ name: z.string().min(1).max(80), parentId: z.string().nullable().optional() })
      .parse(await c.req.json());
    return c.json(deps.store.folders.create(body.name, body.parentId ?? null), 201);
  });
  app.patch("/folders/:id", async (c) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(await c.req.json());
    deps.store.folders.rename(c.req.param("id"), body.name);
    return c.json({ ok: true });
  });
  app.delete("/folders/:id", (c) =>
    deps.store.folders.delete(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404),
  );

  /* ---------- tools & jobs ---------- */
  app.route(
    "/",
    toolRoutes({
      registry: deps.registry,
      ctxFactory: deps.ctxFactory,
      jobs: deps.jobs,
      // Tools that run arbitrary code on the host (cad_python, app_eval) are for the desktop
      // over loopback only: not the remote listener, and not device tokens (paired phones, which
      // also covers everything arriving through the relay).
      allowTool: (def, token) =>
        !def.localOnly ||
        (deps.listener === "local" && deps.tokens.lookup(token)?.kind !== "device"),
    }),
  );
  app.get("/jobs", (c) => {
    const projectId = c.req.query("projectId");
    // New work must not hide persisted history from before a daemon restart.
    const jobs = new Map(deps.store.jobs.list(100, projectId).map(job => [job.id, job]));
    for (const job of deps.jobs.list()) if (!projectId || job.projectId === projectId) jobs.set(job.id, job);
    return c.json([...jobs.values()]);
  });
  app.get("/jobs/:id", (c) => {
    const j = deps.jobs.get(c.req.param("id")) ?? deps.store.jobs.get(c.req.param("id"));
    return j ? c.json(j) : c.json({ error: "not found" }, 404);
  });
  app.post("/jobs/:id/cancel", (c) => c.json({ ok: deps.jobs.cancel(c.req.param("id")) }));
  app.delete("/jobs/:id", (c) => c.json({ ok: deps.jobs.cancel(c.req.param("id")) }));

  /* ---------- route frames ---------- */
  app.get("/route/runs/:id/frames", async (c) => {
    const rec = deps.store.routeRuns.get(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    const from = Number(c.req.query("from") ?? 0) || 0;
    let project = await deps.projects.handle(rec.projectId);
    if (rec.board) {
      if (!project || !/^run_[A-Za-z0-9_-]+$/.test(rec.id)) throw new ToolError("Routing source ownership is unavailable.", "precondition");
      const binding = await resolveNativeBoardBinding(project, rec.board);
      const sourceDir = binding.boardDir.slice(binding.rootDir.length + 1).replaceAll("\\", "/") || ".";
      if (sourceDir !== rec.sourceDirectory) throw new ToolError("Routing artifact source does not match its recorded owner.", "precondition");
      project = { ...project, dir: binding.boardDir };
    }
    const currentPath = project
      ? join(project.dir, PROJECT_FILES.runs, rec.id, "frames.jsonl")
      : null;
    const persistedPath =
      project && !isAbsolute(rec.framesPath)
        ? await jailPath(project.dir, rec.framesPath).catch(() => null)
        : rec.framesPath;
    const candidates = [
      ...new Set([currentPath, persistedPath].filter((path): path is string => !!path)),
    ];
    let text = "";
    for (const path of candidates) {
      const loaded = await readFile(path, "utf8").catch(() => null);
      if (loaded !== null) {
        text = loaded;
        break;
      }
    }
    const lines = text.split("\n").filter(Boolean);
    const out: string[] = [];
    for (const line of lines) {
      if (from > 0) {
        // Keep meta/static always; frames only from `seq >= from`.
        const seqMatch = /"seq":(\d+)/.exec(line);
        const kindMatch = /"kind":"(meta|static|frame)"/.exec(line);
        if (kindMatch?.[1] === "frame" && seqMatch && Number(seqMatch[1]) < from) continue;
      }
      out.push(line);
    }
    return new Response(out.length ? out.join("\n") + "\n" : "", {
      headers: { "content-type": "application/x-ndjson", "x-route-status": rec.status },
    });
  });
  app.get("/route/runs/:id", (c) => {
    const rec = deps.store.routeRuns.get(c.req.param("id"));
    return rec ? c.json(rec) : c.json({ error: "not found" }, 404);
  });

  /* ---------- MCP ---------- */
  // MCP stays on loopback: its DNS-rebinding allowlist is pinned to the local bind address, and
  // agent subprocesses always reach the daemon there.
  app.all("/mcp", (c) =>
    deps.listener === "local"
      ? deps.mcp.handle(c.req.raw, { token: c.get("token") ?? null })
      : c.json({ error: "not found" }, 404),
  );
  app.get("/mcp/sessions", (c) =>
    deps.listener === "local" ? c.json(deps.mcp.list()) : c.json({ error: "not found" }, 404),
  );

  /* ---------- auth ---------- */
  const me = (): Me => ({ principal: deps.auth.principal(), mode: deps.auth.mode });
  app.get("/v1/auth/state", (c) => c.json(deps.auth.state() satisfies AuthState));
  app.get("/v1/auth/me", (c) => c.json(me()));
  app.post("/v1/auth/login", async (c) => {
    let credentials: { email: string; password: string } | undefined;
    try {
      const body: unknown = await c.req.json();
      if (typeof body === "object" && body !== null) {
        const record = body as Record<string, unknown>;
        const email = typeof record.email === "string" ? record.email : "";
        const password = typeof record.password === "string" ? record.password : "";
        if (email && password) credentials = { email, password };
      }
    } catch {
      /* empty body = interactive device flow */
    }
    const p = deps.auth.login(c.req.raw.signal, credentials);
    if (credentials) {
      try {
        return c.json(await p);
      } catch (e) {
        logger.warn("login failed", { error: errMsg(e) });
        return c.json(deps.auth.state());
      }
    }
    deps.funnel?.record("onboarding_sign_in_started");
    // Kick off the device flow; state transitions arrive via auth.state events. Respond immediately
    // with the pending state (user code) when available within a short window.
    const first = await Promise.race([
      p,
      new Promise<AuthState>((r) => setTimeout(() => r(deps.auth.state()), 1500)),
    ]);
    void p.catch((e) => logger.warn("login failed", { error: errMsg(e) }));
    return c.json(first);
  });
  app.post("/v1/auth/logout", async (c) => c.json(await deps.auth.logout()));

  /* ---------- settings ---------- */
  app.get("/settings", (c) => c.json(deps.store.settings.get()));
  app.put("/settings/agent-effort", async (c) => {
    const { agentId, effort } = AgentEffortPreference.parse(await c.req.json());
    // Read and merge synchronously on the daemon, preserving settings changed by other clients.
    const current = deps.store.settings.get();
    const next = deps.store.settings.patch({
      agents: { ...current.agents, [agentId]: { ...current.agents[agentId], effort } },
    });
    try { deps.onSettingsChanged?.(next); }
    catch (e) { logger.warn("onSettingsChanged failed", { error: errMsg(e) }); }
    return c.json(next);
  });
  app.put("/settings/agent-preference", async (c) => {
    const { agentId, model } = AgentPreference.parse(await c.req.json());
    // Merge on the daemon so a picker cannot overwrite paths, permissions, or another agent.
    const current = deps.store.settings.get();
    const next = deps.store.settings.patch({
      defaultAgent: agentId,
      agents: {
        ...current.agents,
        [agentId]: { ...current.agents[agentId], model: model || null },
      },
    });
    try { deps.onSettingsChanged?.(next); }
    catch (e) { logger.warn("onSettingsChanged failed", { error: errMsg(e) }); }
    return c.json(next);
  });
  app.get("/privacy", (c) => (deps.privacy ? c.json(deps.privacy()) : c.json({ error: "not found" }, 404)));
  app.get("/funnel", (c) => {
    if (!deps.funnel) return c.json({ error: "not found" }, 404);
    const snap = deps.funnel.snapshot();
    if ((c.req.query("format") ?? "").toLowerCase() === "html") {
      return c.html(deps.funnel.renderHtml(snap));
    }
    return c.json(snap);
  });
  app.post("/funnel/handoff", async (c) => {
    if (!deps.funnel) return c.json({ error: "not found" }, 404);
    const raw: unknown = await c.req.json().catch(() => ({}));
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    deps.funnel.adopt(funnelHandoffFromRecord(record));
    return c.json(deps.funnel.snapshot());
  });
  app.post("/funnel/events", async (c) => {
    if (!deps.funnel) return c.json({ error: "not found" }, 404);
    const raw: unknown = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        event: z.string().min(1),
        properties: z.record(z.string(), z.string()).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    if (!CLIENT_FUNNEL_EVENTS.includes(parsed.data.event as ClientFunnelEvent)) {
      return c.json({ recorded: false }, 400);
    }
    const extra = parsed.data.properties;
    return c.json({
      recorded: extra
        ? deps.funnel.record(parsed.data.event as ClientFunnelEvent, extra)
        : deps.funnel.record(parsed.data.event as ClientFunnelEvent),
    });
  });
  app.patch("/settings", async (c) => {
    const raw: unknown = await c.req.json();
    // `.partial()` still fills every defaulted key, so a `{ theme }` patch would otherwise reset the
    // agents, the remote listener and everything else to defaults: keep only what was sent.
    const parsed = Settings.partial().parse(raw);
    const sent =
      typeof raw === "object" && raw !== null ? new Set(Object.keys(raw)) : new Set<string>();
    const body = Object.fromEntries(
      Object.entries(parsed).filter(([k]) => sent.has(k)),
    ) as typeof parsed;
    if (body.voice && typeof raw === "object" && raw !== null) {
      const sentVoice = (raw as { voice?: unknown }).voice;
      const sentVoiceKeys =
        sentVoice && typeof sentVoice === "object" && sentVoice !== null
          ? new Set(Object.keys(sentVoice))
          : new Set<string>();
      const incoming = Object.fromEntries(
        Object.entries(body.voice).filter(([k]) => sentVoiceKeys.has(k)),
      );
      body.voice = { ...deps.store.settings.get().voice, ...incoming };
    }
    const next = deps.store.settings.patch(body);
    await applyErrorReporting(next.errorReporting);
    // Remote access is a runtime toggle: the listener starts, stops or rebinds without a restart.
    if (body.remote !== undefined && deps.listener === "local") deps.remote.apply(next.remote);
    try {
      deps.onSettingsChanged?.(next);
    } catch (e) {
      logger.warn("onSettingsChanged failed", { error: errMsg(e) });
    }
    return c.json(next);
  });

  /**
   * The addresses a phone would be offered, ordered as the pairing URL lists them. Built from the
   * setting rather than the live listener so Settings can show (and warn about) what enabling
   * remote access would advertise before it is switched on.
   */
  const tailscale = deps.tailscale ?? tailscaleProvider();
  const advertisedEndpoints = async (
    fresh = false,
  ): Promise<{ endpoints: CoreEndpoint[]; tailscale: TailscaleState | null }> => {
    const remote = deps.store.settings.get().remote;
    const info = await tailscale.info({ fresh });
    const endpoints = [
      ...listenAddresses(remote.port, {
        bindHost: remote.host,
        preferred: remote.preferredEndpointKind,
        tailscale: info,
      }),
      ...(deps.extraEndpoints?.() ?? []),
    ];
    const serve = info ? serveFor(info.serves, { host: remote.host, port: remote.port }) : null;
    return {
      endpoints,
      tailscale: info && {
        ip: info.ip,
        dnsName: info.dnsName,
        httpsEnabled: info.httpsEnabled,
        serve: serve && { port: serve.port },
      },
    };
  };
  const remoteStatus = async (fresh = false): Promise<RemoteStatus> => ({
    ...deps.remote.state(),
    setting: deps.store.settings.get().remote,
    ...(await advertisedEndpoints(fresh)),
    relay: deps.relay?.state() ?? null,
  });

  /** Whether the remote listener is actually bound, and on what — Settings shows the real state. */
  app.get("/v1/remote", async (c) => c.json(await remoteStatus()));

  /* ---------- paired devices ---------- */
  const localOnly = (c: Context) =>
    deps.listener === "local" ? null : c.json({ error: "not found" }, 404);

  /**
   * Front the remote listener with `tailscale serve` on 443 (or stop doing so), then report the
   * endpoints as they now stand. Administration, so local listener only. A failure carries the
   * CLI's stderr: the usual cause is the tailnet's HTTPS feature being off.
   */
  app.post("/v1/remote/tailscale-serve", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const body = TailscaleServeRequest.parse(await c.req.json());
    const remote = deps.store.settings.get().remote;
    try {
      await tailscale.setServe(body.enabled, { host: remote.host, port: remote.port });
    } catch (e) {
      logger.warn("tailscale serve change failed", { enabled: body.enabled, error: errMsg(e) });
      return c.json({ error: errMsg(e), code: "precondition" }, 412);
    }
    return c.json(await remoteStatus(true));
  });

  app.post("/v1/devices/pair/start", async (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const remote = deps.store.settings.get().remote;
    const { endpoints } = await advertisedEndpoints();
    const pending = deps.devices.startPairing();
    return c.json({
      pairingToken: pending.token,
      code: pending.code,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      endpoints,
      url: pairingUrlFromEndpoints({
        token: pending.token,
        endpoints,
        port: remote.port,
        name: machineName(),
        coreId: deps.store.settings.coreId(),
      }),
      coreName: machineName(),
    });
  });

  app.post("/v1/devices/pair/cancel", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    deps.devices.cancelPairing();
    return c.json({ ok: true });
  });

  app.get("/v1/devices", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    return c.json(deps.devices.list());
  });

  app.delete("/v1/devices/:id", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!deps.devices.revoke(id)) return c.json({ error: "not found" }, 404);
    deps.bus.emit({ topic: "device.revoked", ts: Date.now(), deviceId: id });
    return c.json({ ok: true });
  });

  /* ---------- the calling device itself (docs/mobile-notifications.md §4.1) ---------- */
  // Authenticated by the device token like every other remote request: the bearer middleware has
  // already resolved it, so the token's own device is the only one these routes can touch. They
  // are served on both listeners (the simulator pairs over loopback) and are not administration.
  const callingDevice = (c: Context<Env>) => {
    const info = deps.tokens.lookup(c.get("token"));
    return info?.kind === "device" && info.deviceId ? deps.devices.get(info.deviceId) : null;
  };
  const notADevice = (c: Context<Env>) =>
    c.json({ error: "device token required", code: "forbidden" }, 403);

  app.get("/v1/devices/me", (c) => {
    const device = callingDevice(c);
    return device ? c.json(device) : notADevice(c);
  });

  app.put("/v1/devices/me/push", async (c) => {
    const device = callingDevice(c);
    if (!device) return notADevice(c);
    const reg = DevicePushRegistration.parse(await c.req.json());
    const stored = deps.devices.setPush(device.id, reg);
    if (!stored) return notADevice(c);
    logger.info("device push registered", {
      id: device.id,
      platform: reg.platform,
      prefs: reg.prefs,
    });
    return c.json({
      device: stored.device,
      push: { registeredAt: stored.registeredAt },
    } satisfies DevicePushResult);
  });

  app.delete("/v1/devices/me/push", (c) => {
    const device = callingDevice(c);
    if (!device) return notADevice(c);
    deps.devices.clearPush(device.id);
    logger.info("device push cleared", { id: device.id });
    return c.json({ ok: true });
  });

  /* ---------- speak-to-the-agent (desktop composer + paired phone) ---------- */
  const daemonOnly = (c: Context<Env>) => {
    if (deps.listener !== "local") return c.json({ error: "not found" }, 404);
    if (deps.tokens.lookup(c.get("token"))?.kind !== "daemon") {
      return c.json({ error: "desktop token required", code: "forbidden" }, 403);
    }
    return null;
  };

  app.get("/v1/speech/status", async (c) => c.json(await speech.status()));
  app.post("/v1/speech/transcribe", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    if (!ct.startsWith("multipart/form-data")) {
      return c.json({ error: "multipart field `file` required", code: "invalid_args" }, 400);
    }
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "multipart field `file` required", code: "invalid_args" }, 400);
    }
    const language = typeof form.get("language") === "string" ? String(form.get("language")) : undefined;
    const providerRaw = typeof form.get("provider") === "string" ? String(form.get("provider")) : undefined;
    const provider =
      providerRaw === "auto" ||
      providerRaw === "on_device" ||
      providerRaw === "cloud" ||
      providerRaw === "local"
        ? providerRaw
        : undefined;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const result = await speech.transcribe({
        audio: {
          bytes,
          mime: file.type || "application/octet-stream",
          ...(file.name ? { filename: file.name } : {}),
        },
        ...(language ? { language } : {}),
        ...(provider ? { provider } : {}),
      });
      return c.json(result);
    } catch (e) {
      if (e instanceof SpeechProviderError) {
        const status = e.code === "unavailable" ? 503 : e.code === "invalid_audio" ? 400 : e.code === "unauthorized" ? 401 : 502;
        return c.json({ error: e.message, code: e.code }, status);
      }
      throw e;
    }
  });
  app.put("/v1/speech/cloud", async (c) => {
    const denied = daemonOnly(c);
    if (denied) return denied;
    const body = SpeechCloudSecret.parse(await c.req.json());
    speech.setCloud({
      apiKey: body.apiKey,
      baseUrl: body.baseUrl?.trim() ? body.baseUrl.trim() : null,
    });
    return c.json(await speech.status());
  });
  app.delete("/v1/speech/cloud", async (c) => {
    const denied = daemonOnly(c);
    if (denied) return denied;
    speech.setCloud(null);
    return c.json(await speech.status());
  });
  app.post("/v1/speech/local/install", async (c) => {
    const denied = daemonOnly(c);
    if (denied) return denied;
    const installed = await speech.installLocal();
    return c.json({ ...installed, status: await speech.status() });
  });

  app.post("/shutdown", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    setTimeout(() => deps.shutdown("shutdown requested"), 20);
    return c.json({ ok: true });
  });

  app.notFound((c: Context) => c.json({ error: "not found" }, 404));
  return app;
}

/** Drop `undefined` values so partial objects satisfy exactOptionalPropertyTypes targets. */
function compact<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}
function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
