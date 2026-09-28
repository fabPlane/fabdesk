import type {
  ApprovalDecision,
  PendingRequests,
  RuntimeMode,
  Job,
  Message,
  OrderVendorId,
  ProjectSummary,
  RouteFrameLine,
  RouteResult,
} from "@fabdesk/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
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

export function usePatchSettings() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof client.patchSettings>[0]) => client.patchSettings(patch),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
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

/* ---------- projects: create / delete ---------- */

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
  const refresh = () => void qc.invalidateQueries({ queryKey: shoppingListKey(projectId) });
  const need = () => {
    if (!projectId) throw new Error("no project selected");
    return projectId;
  };
  return {
    create: useMutation({ mutationFn: () => client.createShoppingList(need()), onSuccess: refresh }),
    syncBom: useMutation({ mutationFn: () => client.syncShoppingBom(need()), onSuccess: refresh }),
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
