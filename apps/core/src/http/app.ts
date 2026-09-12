/** Hono application: auth + origin guard, control API, tools/jobs, MCP, events. */
import { readFile, stat, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Hono, type Context } from "hono";
import {
  CreateProject,
  CreateThread,
  PairClaim,
  pairingUrlFromEndpoints,
  OpenCatalogIndex,
  OrderVendorId,
  PatchThread,
  SendMessage,
  Settings,
  StartOrder,
  type AgentId,
  type AgentInfo,
  type AuthState,
  type DoctorReport,
  type Me,
} from "@fabdesk/protocol";
import { z } from "zod/v4";
import { PROJECT_FILES, ToolError, jailPath, toolRoutes, writeAtomic, type ContextFactory, type CoreServices, type ToolRegistry } from "@fabdesk/tools";
import { extractToken, originAllowed, type TokenSet } from "../auth";
import type { AuthFacade } from "../auth-facade";
import type { EventBus } from "../bus";
import type { CoreConfig } from "../config";
import type { Store } from "../db";
import type { JobRunner } from "../jobs";
import type { McpSessionManager } from "../mcp-sessions";
import type { ProjectStore } from "../projects";
import type { AgentRunManager } from "../agent-runs";
import type { DeviceStore } from "../devices";
import type { RemoteListener } from "../remote";
import { listenAddresses, machineName } from "../net";
import { logger, errMsg } from "../log";
import { allowedCloneUrl, fetchOpenCatalog, findCatalogProject } from "../opensource/catalog";
import { createPreviewCache, resolveCatalogPreview } from "../opensource/preview";
import { assessOrderReadiness, orderVendors, startOrderSession } from "../opensource/order";
import { remixCatalogProject } from "../opensource/remix";
import { applyErrorReporting, captureCoreException } from "../sentry";
import { parseTopics, sseResponse } from "./sse";

export type AppDeps = {
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
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
  ".kicad_pcb": "text/plain; charset=utf-8",
  ".kicad_sch": "text/plain; charset=utf-8",
  ".kicad_pro": "application/json",
};

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ToolError) {
      const status = err.code === "invalid_args" ? 400 : err.code === "not_found" ? 404 : err.code === "precondition" ? 412 : err.code === "unavailable" ? 503 : 500;
      return c.json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err), code: "invalid_args" }, 400);
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
    if (!originAllowed(origin, deps.extraOrigins ?? [])) return c.json({ error: "forbidden origin" }, 403);
    const applyCors = (headers: Headers) => {
      if (origin === null || origin === "") return;
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "authorization, content-type, last-event-id, mcp-session-id, mcp-protocol-version");
      headers.set("Access-Control-Expose-Headers", "mcp-session-id, content-disposition, content-length");
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
    c.json({ ok: true, version: deps.config.version, pid: process.pid, channel: deps.config.channel, authMode: deps.auth.mode, uptimeMs: Date.now() - deps.startedAt, mcpSessions: deps.mcp.activeCount() }),
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
    deps.bus.emit({ topic: "device.paired", ts: Date.now(), deviceId: issued.device.id, label: issued.device.label });
    logger.info("device paired", { id: issued.device.id, label: issued.device.label, platform: issued.device.platform });
    return c.json({
      deviceToken: issued.token,
      device: issued.device,
      core: { name: machineName(), version: deps.config.version, platform: process.platform },
    });
  });

  // Bearer auth for everything else (`?token=` allowed for SSE / WS which cannot set headers).
  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const allowQuery = c.req.path === "/events" || c.req.path === "/ws" || c.req.path.startsWith("/opensource/preview/");
    const token = extractToken(c.req.raw, { allowQuery });
    const info = deps.tokens.lookup(token);
    if (!info) return c.json({ error: "unauthorized" }, 401);
    if (info.kind === "device" && info.deviceId) deps.devices.touch(info.deviceId);
    c.set("token", token as string);
    await next();
  });

  app.get("/doctor", async (c) => c.json(await deps.doctor()));
  app.get("/agents", async (c) => c.json(await deps.agents()));

  app.get("/events", (c) => {
    const topics = parseTopics(c.req.query("topics"));
    const raw = c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? null;
    const lastEventId = raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
    return sseResponse(deps.bus, { topics, lastEventId, signal: c.req.raw.signal });
  });

  /* ---------- projects ---------- */
  app.get("/projects", (c) => c.json(deps.projects.summaries()));
  app.post("/projects", async (c) => {
    const body = CreateProject.parse(await c.req.json());
    return c.json(await deps.projects.create(body.name), 201);
  });
  app.get("/projects/:id", async (c) => {
    const d = await deps.projects.detail(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "not found" }, 404);
  });
  app.patch("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const body = z.object({ name: z.string().min(1).max(80).optional(), manifest: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json());
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    if (body.manifest) await h.updateManifest(body.manifest as never);
    if (body.name) await deps.projects.rename(id, body.name);
    deps.bus.emit({ ts: Date.now(), topic: "project.changed", projectId: id, paths: [PROJECT_FILES.manifest] });
    return c.json(await deps.projects.detail(id));
  });
  app.delete("/projects/:id", async (c) => {
    const ok = await deps.projects.delete(c.req.param("id"), { purge: c.req.query("purge") === "1" });
    return ok ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
  app.get("/projects/:id/route-runs", (c) => c.json(deps.store.routeRuns.list(c.req.param("id"))));

  app.get("/projects/:id/files/*", async (c) => {
    const h = await deps.projects.handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    const rel = decodeURIComponent(c.req.path.split("/files/")[1] ?? "");
    const abs = await jailPath(h.dir, rel);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return c.json({ error: "not found" }, 404);
    const mime = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
    return new Response(Bun.file(abs), { headers: { "content-type": mime, "content-length": String(st.size), "x-mtime": st.mtime.toISOString() } });
  });
  app.put("/projects/:id/files/*", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const rel = decodeURIComponent(c.req.path.split("/files/")[1] ?? "");
    if (rel === PROJECT_FILES.manifest) return c.json({ error: "use PATCH /projects/:id" }, 400);
    const abs = await jailPath(h.dir, rel);
    await writeAtomic(abs, new Uint8Array(await c.req.arrayBuffer()));
    deps.store.projects.touch(id);
    return c.json({ ok: true, path: rel });
  });

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
    if (!isPng(data) && !isJpeg(data)) return c.json({ error: "PNG or JPEG required" }, 415);
    const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || "sketch.png";
    const stamped = /\.(png|jpe?g)$/i.test(safe) ? safe : `${safe}.png`;
    const dir = join(h.dir, PROJECT_FILES.sketches);
    await mkdir(dir, { recursive: true });
    let final = stamped;
    for (let i = 2; await stat(join(dir, final)).catch(() => null); i++) final = stamped.replace(/(\.[^.]+)$/, `-${i}$1`);
    const abs = await jailPath(h.dir, `${PROJECT_FILES.sketches}/${final}`);
    await writeAtomic(abs, data);
    return c.json({ path: `${PROJECT_FILES.sketches}/${final}`, absolutePath: abs, size: data.length }, 201);
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
        ...(folderId !== undefined ? { folderId: folderId === "" || folderId === "null" ? null : folderId } : {}),
      }),
    );
  });
  app.post("/threads", async (c) => {
    const body = CreateThread.parse(await c.req.json());
    return c.json(
      deps.store.threads.create({
        agentId: body.agentId,
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.model ? { model: body.model } : {}),
        ...(body.parentThreadId ? { parentThreadId: body.parentThreadId } : {}),
        ...(body.branchFromMessageId ? { branchFromMessageId: body.branchFromMessageId } : {}),
      }),
      201,
    );
  });
  app.get("/threads/:id", (c) => {
    const t = deps.store.threads.get(c.req.param("id"));
    return t ? c.json({ ...t, run: deps.store.runs.latestForThread(t.id), running: deps.runs?.isRunning(t.id) ?? false }) : c.json({ error: "not found" }, 404);
  });
  app.patch("/threads/:id", async (c) => {
    const body = compact(PatchThread.parse(await c.req.json()));
    const t = deps.store.threads.patch(c.req.param("id"), body);
    if (!t) return c.json({ error: "not found" }, 404);
    deps.bus.emit({ ts: Date.now(), topic: "thread.updated", threadId: t.id });
    return c.json(t);
  });
  app.delete("/threads/:id", (c) => {
    const id = c.req.param("id");
    deps.runs?.abortThread(id);
    return deps.store.threads.delete(id) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
  app.get("/threads/:id/messages", (c) => {
    const t = deps.store.threads.get(c.req.param("id"));
    return t ? c.json(deps.store.threads.messages(t.id)) : c.json({ error: "not found" }, 404);
  });
  app.post("/threads/:id/messages", async (c) => {
    const t = deps.store.threads.get(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    const body = SendMessage.parse(await c.req.json());
    if (!deps.runs) return c.json({ error: "agent runs are disabled in this daemon" }, 503);
    const agentId: AgentId = body.agentId ?? t.agentId;
    if (agentId !== t.agentId || (body.model && body.model !== t.model)) deps.store.threads.patch(t.id, { agentId, ...(body.model ? { model: body.model } : {}) });
    const user = deps.store.threads.addMessage({ threadId: t.id, role: "user", contentMd: body.content, parts: [{ type: "text", text: body.content }, ...body.attachments.map((a) => ({ type: "image" as const, path: a.path, mime: a.mime }))] });
    if (t.title === "New chat") deps.store.threads.patch(t.id, { title: body.content.slice(0, 60).replace(/\s+/g, " ") });
    const project = t.projectId ? await deps.projects.handle(t.projectId) : null;
    const { runId, messageId } = await deps.runs.start({ threadId: t.id, project, agentId, ...(body.model ?? t.model ? { model: (body.model ?? t.model) as string } : {}), prompt: body.content, attachments: body.attachments });
    return c.json({ runId, messageId, userMessageId: user.id }, 202);
  });
  app.post("/threads/:id/abort", (c) => {
    const id = c.req.param("id");
    const hit = deps.runs?.abortThread(id) ?? false;
    return c.json({ ok: true, aborted: hit });
  });
  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json([]);
    return c.json(deps.store.threads.search(q));
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
    if (!allowedCloneUrl(source.cloneUrl)) return c.json({ error: "clone url is not an allowed GitHub repository" }, 400);
    const remixed = await remixCatalogProject({ source, projects: deps.projects, services: deps.services });
    return c.json(remixed, 201);
  });

  app.get("/projects/:id/order", async (c) => {
    const d = await deps.projects.detail(c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    return c.json({ ...assessOrderReadiness(d.files), vendors: orderVendors() });
  });
  app.post("/projects/:id/order", async (c) => {
    const d = await deps.projects.detail(c.req.param("id"));
    if (!d) return c.json({ error: "not found" }, 404);
    const body = StartOrder.parse(await c.req.json());
    const vendor = OrderVendorId.parse(body.vendor);
    const readiness = assessOrderReadiness(d.files);
    if (!readiness.ready) return c.json({ error: "project is not ready to order", ...readiness }, 412);
    const session = startOrderSession(vendor);
    if (!session.enabled) return c.json({ error: `${session.label} ordering is not available yet`, session }, 400);
    return c.json(session);
  });

  /* ---------- folders ---------- */
  app.get("/folders", (c) => c.json(deps.store.folders.list()));
  app.post("/folders", async (c) => {
    const body = z.object({ name: z.string().min(1).max(80), parentId: z.string().nullable().optional() }).parse(await c.req.json());
    return c.json(deps.store.folders.create(body.name, body.parentId ?? null), 201);
  });
  app.patch("/folders/:id", async (c) => {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(await c.req.json());
    deps.store.folders.rename(c.req.param("id"), body.name);
    return c.json({ ok: true });
  });
  app.delete("/folders/:id", (c) => (deps.store.folders.delete(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404)));

  /* ---------- tools & jobs ---------- */
  app.route("/", toolRoutes({ registry: deps.registry, ctxFactory: deps.ctxFactory, jobs: deps.jobs }));
  app.get("/jobs", (c) => c.json(deps.jobs.list().length ? deps.jobs.list() : deps.store.jobs.list()));
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
    const text = await readFile(rec.framesPath, "utf8").catch(() => "");
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
    return new Response(out.length ? out.join("\n") + "\n" : "", { headers: { "content-type": "application/x-ndjson", "x-route-status": rec.status } });
  });
  app.get("/route/runs/:id", (c) => {
    const rec = deps.store.routeRuns.get(c.req.param("id"));
    return rec ? c.json(rec) : c.json({ error: "not found" }, 404);
  });

  /* ---------- MCP ---------- */
  // MCP stays on loopback: its DNS-rebinding allowlist is pinned to the local bind address, and
  // agent subprocesses always reach the daemon there.
  app.all("/mcp", (c) => (deps.listener === "local" ? deps.mcp.handle(c.req.raw, { token: c.get("token") ?? null }) : c.json({ error: "not found" }, 404)));
  app.get("/mcp/sessions", (c) => (deps.listener === "local" ? c.json(deps.mcp.list()) : c.json({ error: "not found" }, 404)));

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
    // Kick off the device flow; state transitions arrive via auth.state events. Respond immediately
    // with the pending state (user code) when available within a short window.
    const first = await Promise.race([p, new Promise<AuthState>((r) => setTimeout(() => r(deps.auth.state()), 1500))]);
    void p.catch((e) => logger.warn("login failed", { error: errMsg(e) }));
    return c.json(first);
  });
  app.post("/v1/auth/logout", async (c) => c.json(await deps.auth.logout()));

  /* ---------- settings ---------- */
  app.get("/settings", (c) => c.json(deps.store.settings.get()));
  app.patch("/settings", async (c) => {
    const body = Settings.partial().parse(await c.req.json());
    const next = deps.store.settings.patch(body);
    await applyErrorReporting(next.errorReporting);
    // Remote access is a runtime toggle: the listener starts, stops or rebinds without a restart.
    if (body.remote !== undefined && deps.listener === "local") deps.remote.apply(next.remote);
    return c.json(next);
  });

  /** Whether the remote listener is actually bound, and on what — Settings shows the real state. */
  app.get("/v1/remote", (c) => c.json({ ...deps.remote.state(), setting: deps.store.settings.get().remote }));

  /* ---------- paired devices ---------- */
  const localOnly = (c: Context) => (deps.listener === "local" ? null : c.json({ error: "not found" }, 404));

  app.post("/v1/devices/pair/start", (c) => {
    const denied = localOnly(c);
    if (denied) return denied;
    const remote = deps.store.settings.get().remote;
    const endpoints = listenAddresses(remote.port);
    const pending = deps.devices.startPairing();
    return c.json({
      pairingToken: pending.token,
      code: pending.code,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      endpoints,
      url: pairingUrlFromEndpoints({ token: pending.token, endpoints, port: remote.port, name: machineName() }),
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
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}
function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}
