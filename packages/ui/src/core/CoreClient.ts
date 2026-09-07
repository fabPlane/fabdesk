/** Typed fetch wrapper over the fabdesk-core control API plus SSE subscription. */
import type {
  AuthState,
  CoreEvent,
  DoctorReport,
  Job,
  Message,
  OpenCatalogEntry,
  OpenCatalogIndex,
  OrderReadiness,
  OrderSession,
  OrderVendorId,
  ProjectDetail,
  ProjectSummary,
  RemixResult,
  RouteFrameLine,
  RouteResult,
  Settings,
  Thread,
  ToolManifestEntry,
} from "@fabdesk/protocol";
import { subscribeSse, type EventSourceFactory, type SseStatus, type SseSubscription } from "./sse";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CoreClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  eventSourceFactory?: EventSourceFactory;
}

export class CoreHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "CoreHttpError";
  }
}

export interface CreateThreadInput {
  projectId?: string | null;
  title?: string;
  agentId: Thread["agentId"];
  model?: string;
  parentThreadId?: string;
  branchFromMessageId?: string;
}

export interface PatchThreadInput {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  folderId?: string | null;
  agentId?: Thread["agentId"];
  model?: string | null;
}

export interface SendMessageInput {
  content: string;
  attachments?: Array<{ path: string; mime: string }>;
  agentId?: Thread["agentId"];
  model?: string;
}

export type ToolCallResponse = { result: unknown; jobId?: undefined } | { jobId: string; result?: undefined };

export type HealthInfo = { ok?: boolean; version?: string; [k: string]: unknown };

export interface RouteRunRecord {
  id: string;
  projectId: string;
  router: string;
  status: "running" | "done" | "failed" | "cancelled";
  framesPath: string;
  startedAt: string;
  endedAt: string | null;
  result: RouteResult | null;
  error: string | null;
}

export class CoreClient {
  readonly baseUrl: string;
  readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly esFactory: EventSourceFactory;

  constructor(options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.esFactory =
      options.eventSourceFactory ??
      ((url) => new EventSource(url) as unknown as ReturnType<EventSourceFactory>);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...(extra ?? {}) };
  }

  async request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
    const { json, ...rest } = init ?? {};
    const headers = this.headers(
      json !== undefined ? { "Content-Type": "application/json" } : undefined,
    );
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...rest,
      headers: { ...headers, ...((rest.headers as Record<string, string> | undefined) ?? {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CoreHttpError(res.status, path, text || `${res.status} ${res.statusText}`);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  // Health / doctor
  health(): Promise<HealthInfo> {
    return this.fetchImpl(`${this.baseUrl}/health`).then(async (r) => {
      if (!r.ok) throw new CoreHttpError(r.status, "/health", r.statusText);
      return (await r.json()) as HealthInfo;
    });
  }
  doctor(): Promise<DoctorReport> {
    return this.request("/doctor");
  }

  // Projects
  listProjects(): Promise<ProjectSummary[]> {
    return this.request("/projects");
  }
  createProject(name: string): Promise<ProjectSummary> {
    return this.request("/projects", { method: "POST", json: { name } });
  }
  getProject(id: string): Promise<ProjectDetail> {
    return this.request(`/projects/${encodeURIComponent(id)}`);
  }
  fileUrl(projectId: string, path: string): string {
    const clean = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    return `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/files/${clean}`;
  }
  async readFile(projectId: string, path: string): Promise<string> {
    const res = await this.fetchImpl(this.fileUrl(projectId, path), { headers: this.headers() });
    if (!res.ok) throw new CoreHttpError(res.status, path, res.statusText);
    return res.text();
  }
  async readFileBlob(projectId: string, path: string): Promise<Blob> {
    const res = await this.fetchImpl(this.fileUrl(projectId, path), { headers: this.headers() });
    if (!res.ok) throw new CoreHttpError(res.status, path, res.statusText);
    return res.blob();
  }
  async readJson<T = unknown>(projectId: string, path: string): Promise<T> {
    return JSON.parse(await this.readFile(projectId, path)) as T;
  }
  async writeFile(projectId: string, path: string, content: string | Blob): Promise<void> {
    const res = await this.fetchImpl(this.fileUrl(projectId, path), {
      method: "PUT",
      headers: this.headers(typeof content === "string" ? { "Content-Type": "text/plain" } : {}),
      body: content,
    });
    if (!res.ok) throw new CoreHttpError(res.status, path, res.statusText);
  }
  async uploadSketch(projectId: string, png: Blob, filename = "sketch.png"): Promise<{ path: string }> {
    const form = new FormData();
    form.append("file", png, filename);
    const res = await this.fetchImpl(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}/sketches`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) throw new CoreHttpError(res.status, "/sketches", await res.text().catch(() => res.statusText));
    return (await res.json()) as { path: string };
  }

  listOpenSource(q?: string): Promise<OpenCatalogIndex> {
    const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
    return this.request(`/opensource${qs}`);
  }
  getOpenSource(id: string): Promise<OpenCatalogEntry> {
    const [owner, slug] = id.split("/");
    if (!owner || !slug) throw new Error(`invalid open-source id: ${id}`);
    return this.request(`/opensource/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`);
  }
  remixOpenSource(id: string): Promise<RemixResult> {
    const [owner, slug] = id.split("/");
    if (!owner || !slug) throw new Error(`invalid open-source id: ${id}`);
    return this.request(`/opensource/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/remix`, { method: "POST" });
  }
  /** Loopback image URL for `<img src>` — the preview route accepts `?token=` like SSE. */
  openSourcePreviewUrl(id: string, role: "preview" | "hero" = "preview"): string {
    const [owner, slug] = id.split("/");
    if (!owner || !slug) return "";
    const qs = new URLSearchParams({ token: this.token });
    if (role === "hero") qs.set("role", "hero");
    return `${this.baseUrl}/opensource/preview/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}?${qs.toString()}`;
  }
  projectOrder(id: string): Promise<OrderReadiness & { vendors: Array<{ id: OrderVendorId; label: string; enabled: boolean }> }> {
    return this.request(`/projects/${encodeURIComponent(id)}/order`);
  }
  startOrder(id: string, vendor: OrderVendorId): Promise<OrderSession> {
    return this.request(`/projects/${encodeURIComponent(id)}/order`, { method: "POST", json: { vendor } });
  }

  // Threads
  listThreads(params?: { q?: string; projectId?: string | null }): Promise<Thread[]> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.projectId) qs.set("projectId", params.projectId);
    const s = qs.toString();
    return this.request(`/threads${s ? `?${s}` : ""}`);
  }
  getThread(id: string): Promise<Thread> {
    return this.request(`/threads/${encodeURIComponent(id)}`);
  }
  createThread(input: CreateThreadInput): Promise<Thread> {
    return this.request("/threads", { method: "POST", json: input });
  }
  patchThread(id: string, patch: PatchThreadInput): Promise<Thread> {
    return this.request(`/threads/${encodeURIComponent(id)}`, { method: "PATCH", json: patch });
  }
  deleteThread(id: string): Promise<void> {
    return this.request(`/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  listMessages(threadId: string): Promise<Message[]> {
    return this.request(`/threads/${encodeURIComponent(threadId)}/messages`);
  }
  sendMessage(threadId: string, input: SendMessageInput): Promise<{ runId: string; messageId: string }> {
    return this.request(`/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", json: input });
  }
  abort(threadId: string): Promise<void> {
    return this.request(`/threads/${encodeURIComponent(threadId)}/abort`, { method: "POST" });
  }

  // Tools / jobs
  toolManifest(): Promise<ToolManifestEntry[]> {
    return this.request("/tools/manifest");
  }
  /** `projectId` in args is lifted into the adapter's top-level `project` selector. */
  callTool(name: string, args: unknown): Promise<ToolCallResponse> {
    const { projectId, ...rest } = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const json = { args: rest, ...(typeof projectId === "string" && projectId ? { project: projectId } : {}) };
    return this.request(`/tools/${encodeURIComponent(name)}`, { method: "POST", json });
  }
  getJob(id: string): Promise<Job> {
    return this.request(`/jobs/${encodeURIComponent(id)}`);
  }
  /** Waits for a job to finish, polling; resolves with the final Job. */
  async waitJob(id: string, opts?: { intervalMs?: number; signal?: AbortSignal }): Promise<Job> {
    const interval = opts?.intervalMs ?? 750;
    for (;;) {
      const job = await this.getJob(id);
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job;
      if (opts?.signal?.aborted) return job;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  async routeFrames(runId: string, from = 0): Promise<RouteFrameLine[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/route/runs/${encodeURIComponent(runId)}/frames?from=${from}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new CoreHttpError(res.status, "/route/runs", res.statusText);
    const text = await res.text();
    return parseJsonl<RouteFrameLine>(text);
  }
  listRouteRuns(projectId: string): Promise<RouteRunRecord[]> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/route-runs`);
  }

  // Auth
  authState(): Promise<AuthState> {
    return this.request("/v1/auth/state");
  }
  login(credentials?: { email: string; password: string }): Promise<AuthState> {
    return this.request("/v1/auth/login", {
      method: "POST",
      ...(credentials ? { json: credentials } : {}),
    });
  }
  logout(): Promise<void> {
    return this.request("/v1/auth/logout", { method: "POST" });
  }

  // Settings / lifecycle
  getSettings(): Promise<Settings> {
    return this.request("/settings");
  }
  patchSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.request("/settings", { method: "PATCH", json: patch });
  }
  shutdown(): Promise<void> {
    return this.request("/shutdown", { method: "POST" });
  }

  // Events
  eventsUrl(topics: string[]): string {
    const qs = new URLSearchParams({ token: this.token, topics: topics.join(",") });
    return `${this.baseUrl}/events?${qs.toString()}`;
  }
  subscribe(
    topics: string[],
    handler: (event: CoreEvent, id: string) => void,
    onStatus?: (status: SseStatus, attempt: number) => void,
  ): SseSubscription {
    return subscribeSse({
      buildUrl: () => this.eventsUrl(topics),
      factory: this.esFactory,
      onEvent: handler,
      ...(onStatus ? { onStatus } : {}),
    });
  }
}

export function parseJsonl<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}
