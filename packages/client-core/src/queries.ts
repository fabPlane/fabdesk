import { inspectKeptOutputIdentity, type KeptOutputKind } from "./kept-output";
import { pcbToolJson } from "./pcb-parts";
import { inspectVideoInputRevision } from "./video-input-revision";
import { inspectRouteReview } from "./route-review";
import { inspectAssemblySchematicPreview } from "./assembly-schematic-preview";
import { inspectAssemblyModelSummaries } from "./assembly-model-summary";
import { inspectAssemblyBoardModel } from "./assembly-board-model";
import { inspectAssemblyCheckSummaries } from "./assembly-check-summary";
import { inspectAssemblyPcbCheck } from "./assembly-checks";
import { inspectAssemblyBoard } from "./assembly-scene";
import type { BoardSourceSelection, ProjectBoardSources, ProjectBomSnapshot, BomSyncOptions } from "@fabdesk/protocol";
import { inspectBoardModelRevision } from "./board-model-revision";
import { inspectPcbCheckRevision } from "./check-revision";
import { inspectPcbOutline } from "./pcb-outline";
import { inspectPcbParts } from "./pcb-parts";
import { inspectEnclosureSourceRevision } from "./enclosure-revision";
import { inspectPcbPreviewRevision } from "./pcb-preview-revision";
import type {
  AgentId,
  ApprovalDecision,
  PendingRequests,
  RuntimeMode,
  Job,
  Message,
  OrderVendorId,
  ProjectSummary,
  RouteFrameLine,
  RouteResult,
  RouterCatalogId,
} from "@fabdesk/protocol";
import { useInfiniteQuery, useIsMutating, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useCoreClient } from "./provider";
import { messagesKey } from "./events";
import {
  CoreHttpError,
  type CreateThreadInput,
  type DevicePushRegistration,
  type PatchThreadInput,
  type SendMessageInput,
} from "./CoreClient";
import { useAuthStore } from "./stores/auth";

export function useProjects() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["projects"], queryFn: () => client.listProjects() });
}

export function useProject(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => client.getProject(projectId!),
    enabled: !!projectId,
  });
}

export function useBoardSources(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["board-sources", projectId], queryFn: () => client.inspectBoardSources(projectId!), enabled: !!projectId });
}

export function useProjectBom(projectId: string | null, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["project-bom", projectId], enabled: enabled && !!projectId, retry: false, staleTime: 30_000,
    queryFn: async (): Promise<ProjectBomSnapshot> => {
      const call = await client.callTool("bom_read", { projectId });
      const job = call.jobId ? await client.waitJob(call.jobId) : null;
      if (job && job.status !== "done") throw new Error(job.error ?? "Could not read project BOM");
      const snapshot = pcbToolJson(job ? job.result : call);
      if (snapshot.contract !== "fabplane.project-bom.v1" || snapshot.projectId !== projectId || !Array.isArray(snapshot.lines) || !Array.isArray(snapshot.coverage)) throw new Error("The parts list did not return a captured project BOM.");
      return snapshot as unknown as ProjectBomSnapshot;
    },
  });
}

export function useAssemblyPreviewRevisions(projectId: string, sources: ProjectBoardSources["sources"]) {
  const client = useCoreClient();
  const queries = useQueries({ queries: sources.map(source => {
    const directory = source.source.location === "project" ? source.source.directory : null;
    return { queryKey: directory === "." ? ["pcb-preview-revision", projectId, ".", source.pcbSha256] : directory ? ["pcb-preview-revision", projectId, directory, source.pcbSha256] : ["pcb-preview-revision", projectId, "unresolved", source.source.id], queryFn: () => inspectPcbPreviewRevision(client, projectId, directory!, source.pcbSha256), enabled: source.status === "available" && !!source.previewPath && directory !== null };
  }) });
  return sources.map((source, index) => ({ sourceId: source.source.id, trackable: source.status === "available" && !!source.previewPath && source.source.location === "project", ...queries[index]! }));
}

export function useAssemblyBoardInspection(projectId: string, board: BoardSourceSelection, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["assembly-board-inspection", projectId, board.sourceId, board.manifestSha256], queryFn: () => inspectAssemblyBoard(client, projectId, board), enabled });
}

export function useOpenCatalog(q = "") {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["opensource", q],
    queryFn: () => client.listOpenSource(q),
    staleTime: 60_000,
  });
}

export function useOpenSourceProject(id: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["opensource", "project", id],
    queryFn: () => client.getOpenSource(id!),
    enabled: !!id,
  });
}

export function useProjectOrder(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["project-order", projectId],
    queryFn: () => client.projectOrder(projectId!),
    enabled: !!projectId,
  });
}

export function useStartOrder() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, vendor }: { projectId: string; vendor: OrderVendorId }) =>
      client.startOrder(projectId, vendor),
    onSuccess: (_data, vars) =>
      void qc.invalidateQueries({ queryKey: ["project-order", vars.projectId] }),
  });
}

export function useRemixOpenSource() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.remixOpenSource(id),
    onSuccess: (result) => {
      qc.setQueryData<ProjectSummary[]>(["projects"], (old) => {
        const next = old ?? [];
        if (next.some((p) => p.id === result.project.id)) return next;
        return [result.project, ...next];
      });
      qc.setQueryData(["project", result.project.id], result.project);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["project", result.project.id] });
      void qc.invalidateQueries({ queryKey: ["file", result.project.id] });
    },
  });
}

export function useThreads(params?: { q?: string; projectId?: string | null }) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["threads", params?.q ?? "", params?.projectId ?? ""],
    queryFn: () => client.listThreads(params),
    // A search types one key per letter; showing the previous list until the next answers keeps
    // the screen from flashing "no chats match" between keystrokes.
    placeholderData: (previous) => previous,
  });
}

export function useChatSearch(query: string) {
  const client = useCoreClient();
  const input = query.trim();
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(input), 250);
    return () => clearTimeout(timer);
  }, [input]);
  return useInfiniteQuery({
    queryKey: ["chat-search", input],
    queryFn: ({ pageParam }) => client.searchChats(input, pageParam),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextOffset ?? undefined,
    enabled: q.length >= 2 && q === input,
  });
}

export function useThread(threadId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => client.getThread(threadId!),
    enabled: !!threadId,
  });
}

export function useMessages(threadId: string | null) {
  const client = useCoreClient();
  return useQuery<Message[]>({
    queryKey: messagesKey(threadId ?? "__none__"),
    queryFn: () => client.listMessages(threadId!),
    enabled: !!threadId,
  });
}

export function useDoctor() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["doctor"], queryFn: () => client.doctor(), staleTime: 60_000 });
}

export function useSettings() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["settings"], queryFn: () => client.getSettings() });
}

/** The core's first-install privacy decision; it does not change while the core runs. */
export function usePrivacy() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["privacy"], queryFn: () => client.getPrivacy(), staleTime: Infinity, retry: false });
}

export const ROUTER_INSTALL_MUTATION_KEY = ["router-install"] as const;

export function useRouters() {
  const client = useCoreClient();
  // `POST /routers/:id/install` only answers when the install ends, so the list must keep polling while
  // that request is in flight, or the card would never show progress.
  const installRequestInFlight = useIsMutating({ mutationKey: ROUTER_INSTALL_MUTATION_KEY }) > 0;
  return useQuery({
    queryKey: ["routers"],
    queryFn: () => client.listRouters(),
    // Keep the progress bar moving even when the window is occluded: it only polls while an install runs.
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      installRequestInFlight || query.state.data?.routers.some((row) => row.state === "installing")
        ? 500
        : false,
  });
}

export function useInstallRouter() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ROUTER_INSTALL_MUTATION_KEY,
    mutationFn: (id: RouterCatalogId) => client.installRouter(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["routers"] }),
  });
}

export function useUninstallRouter() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: RouterCatalogId) => client.uninstallRouter(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["routers"] });
      // The core resets the saved default when the default router is uninstalled.
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useCancelRouterInstall() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: RouterCatalogId) => client.cancelRouterInstall(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["routers"] }),
  });
}

export function useSpeechStatus() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["speech"], queryFn: () => client.speechStatus(), staleTime: 10_000 });
}

export function usePatchSettings() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof client.patchSettings>[0]) => client.patchSettings(patch),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      // The router list echoes the saved default (the Route Cinema picker reads it from there).
      void qc.invalidateQueries({ queryKey: ["routers"] });
    },
  });
}

export function useAuthState() {
  const client = useCoreClient();
  const setState = useAuthStore((s) => s.setState);
  const q = useQuery({ queryKey: ["auth"], queryFn: () => client.authState(), staleTime: 10_000 });
  useEffect(() => {
    if (q.data) setState(q.data);
  }, [q.data, setState]);
  return q;
}

export function useToolManifest() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["tools"], queryFn: () => client.toolManifest(), staleTime: 60_000 });
}

export function useJob(jobId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => client.getJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "queued" || s === "running" ? 1000 : false;
    },
  });
}

/** Text file from the project; `null` data when the file does not exist (404). */
export function useProjectText(projectId: string | null, path: string | null) {
  const client = useCoreClient();
  return useQuery<string | null>({
    queryKey: ["file", projectId, path, "text"],
    queryFn: async () => {
      try {
        return await client.readFile(projectId!, path!);
      } catch (e) {
        if (e instanceof CoreHttpError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!projectId && !!path,
  });
}

export function useProjectJson<T = unknown>(projectId: string | null, path: string | null) {
  const q = useProjectText(projectId, path);
  let data: T | null | undefined;
  let parseError: string | null = null;
  if (q.data === null) data = null;
  else if (typeof q.data === "string") {
    try {
      data = JSON.parse(q.data) as T;
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
      data = null;
    }
  }
  return { ...q, data, parseError };
}

export function useThreadMutations() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["threads"] });
    void qc.invalidateQueries({ queryKey: ["thread"] });
  };
  const create = useMutation({
    mutationFn: (input: CreateThreadInput) => client.createThread(input),
    onSuccess: () => void invalidate(),
  });
  const patch = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchThreadInput }) =>
      client.patchThread(id, patch),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.deleteThread(id),
    onSuccess: () => void invalidate(),
  });
  return { create, patch, remove };
}

/** Paired phones, and whether the daemon's remote listener is actually bound. */
export function useDevices(enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["devices"], queryFn: () => client.listDevices(), enabled });
}

export function useRemoteState(enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["remote"], queryFn: () => client.remoteState(), enabled });
}

/**
 * The paired phone's own record on the daemon it is talking to, with its push registration
 * (docs/mobile-notifications.md §4.1). Only meaningful under device-token auth; a desktop
 * session gets a 404 and the query simply errors.
 */
export function useDeviceMe(enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["device-me"], queryFn: () => client.deviceMe(), enabled });
}

export function useRegisterPush() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (registration: DevicePushRegistration) => client.registerPush(registration),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["device-me"] }),
  });
}

export function useUnregisterPush() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.unregisterPush(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["device-me"] }),
  });
}

/**
 * A file the platform's `FormData` can carry: a `Blob` on the web, or React Native's
 * `{ uri, name, type }` descriptor, which its networking layer streams from disk itself.
 */
export type UploadFile = Blob | { uri: string; name: string; type: string };

/**
 * Stores an image in a project's sketches folder (`POST /projects/:id/sketches`); the returned
 * `path` is what a message's `attachments` reference. Invalidates the project so its file list
 * picks the new sketch up.
 */
export function useUploadSketch() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      file,
      name,
    }: {
      projectId: string;
      file: UploadFile;
      name: string;
    }) => client.uploadSketch(projectId, file as Blob, name),
    onSuccess: (_data, vars) =>
      void qc.invalidateQueries({ queryKey: ["project", vars.projectId] }),
  });
}

/** A routing run as `GET /projects/:id/route-runs` and `GET /route/runs/:id` describe it (`RouteRunRecord` in @fabdesk/tools). */
export interface RouteRunSummary {
  id: string;
  projectId: string;
  router: string;
  fallbackReason?: string | null;
  attempts?: Array<{ router: string; outcome: string; reason: string | null }>;
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
  result: RouteResult | null;
  error: string | null;
}

export function routeRunsKey(projectId: string | null) {
  return ["route-runs", projectId] as const;
}

/** A project's routing runs, newest first; polls while one is still running. */
export function useRouteRuns(projectId: string | null) {
  const client = useCoreClient();
  return useQuery<RouteRunSummary[]>({
    queryKey: routeRunsKey(projectId),
    queryFn: () => client.request(`/projects/${encodeURIComponent(projectId!)}/route-runs`),
    enabled: !!projectId,
    refetchInterval: (q) =>
      q.state.data?.some((r) =>
        ["queued", "running", "cancel_requested", "cancelling"].includes(r.status),
      )
        ? 3000
        : false,
  });
}

/** One routing run's record; polls while it is running so a viewer learns when it finishes. */
export function useRouteRun(runId: string | null) {
  const client = useCoreClient();
  return useQuery<RouteRunSummary>({
    queryKey: ["route-run", runId],
    queryFn: () => client.request(`/route/runs/${encodeURIComponent(runId!)}`),
    enabled: !!runId,
    refetchInterval: (q) =>
      q.state.data &&
      ["queued", "running", "cancel_requested", "cancelling"].includes(q.state.data.status)
        ? 2000
        : false,
  });
}

export function useRouteReview(projectId: string, runId: string, enabled: boolean) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["route-review", projectId, runId], queryFn: () => inspectRouteReview(client, projectId, runId), enabled });
}

/**
 * Every frame line of a run (`meta`, `static`, then `frame`s), for playing it back. Pass
 * `final: true` once the run has finished: its frames file never changes again, so the result is
 * cached for good. For a live run, follow `routeFrameHub` and catch up with
 * `client.routeFrames(id, nextFrameSeq(run))`.
 */
export function useRouteRunFrames(
  runId: string | null,
  opts?: { enabled?: boolean; final?: boolean },
) {
  const client = useCoreClient();
  return useQuery<RouteFrameLine[]>({
    queryKey: ["route-run", runId, "frames"],
    queryFn: () => client.routeFrames(runId!),
    enabled: !!runId && (opts?.enabled ?? true),
    staleTime: opts?.final ? Infinity : 0,
  });
}

/* ---------- projects: create / rename / delete ---------- */

export function useRenameProject() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      client.request(`/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH", json: { name },
      }),
    onSuccess: (_data, { projectId }) => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}

export function useCreateProject() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => client.createProject(name),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}

/** `purge` removes the directory too; without it the daemon only forgets the project. */
export function useDeleteProject() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, purge }: { projectId: string; purge?: boolean }) =>
      client.request<{ ok: boolean }>(
        `/projects/${encodeURIComponent(projectId)}${purge ? "?purge=1" : ""}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      qc.removeQueries({ queryKey: ["project", vars.projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

/** Thread folders (`Thread.folderId`); the daemon has no project folders yet. */
export function useFolders(enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["folders"],
    queryFn: () => client.request<Folder[]>("/folders"),
    enabled,
    staleTime: 60_000,
  });
}

/* ---------- files ---------- */

export function useWriteProjectFile() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      path,
      content,
    }: {
      projectId: string;
      path: string;
      content: string;
    }) => client.writeFile(projectId, path, content),
    onSuccess: (_data, vars) => {
      // The watcher's project.changed follows, but not before this resolves; seed the cache so the
      // viewer shows what was just saved without a round trip.
      qc.setQueryData(["file", vars.projectId, vars.path, "text"], vars.content);
      void qc.invalidateQueries({ queryKey: ["project", vars.projectId] });
    },
  });
}

/* ---------- jobs ---------- */

/** Every job the daemon knows about; polls while one is queued or running, events cover the rest. */
export function useJobs(enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => client.request<Job[]>("/jobs"),
    enabled,
    refetchInterval: (q) =>
      q.state.data?.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false,
  });
}

export function useCancelJob() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      client.request<{ ok: boolean }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
      }),
    onSuccess: (_data, jobId) => {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["job", jobId] });
    },
  });
}

/* ---------- supervised runs: approvals and questions ---------- */

/**
 * The daemon's `pending` block on `GET /threads/:id`, typed by the protocol; the `Pending*Request`
 * aliases are the event objects minus nothing — kept as names because the screens use them.
 */
export type { ApprovalDecision, RuntimeMode } from "@fabdesk/protocol";
export type PendingApprovalRequest = PendingRequests["approvals"][number];
export type PendingInputRequest = PendingRequests["inputs"][number];
export type PendingRequestsBlock = PendingRequests;

export function pendingRequestsKey(threadId: string | null) {
  // Under `["thread", id]` on purpose: invalidating the thread invalidates this too.
  return ["thread", threadId, "pending"] as const;
}

/**
 * What a thread's run is waiting on (`GET /threads/:id` → `pending`). A daemon without supervised
 * mode omits the block, which reads as nothing pending. Polls while `live` because the event
 * reducer may not yet know the `agent.approval_requested` topics; when it does, its invalidation
 * of `["thread", id]` refreshes this ahead of the poll.
 */
export function usePendingRequests(threadId: string | null, opts?: { live?: boolean }) {
  const client = useCoreClient();
  return useQuery<PendingRequestsBlock>({
    queryKey: pendingRequestsKey(threadId),
    queryFn: async () => {
      const thread = await client.request<{ pending?: Partial<PendingRequestsBlock> }>(
        `/threads/${encodeURIComponent(threadId!)}`,
      );
      return {
        approvals: Array.isArray(thread.pending?.approvals) ? thread.pending.approvals : [],
        inputs: Array.isArray(thread.pending?.inputs) ? thread.pending.inputs : [],
      };
    },
    enabled: !!threadId,
    refetchInterval: opts?.live ? 2000 : false,
    staleTime: 0,
  });
}

/** `POST /threads/:id/approvals/:requestId { decision }`; 409 means someone answered first. */
export function useResolveApproval() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      threadId,
      requestId,
      decision,
    }: {
      threadId: string;
      requestId: string;
      decision: ApprovalDecision;
    }) =>
      client.request<{ ok: boolean }>(
        `/threads/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(requestId)}`,
        { method: "POST", json: { decision } },
      ),
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ["thread", vars.threadId] });
      void qc.invalidateQueries({ queryKey: messagesKey(vars.threadId) });
    },
  });
}

/** `POST /threads/:id/inputs/:requestId { answer }` for a pending question. */
export function useAnswerQuestion() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      threadId,
      requestId,
      answer,
    }: {
      threadId: string;
      requestId: string;
      answer: string;
    }) =>
      client.request<{ ok: boolean }>(
        `/threads/${encodeURIComponent(threadId)}/inputs/${encodeURIComponent(requestId)}`,
        { method: "POST", json: { answer } },
      ),
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ["thread", vars.threadId] });
      void qc.invalidateQueries({ queryKey: messagesKey(vars.threadId) });
    },
  });
}

/**
 * `PATCH /threads/:id { runtimeMode }`. Kept apart from `useThreadMutations().patch` until
 * `PatchThreadInput` carries the field; a daemon without supervised mode answers 400, which the
 * caller shows. Invalidates the thread so the header reflects the daemon's answer.
 */
export function useSetRuntimeMode() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, runtimeMode }: { threadId: string; runtimeMode: RuntimeMode }) =>
      client.request<unknown>(`/threads/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        json: { runtimeMode },
      }),
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: ["thread", vars.threadId] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
    },
  });
}

/* ---------- queued messages ---------- */

/** A `Message` once the daemon can hold one back: `status: "queued"` until the live run ends. */
/** A message as the daemon returns it; `status` is `"queued"` until the run ends and it is sent. */
export type QueuedMessage = Message;

/**
 * `POST /threads/:id/messages?queue=1`: stored while a run is live, sent when it ends. The daemon
 * answers with the stored message's id; the run id is absent until it actually goes out.
 */
export function useQueueMessage() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, input }: { threadId: string; input: SendMessageInput }) =>
      client.request<{ messageId: string; runId?: string }>(
        `/threads/${encodeURIComponent(threadId)}/messages?queue=1`,
        { method: "POST", json: { ...input, queue: true } },
      ),
    onSettled: (_data, _err, vars) =>
      void qc.invalidateQueries({ queryKey: messagesKey(vars.threadId) }),
  });
}

/** `DELETE /threads/:id/messages/:messageId` — only a still-queued message can be removed. */
export function useUnqueueMessage() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, messageId }: { threadId: string; messageId: string }) =>
      client.request<void>(
        `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
        { method: "DELETE" },
      ),
    onMutate: ({ threadId, messageId }) => {
      // Drop the chip at once; the refetch on settle agrees or brings it back.
      qc.setQueryData<Message[]>(messagesKey(threadId), (old) =>
        old ? old.filter((m) => m.id !== messageId) : old,
      );
    },
    onSettled: (_data, _err, vars) =>
      void qc.invalidateQueries({ queryKey: messagesKey(vars.threadId) }),
  });
}

/* ---------- fabplane.com shopping lists & inventory ---------- */

export function useCloudStatus(enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["cloud", "status"],
    queryFn: () => client.cloudStatus(),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCloudDestinations(enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["cloud", "destinations"],
    queryFn: async () => (await client.cloudDestinations()).destinations,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function shoppingListKey(projectId: string | null) {
  return ["cloud", "shopping-list", projectId] as const;
}

/** Polls while mounted so edits the agent makes through the shopping tools show up. */
export function useShoppingList(projectId: string | null, enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: shoppingListKey(projectId),
    queryFn: () => client.shoppingList(projectId!),
    enabled: enabled && !!projectId,
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useShoppingListMutations(projectId: string | null) {
  const client = useCoreClient();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: shoppingListKey(projectId) });
  const need = () => {
    if (!projectId) throw new Error("no project selected");
    return projectId;
  };
  return {
    create: useMutation({ mutationFn: () => client.createShoppingList(need()), onSuccess: refresh }),
    syncBom: useMutation({ mutationFn: (options: BomSyncOptions) => client.syncShoppingBom(need(), options), onSuccess: refresh }),
    add: useMutation({
      mutationFn: (items: Parameters<typeof client.addShoppingItems>[1]) =>
        client.addShoppingItems(need(), items),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ itemId, patch }: { itemId: string; patch: Parameters<typeof client.updateShoppingItem>[2] }) =>
        client.updateShoppingItem(need(), itemId, patch),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (itemId: string) => client.removeShoppingItem(need(), itemId),
      onSuccess: refresh,
    }),
  };
}

export function useInventory(q: string, enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["cloud", "inventory", q],
    queryFn: () => client.searchInventory(q),
    enabled,
    retry: false,
  });
}

export function useInventoryMutations() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cloud", "inventory"] });
  return {
    create: useMutation({
      mutationFn: ({ input, image }: { input: Parameters<typeof client.createInventoryItem>[0]; image?: { data: Blob; filename: string } }) =>
        client.createInventoryItem(input, image),
      onSuccess: refresh,
    }),
    adjust: useMutation({
      mutationFn: ({ itemId, delta }: { itemId: string; delta: number }) => client.adjustInventory(itemId, delta),
      onSuccess: refresh,
    }),
  };
}

export function useBoardComments(projectId: string | null, board?: BoardSourceSelection, enabled = true) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["comments", projectId, board ?? null],
    queryFn: () => client.listComments(projectId!, board),
    enabled: !!projectId && enabled,
  });
}

export function useFinishIt(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["finish-it", projectId],
    queryFn: async () => (await client.getFinishIt(projectId!)).session,
    enabled: !!projectId,
  });
}

export function useBoardNotes(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["notes", projectId],
    queryFn: () => client.readNotes(projectId!),
    enabled: !!projectId,
  });
}

export function useBoardCommentMutations(projectId: string | null, board?: BoardSourceSelection) {
  const client = useCoreClient();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["comments", projectId] });
    void qc.invalidateQueries({ queryKey: ["notes", projectId] });
    void qc.invalidateQueries({ queryKey: ["file", projectId] });
    void qc.invalidateQueries({ queryKey: ["project", projectId] });
  };
  return {
    pin: useMutation({
      mutationFn: (input: Parameters<typeof client.pinComment>[1]) => client.pinComment(projectId!, input, board),
      onSuccess: refresh,
    }),
    patch: useMutation({
      mutationFn: ({ commentId, patch }: { commentId: string; patch: Parameters<typeof client.patchComment>[2] }) =>
        client.patchComment(projectId!, commentId, patch, board),
      onSuccess: refresh,
    }),
    writeNotes: useMutation({
      mutationFn: (content: string) => client.writeNotes(projectId!, content),
      onSuccess: refresh,
    }),
  };
}

/** Recheck completed boards after project changes without rewriting session history. */
export function useFinishItNeedsWork(projectId: string | null, enabled: boolean) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["finish-it-needs-work", projectId],
    queryFn: async () => (await client.getFinishIt(projectId!)).needsWork ?? true,
    enabled: !!projectId && enabled,
  });
}

export function useStartFinishIt() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      threadId,
      agentId,
      model,
    }: {
      projectId: string;
      threadId?: string;
      agentId?: AgentId;
      model?: string;
    }) => client.startFinishIt(projectId, { ...(threadId ? { threadId } : {}), ...(agentId ? { agentId } : {}), ...(model ? { model } : {}) }),
    onSuccess: (data, vars) => {
      qc.setQueryData(["finish-it", vars.projectId], data.session);
      void qc.invalidateQueries({ queryKey: ["threads"] });
      void qc.invalidateQueries({ queryKey: ["thread", data.session.threadId] });
      void qc.invalidateQueries({ queryKey: messagesKey(data.session.threadId) });
    },
  });
}

export function useStopFinishIt() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => client.stopFinishIt(projectId),
    onSuccess: (data, projectId) => {
      qc.setQueryData(["finish-it", projectId], data.session);
    },
  });
}

export function useKeptOutputIdentity(projectId: string, kind: KeptOutputKind, enabled: boolean) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["kept-output-identity", projectId, client.baseUrl, kind], queryFn: () => inspectKeptOutputIdentity(client, projectId, kind), enabled, retry: false });
}

export function usePcbPreviewRevision(projectId: string | null, enabled = true, directory = ".") {
  const client = useCoreClient();
  return useQuery({ queryKey: directory === "." ? ["pcb-preview-revision", projectId] : ["pcb-preview-revision", projectId, directory], queryFn: () => inspectPcbPreviewRevision(client, projectId!, directory), enabled: !!projectId && enabled });
}

export function useEnclosureSourceRevision(projectId: string | null, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["enclosure-source-revision", projectId], queryFn: () => inspectEnclosureSourceRevision(client, projectId!), enabled: !!projectId && enabled });
}

export function usePcbPartsNear(projectId: string, point: { x: number; y: number }, enabled: boolean, board?: BoardSourceSelection) {
  const client = useCoreClient();
  return useQuery({ queryKey: board ? ["pcb-parts", projectId, "source", board.sourceId, board.manifestSha256, point.x, point.y] : ["pcb-parts", projectId, point.x, point.y], queryFn: () => inspectPcbParts(client, projectId, { near: { ...point, radius: 5 } }, board), enabled });
}

export function usePcbOutline(projectId: string, enabled: boolean, board?: BoardSourceSelection) {
  const client = useCoreClient();
  return useQuery({ queryKey: board ? ["pcb-outline", projectId, "source", board.sourceId, board.manifestSha256] : ["pcb-outline", projectId], queryFn: () => inspectPcbOutline(client, projectId, board), enabled });
}

export function usePcbCheckRevision(projectId: string | null, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["pcb-check-revision", projectId], queryFn: () => inspectPcbCheckRevision(client, projectId!), enabled: !!projectId && enabled });
}


export function useBoardModelRevision(projectId: string | null, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["board-model-revision", projectId], queryFn: () => inspectBoardModelRevision(client, projectId!), enabled: !!projectId && enabled });
}

export function useAssemblyPcbCheck(projectId: string, board: BoardSourceSelection | null, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["assembly-pcb-check", projectId, board?.sourceId ?? null, board?.manifestSha256 ?? null], queryFn: () => inspectAssemblyPcbCheck(client, projectId, board!), enabled: !!board && enabled });
}

export function useAssemblyCheckSummaries(projectId: string, data: ProjectBoardSources) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["assembly-check-summaries", projectId, data.manifestSha256, data.sources.map(row => [row.source.id, row.status, row.pcbSha256 ?? null, row.source])], queryFn: () => inspectAssemblyCheckSummaries(client, projectId, data) });
}

export function useAssemblyModelSummaries(projectId: string, data: ProjectBoardSources | undefined, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["assembly-model-summaries", projectId, data?.manifestSha256 ?? null, data?.sources.map(row => [row.source.id, row.status, row.pcbSha256 ?? null, row.source]) ?? []], enabled: enabled && !!data, queryFn: () => {
    if (!data) throw new Error("Choose an assembly before reviewing model sources.");
    return inspectAssemblyModelSummaries(client, projectId, data);
  } });
}

export function useAssemblyBoardModel(projectId: string, board: BoardSourceSelection, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["assembly-board-model", projectId, board.sourceId, board.manifestSha256], queryFn: () => inspectAssemblyBoardModel(client, projectId, board), enabled });
}

export function useAssemblySchematicPreview(projectId: string, board: BoardSourceSelection, selectedPath: string | null, enabled = true) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["assembly-schematic-preview", projectId, board.sourceId, board.manifestSha256, selectedPath], queryFn: () => inspectAssemblySchematicPreview(client, projectId, board, selectedPath), enabled });
}

export function useVideoInputRevision(projectId: string | null, path: string | undefined) {
  const client = useCoreClient();
  return useQuery({ queryKey: ["video-input-revision", projectId, path], queryFn: () => inspectVideoInputRevision(client, projectId!, path!), enabled: !!projectId && !!path });
}

/** Library cards share the selected player's checks; callers restrict this to recorded product formats. */
export function useVideoInputRevisions(projectId: string | null, paths: string[]) {
  const client = useCoreClient();
  const rows = useQueries({ queries: paths.map(path => ({
    queryKey: ["video-input-revision", projectId, path],
    queryFn: () => inspectVideoInputRevision(client, projectId!, path),
    enabled: !!projectId,
  })) });
  return rows.map((row, index) => ({ ...row, path: paths[index]! }));
}
