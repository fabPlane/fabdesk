/** Typed fetch wrapper over the fabdesk-core control API plus SSE subscription. */
import { BoardChecks, TeamProjects, ContributionBoards, ProjectShareState, ProjectShareSnapshot, SharedProject, SharedProjectStatus, BoardSourceSelection } from "@fabdesk/protocol";
import type {
  OutputTrashReview,
  OutputTrashEntry,
  OutputTrashBatchResult,
  AgentId,
  AgentPreference,
  AgentEffortPreference,
  AuthState,
  BomSyncSummary,
  BomSyncOptions,
  Cart,
  CartItem,
  CartItemInput,
  CartItemPatch,
  CloudStatus,
  Destination,
  InventoryItem,
  InventoryItemInput,
  ShoppingListResponse,
  CoreEvent,
  Device,
  DeviceMe,
  DevicePushPrefs,
  DevicePushRegistration,
  DevicePushRegistrationInput,
  DevicePushState,
  DoctorReport,
  FinishItSession,
  Job,
  Message,
  OpenCatalogEntry,
  OpenCatalogIndex,
  OrderReadiness,
  OrderSession,
  OrderVendorId,
  PairStartResult,
  BoardComment,
  BoardCommentsFile,
  CreateBoardComment,
  PatchBoardComment,
  PrivacyStatus,
  ProjectDetail,
  ProjectBoardSources,
  ProjectSummary,
  RemixResult,
  RemoteStatus,
  RouterCatalogId,
  RouterList,
  RouterSnapshot,
  RouteFrameLine,
  RouteResult,
  Settings,
  SpeechStatus,
  SpeechTranscript,
  Run,
  Thread,
  ToolManifestEntry,
} from "@fabdesk/protocol";
/** `GET /threads/:id`: the thread, saved run history, latest run, and current activity. */
export type ThreadDetail = Thread & { run?: Run | null; runs?: Run[]; running?: boolean };

function commentScopeQuery(board?: BoardSourceSelection): string {
  if (!board) return "";
  const captured = BoardSourceSelection.parse(board);
  return `?sourceId=${encodeURIComponent(captured.sourceId)}&manifestSha256=${captured.manifestSha256}`;
}

/** One row of `GET /runs/live`. */
export interface LiveRunSummary {
  runId: string;
  threadId: string;
  agentId: AgentId;
  startedAt: string;
}

import { subscribeSse, type EventSourceFactory, type SseStatus, type SseSubscription } from "./sse";
import { errorMessage, errorPayload } from "./error-help";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CoreClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  eventSourceFactory?: EventSourceFactory;
}

export class CoreHttpError extends Error {
  readonly code: string | undefined;
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly rawMessage: string,
  ) {
    super(errorMessage(rawMessage, { status, path }));
    this.name = "CoreHttpError";
    this.code = errorPayload(rawMessage).code;
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
  workspaceContext?: import("@fabdesk/protocol").WorkspaceContext;
  content: string;
  attachments?: Array<{ path: string; mime: string }>;
  agentId?: Thread["agentId"];
  model?: string;
}

export type ToolCallResponse =
  | { result: unknown; jobId?: undefined }
  | { jobId: string; result?: undefined };

export type HealthInfo = { ok?: boolean; version?: string; [k: string]: unknown };

export interface RouteRunRecord {
  id: string;
  projectId: string;
  board?: BoardSourceSelection;
  sourceDirectory?: string;
  router: string;
  status:
    | "queued"
    | "running"
    | "cancel_requested"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "failed"
    | "timed_out"
    | "interrupted";
  framesPath: string;
  startedAt: string;
  endedAt: string | null;
  candidate?: { available: boolean };
  result: RouteResult | null;
  error: string | null;
}

export type {
  DeviceMe,
  DevicePushPrefs,
  DevicePushRegistration,
  DevicePushRegistrationInput,
  DevicePushState,
};

export class CoreClient {
  readonly baseUrl: string;
  readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly esFactory: EventSourceFactory;

  constructor(options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.fetchImpl = async (input, init) => {
      try { return await fetchImpl(input, init); }
      catch (error) {
        // Keep intentional cancellation and relay-specific errors distinguishable.
        if (init?.signal?.aborted || (error instanceof Error && error.name === "AbortError") || error instanceof CoreHttpError) throw error;
        const failure = new Error(errorMessage(error));
        Object.assign(failure, { rawMessage: error instanceof Error ? error.message : String(error), cause: error });
        throw failure;
      }
    };
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
  createProject(name: string, parentDirectory?: string): Promise<ProjectSummary> {
    return this.request("/projects", { method: "POST", json: { name, ...(parentDirectory ? { parentDirectory } : {}) } });
  }
  createIdeaDraft(): Promise<ProjectSummary> {
    return this.request("/projects", { method: "POST", json: { name: "Untitled idea", draft: true } });
  }
  promoteIdeaDraft(id: string, name: string, parentDirectory?: string): Promise<ProjectDetail> {
    return this.request(`/projects/${encodeURIComponent(id)}/promote`, { method: "POST", json: { name, ...(parentDirectory ? { parentDirectory } : {}) } });
  }
  getProject(id: string): Promise<ProjectDetail> {
    return this.request(`/projects/${encodeURIComponent(id)}`);
  }
  async listTeamProjects() { return TeamProjects.parse(await this.request("/cloud/team-projects")); }
  async listTeamBoards(projectId:string) { return ContributionBoards.parse(await this.request(`/cloud/team-projects/${encodeURIComponent(projectId)}/boards`)); }
  importTeamBoard(projectId:string,boardId:string):Promise<ProjectDetail> { return this.request(`/cloud/team-projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId)}/import`,{method:"POST"}); }
  localContributions(id:string):Promise<{projectId:string;role:"owner"|"viewer"|"contributor";boards:Array<ContributionBoards["boards"][number]&{sourceId:string;available:boolean;baseRevision:string|null;canPublish:boolean}>}> { return this.request(`/projects/${encodeURIComponent(id)}/contributions`); }
  publishContribution(id:string,sourceId:string):Promise<{revision:string}> { return this.request(`/projects/${encodeURIComponent(id)}/contributions/${encodeURIComponent(sourceId)}`,{method:"PUT"}); }
  async getProjectShare(id: string): Promise<ProjectShareState> {
    return ProjectShareState.parse(await this.request(`/projects/${encodeURIComponent(id)}/share`));
  }
  async publishProjectShare(id: string, visibility?: "restricted" | "unlisted", options?: { updateOnly?: boolean }): Promise<ProjectShareState> {
    if (options?.updateOnly && visibility !== undefined) throw new TypeError("Snapshot updates cannot change project visibility");
    return ProjectShareState.parse(await this.request(`/projects/${encodeURIComponent(id)}/share${options?.updateOnly ? "?updateOnly=true" : visibility ? `?visibility=${visibility}` : ""}`, { method: "PUT" }));
  }
  async disableProjectShare(id: string): Promise<ProjectShareState> {
    return ProjectShareState.parse(await this.request(`/projects/${encodeURIComponent(id)}/share`, { method: "DELETE" }));
  }
  async previewProjectShare(id: string): Promise<ProjectShareSnapshot> {
    return ProjectShareSnapshot.parse(await this.request(`/projects/${encodeURIComponent(id)}/share/preview`, { method: "POST" }));
  }
  async getSharedProjectStatus(shareId: string) {
    return SharedProjectStatus.parse(
      await this.request(`/shared-projects/${encodeURIComponent(shareId)}/status`),
    );
  }
  async getSharedProject(shareId: string): Promise<SharedProject> {
    return SharedProject.parse(await this.request(`/shared-projects/${encodeURIComponent(shareId)}`));
  }
  async getProjectStatus(id: string): Promise<ProjectShareSnapshot> {
    return ProjectShareSnapshot.parse(await this.request(`/projects/${encodeURIComponent(id)}/status`));
  }
  async getBoardChecks(id: string): Promise<BoardChecks> {
    return BoardChecks.parse(await this.request(`/projects/${encodeURIComponent(id)}/board-checks`));
  }
  inspectBoardSources(id: string): Promise<ProjectBoardSources> {
    return this.request(`/projects/${encodeURIComponent(id)}/board-sources`);
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
  listComments(projectId: string, board?: BoardSourceSelection): Promise<BoardCommentsFile> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/comments${commentScopeQuery(board)}`);
  }
  pinComment(
    projectId: string,
    input: CreateBoardComment,
    board?: BoardSourceSelection,
  ): Promise<{ comment: BoardComment; label: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/comments${commentScopeQuery(board)}`, {
      method: "POST",
      json: input,
    });
  }
  patchComment(
    projectId: string,
    commentId: string,
    patch: PatchBoardComment,
    board?: BoardSourceSelection,
  ): Promise<{ comment: BoardComment; label: string }> {
    return this.request(
      `/projects/${encodeURIComponent(projectId)}/comments/${encodeURIComponent(commentId)}${commentScopeQuery(board)}`,
      { method: "PATCH", json: patch },
    );
  }
  readNotes(projectId: string): Promise<{ path: string; content: string; chars: number }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/notes`);
  }
  writeNotes(
    projectId: string,
    content: string,
  ): Promise<{ ok: true; path: string; chars: number }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/notes`, {
      method: "PUT",
      json: { content },
    });
  }
  reviewOutputTrash(projectId: string, paths: string[]): Promise<OutputTrashReview> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/output-trash/review`, { method: "POST", json: { paths } });
  }
  moveOutputsToTrash(projectId: string, files: Array<{ path: string; token: string }>): Promise<OutputTrashBatchResult> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/output-trash`, { method: "POST", json: { files } });
  }
  listOutputTrash(projectId: string): Promise<{ files: OutputTrashEntry[] }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/output-trash`);
  }
  restoreOutputTrash(projectId: string, ids: string[]): Promise<OutputTrashBatchResult> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/output-trash/restore`, { method: "POST", json: { ids } });
  }
  async writeFile(projectId: string, path: string, content: string | Blob): Promise<void> {
    const res = await this.fetchImpl(this.fileUrl(projectId, path), {
      method: "PUT",
      headers: this.headers(typeof content === "string" ? { "Content-Type": "text/plain" } : {}),
      body: content,
    });
    if (!res.ok) throw new CoreHttpError(res.status, path, res.statusText);
  }
  async uploadSketch(
    projectId: string,
    file: Blob,
    filename = "sketch.png",
  ): Promise<{ path: string }> {
    const form = new FormData();
    form.append("file", file, filename);
    const res = await this.fetchImpl(
      `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/sketches`,
      {
        method: "POST",
        headers: this.headers(),
        body: form,
      },
    );
    if (!res.ok)
      throw new CoreHttpError(
        res.status,
        "/sketches",
        await res.text().catch(() => res.statusText),
      );
    return (await res.json()) as { path: string };
  }

  listOpenSource(q?: string): Promise<OpenCatalogIndex> {
    const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
    return this.request(`/opensource${qs}`);
  }
  getOpenSource(id: string): Promise<OpenCatalogEntry> {
    const [owner, slug] = id.split("/");
    if (!owner || !slug) throw new Error(`invalid open-source id: ${id}`);
    return this.request(
      `/opensource/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
    );
  }
  remixOpenSource(id: string): Promise<RemixResult> {
    const [owner, slug] = id.split("/");
    if (!owner || !slug) throw new Error(`invalid open-source id: ${id}`);
    return this.request(
      `/opensource/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/remix`,
      { method: "POST" },
    );
  }
  /** Loopback image URL for `<img src>` — the preview route accepts `?token=` like SSE. */
  openSourcePreviewUrl(id: string, role: "preview" | "hero" = "preview"): string {
    const [owner, slug] = id.split("/");
    if (!owner || !slug) return "";
    const qs = new URLSearchParams({ token: this.token });
    if (role === "hero") qs.set("role", "hero");
    return `${this.baseUrl}/opensource/preview/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}?${qs.toString()}`;
  }
  projectOrder(
    id: string,
  ): Promise<
    OrderReadiness & { vendors: Array<{ id: OrderVendorId; label: string; enabled: boolean }> }
  > {
    return this.request(`/projects/${encodeURIComponent(id)}/order`);
  }
  startOrder(id: string, vendor: OrderVendorId): Promise<OrderSession> {
    return this.request(`/projects/${encodeURIComponent(id)}/order`, {
      method: "POST",
      json: { vendor },
    });
  }

  // fabplane.com shopping lists & inventory (proxied by the core)
  cloudStatus(): Promise<CloudStatus> {
    return this.request("/cloud/status");
  }
  shoppingList(projectId: string): Promise<ShoppingListResponse> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/shopping-list`);
  }
  createShoppingList(projectId: string): Promise<ShoppingListResponse> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/shopping-list`, { method: "POST" });
  }
  addShoppingItems(
    projectId: string,
    items: CartItemInput[],
  ): Promise<{ cart: Cart; added: CartItem[]; cartUrl: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/shopping-list/items`, {
      method: "POST",
      json: { items },
    });
  }
  updateShoppingItem(
    projectId: string,
    itemId: string,
    patch: CartItemPatch,
  ): Promise<{ item: CartItem }> {
    return this.request(
      `/projects/${encodeURIComponent(projectId)}/shopping-list/items/${encodeURIComponent(itemId)}`,
      { method: "PATCH", json: patch },
    );
  }
  removeShoppingItem(projectId: string, itemId: string): Promise<{ ok: boolean }> {
    return this.request(
      `/projects/${encodeURIComponent(projectId)}/shopping-list/items/${encodeURIComponent(itemId)}`,
      { method: "DELETE" },
    );
  }
  syncShoppingBom(
    projectId: string,
    options?: BomSyncOptions,
  ): Promise<{ cart: Cart; summary: BomSyncSummary; cartUrl: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/shopping-list/sync-bom`, {
      method: "POST",
      ...(options ? { json: options } : {}),
    });
  }
  cloudDestinations(): Promise<{ destinations: Destination[] }> {
    return this.request("/cloud/destinations");
  }
  searchInventory(q?: string): Promise<{ items: InventoryItem[]; nextCursor: string | null }> {
    const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
    return this.request(`/cloud/inventory${qs}`);
  }
  /** JSON, or multipart with the picked image when one is given. */
  async createInventoryItem(
    input: InventoryItemInput,
    image?: { data: Blob; filename: string },
  ): Promise<{ item: InventoryItem }> {
    if (!image) return this.request("/cloud/inventory", { method: "POST", json: input });
    const form = new FormData();
    form.append("item", JSON.stringify(input));
    form.append("image", image.data, image.filename);
    const res = await this.fetchImpl(`${this.baseUrl}/cloud/inventory`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!res.ok)
      throw new CoreHttpError(res.status, "/cloud/inventory", await res.text().catch(() => res.statusText));
    return (await res.json()) as { item: InventoryItem };
  }
  adjustInventory(itemId: string, delta: number, reason?: string): Promise<{ item: InventoryItem }> {
    return this.request(`/cloud/inventory/${encodeURIComponent(itemId)}/adjust`, {
      method: "POST",
      json: { delta, ...(reason ? { reason } : {}) },
    });
  }

  // Threads
  listThreads(params?: { q?: string; projectId?: string | null }): Promise<Thread[]> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.projectId) qs.set("projectId", params.projectId);
    const s = qs.toString();
    return this.request(`/threads${s ? `?${s}` : ""}`);
  }
  importGitHubDestination(name: string, parentDirectory?: string): Promise<{ path: string; exists: boolean }> {
    const params = new URLSearchParams({ name });
    if (parentDirectory) params.set("parentDirectory", parentDirectory);
    return this.request(`/projects/import-github/destination?${params}`);
  }
  importGitHub(url: string, name: string, parentDirectory?: string, signal?: AbortSignal): Promise<{ project: ProjectDetail; boards: string[]; adoptedBoard: string | null }> {
    return this.request("/projects/import-github", {
      method: "POST", json: { url, name, ...(parentDirectory ? { parentDirectory } : {}) },
      ...(signal ? { signal } : {}),
    });
  }
  adoptImportedBoard(projectId: string, path: string): Promise<{ project: ProjectDetail; pcbPath: string }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/adopt-board`, { method: "POST", json: { path } });
  }
  searchChats(q: string, offset = 0): Promise<{ titles: Thread[]; messages: Array<{ message: Message; snippet: string; thread: Thread }>; nextOffset: number | null }> {
    return this.request(`/search/results?q=${encodeURIComponent(q)}&offset=${offset}`);
  }
  getThread(id: string): Promise<ThreadDetail> {
    return this.request(`/threads/${encodeURIComponent(id)}`);
  }
  /** Agent runs in progress right now (`GET /runs/live`), for seeding the live state after a (re)connect. */
  liveRuns(): Promise<LiveRunSummary[]> {
    return this.request("/runs/live");
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
  sendMessage(
    threadId: string,
    input: SendMessageInput,
  ): Promise<{ runId: string; messageId: string }> {
    return this.request(`/threads/${encodeURIComponent(threadId)}/messages`, {
      method: "POST",
      json: input,
    });
  }
  abort(threadId: string): Promise<void> {
    return this.request(`/threads/${encodeURIComponent(threadId)}/abort`, { method: "POST" });
  }

  getFinishIt(projectId: string): Promise<{ session: FinishItSession | null; needsWork?: boolean }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/finish-it`);
  }
  startFinishIt(
    projectId: string,
    input: { threadId?: string; agentId?: Thread["agentId"]; model?: string } = {},
  ): Promise<{ session: FinishItSession }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/finish-it`, {
      method: "POST",
      json: input,
    });
  }
  stopFinishIt(projectId: string): Promise<{ session: FinishItSession | null }> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/finish-it/stop`, {
      method: "POST",
    });
  }

  // Tools / jobs
  toolManifest(): Promise<ToolManifestEntry[]> {
    return this.request("/tools/manifest");
  }
  /** `projectId` in args is lifted into the adapter's top-level `project` selector. */
  callTool(name: string, args: unknown): Promise<ToolCallResponse> {
    const { projectId, ...rest } = (args && typeof args === "object" ? args : {}) as Record<
      string,
      unknown
    >;
    const json = {
      args: rest,
      ...(typeof projectId === "string" && projectId ? { project: projectId } : {}),
    };
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
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled")
        return job;
      if (opts?.signal?.aborted) return job;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  async routeFrames(runId: string, from = 0): Promise<RouteFrameLine[]> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/route/runs/${encodeURIComponent(runId)}/frames?from=${from}`,
      {
        headers: this.headers(),
      },
    );
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

  // Paired devices (local listener only; a phone never calls these)
  startPairing(): Promise<PairStartResult> {
    return this.request("/v1/devices/pair/start", { method: "POST" });
  }
  cancelPairing(): Promise<{ ok: boolean }> {
    return this.request("/v1/devices/pair/cancel", { method: "POST" });
  }
  listDevices(): Promise<Device[]> {
    return this.request("/v1/devices");
  }
  revokeDevice(id: string): Promise<{ ok: boolean }> {
    return this.request(`/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  remoteState(): Promise<RemoteStatus> {
    return this.request("/v1/remote");
  }

  // The calling device (device-token auth; served on both listeners)
  deviceMe(): Promise<DeviceMe> {
    return this.request("/v1/devices/me");
  }
  /** Idempotent: the phone repeats it on every connect because Expo tokens can rotate. */
  registerPush(
    registration: DevicePushRegistrationInput,
  ): Promise<{ device: Device; push: { registeredAt: string } }> {
    return this.request("/v1/devices/me/push", { method: "PUT", json: registration });
  }
  unregisterPush(): Promise<{ ok: boolean }> {
    return this.request("/v1/devices/me/push", { method: "DELETE" });
  }

  // Settings / lifecycle
  listRouters(): Promise<RouterList> {
    return this.request("/routers");
  }
  installRouter(id: RouterCatalogId): Promise<RouterSnapshot> {
    return this.request(`/routers/${encodeURIComponent(id)}/install`, { method: "POST" });
  }
  cancelRouterInstall(id: RouterCatalogId): Promise<RouterSnapshot> {
    return this.request(`/routers/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  uninstallRouter(id: RouterCatalogId): Promise<RouterSnapshot> {
    return this.request(`/routers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  speechStatus(): Promise<SpeechStatus> {
    return this.request("/v1/speech/status");
  }
  async transcribeSpeech(input: {
    audio: Blob;
    filename?: string;
    language?: string;
    provider?: Settings["voice"]["provider"];
  }): Promise<SpeechTranscript> {
    const form = new FormData();
    form.append("file", input.audio, input.filename ?? "speech.webm");
    if (input.language) form.append("language", input.language);
    if (input.provider) form.append("provider", input.provider);
    const res = await this.fetchImpl(`${this.baseUrl}/v1/speech/transcribe`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) {
      throw new CoreHttpError(
        res.status,
        "/v1/speech/transcribe",
        await res.text().catch(() => res.statusText),
      );
    }
    return (await res.json()) as SpeechTranscript;
  }
  setSpeechCloud(input: { apiKey: string; baseUrl?: string | null }): Promise<SpeechStatus> {
    return this.request("/v1/speech/cloud", { method: "PUT", json: input });
  }
  clearSpeechCloud(): Promise<SpeechStatus> {
    return this.request("/v1/speech/cloud", { method: "DELETE" });
  }
  installLocalSpeech(): Promise<{ modelPath: string; status: SpeechStatus }> {
    return this.request("/v1/speech/local/install", { method: "POST" });
  }
  getSettings(): Promise<Settings> {
    return this.request("/settings");
  }
  getPrivacy(): Promise<PrivacyStatus> {
    return this.request("/privacy");
  }
  patchSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.request("/settings", { method: "PATCH", json: patch });
  }
  saveAgentPreference(preference: AgentPreference): Promise<Settings> {
    return this.request("/settings/agent-preference", { method: "PUT", json: preference });
  }
  saveAgentEffort(preference: AgentEffortPreference): Promise<Settings> {
    return this.request("/settings/agent-effort", { method: "PUT", json: preference });
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
