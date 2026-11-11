/**
 * Turns the daemon's event stream into client state: react-query caches plus the run store.
 * Pure of any platform: shared verbatim by the Electron renderer and the mobile client.
 */
import type {
  CoreEvent,
  SchematicFocus,
  Message,
  MessagePart,
  RouteFrameLine,
  RouteResult,
  Thread,
} from "@fabdesk/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { CoreClient } from "./CoreClient";
import { useAuthStore } from "./stores/auth";
import { useRunsStore, type RunsState } from "./stores/runs";
import { BOARD_WORKSPACE_PATHS, BOARD_WORKSPACE_QUERY_KEY } from "./board-workspace-keys";

export const EVENT_TOPICS = [
  "agent.*",
  "route.*",
  "job.*",
  "project.*",
  "thread.*",
  "auth.*",
  "core.*",
  "finish_it.*",
];

/**
 * Where `route.*` events go. Route Cinema lives in the desktop UI package (it needs a canvas), so
 * the reducer hands frames to whoever is interested instead of depending on that store.
 */
export interface RouteSink {
  ingest: (line: RouteFrameLine) => void;
  setDone: (result: RouteResult) => void;
}

export interface HandlerCtx {
  qc: QueryClient;
  client: CoreClient;
  route?: RouteSink;
  onSchematicFocus?: (focus: SchematicFocus) => void;
}

export function messagesKey(threadId: string) {
  return ["messages", threadId] as const;
}

function patchMessages(qc: QueryClient, threadId: string, fn: (msgs: Message[]) => Message[]) {
  const key = messagesKey(threadId);
  const had = qc.getQueryData<Message[]>(key) !== undefined;
  qc.setQueryData<Message[]>(key, (old) => fn(old ?? []));
  // Seeding a thread this client had never fetched (the other device just started it) leaves the
  // cache with only the streamed assistant message and marks the query fresh, so the user's own
  // message never appeared. Fetch the rest once.
  if (!had) void qc.invalidateQueries({ queryKey: key });
}

function ensureMessage(
  msgs: Message[],
  messageId: string,
  threadId: string,
  runId: string,
): Message[] {
  if (msgs.some((m) => m.id === messageId)) return msgs;
  return [
    ...msgs,
    {
      id: messageId,
      threadId,
      role: "assistant",
      contentMd: "",
      parts: [],
      runId,
      createdAt: new Date().toISOString(),
    },
  ];
}

/**
 * Applies `fn` to every cached copy of a thread: the `["threads", …]` lists and the
 * `["thread", id]` detail. `fn` returning null drops the thread from a list. The refetch the
 * caller also schedules will agree with this; patching first just makes the change instant.
 */
export function patchThreadCaches(
  qc: QueryClient,
  threadId: string,
  fn: (t: Thread) => Thread | null,
): void {
  qc.setQueriesData<unknown>({ queryKey: ["threads"] }, (old: unknown) => {
    if (Array.isArray(old)) {
      const out: Thread[] = [];
      for (const t of old as Thread[]) {
        if (t.id !== threadId) out.push(t);
        else {
          const next = fn(t);
          if (next) out.push(next);
        }
      }
      return out;
    }
    // `["threads", "one", parentId]` holds a single thread or null.
    if (old && typeof old === "object" && (old as Thread).id === threadId) return fn(old as Thread);
    return old;
  });
  qc.setQueriesData<Thread | undefined>({ queryKey: ["thread", threadId] }, (old) =>
    old ? (fn(old) ?? undefined) : old,
  );
}

function updateMessage(msgs: Message[], messageId: string, fn: (m: Message) => Message): Message[] {
  return msgs.map((m) => (m.id === messageId ? fn(m) : m));
}

export function appendDelta(m: Message, kind: "text" | "thinking", delta: string): Message {
  const parts = [...m.parts];
  const last = parts[parts.length - 1];
  if (last && last.type === kind) {
    parts[parts.length - 1] = { type: kind, text: last.text + delta };
  } else {
    parts.push({ type: kind, text: delta });
  }
  return { ...m, parts, contentMd: kind === "text" ? m.contentMd + delta : m.contentMd };
}

export function appendPart(m: Message, part: MessagePart): Message {
  if (part.type === "tool_result") {
    // Results replace an earlier placeholder result with the same id, if any.
    const idx = m.parts.findIndex((p) => p.type === "tool_result" && p.id === part.id);
    if (idx >= 0) {
      const parts = [...m.parts];
      parts[idx] = part;
      return { ...m, parts };
    }
  }
  return { ...m, parts: [...m.parts, part] };
}

/**
 * Supervised mode: the four request/resolve events name a run, not a message, so the part lands
 * on the run's assistant message (the daemon appends it there too). `upsertRequestPart` adds a
 * pending part or replaces the one with the same requestId — an event replayed after a refetch
 * that already carried the part must not duplicate it.
 */
export function upsertRequestPart(m: Message, part: MessagePart & { requestId: string }): Message {
  const idx = m.parts.findIndex(
    (p) => (p.type === "approval" || p.type === "question") && p.requestId === part.requestId,
  );
  if (idx < 0) return { ...m, parts: [...m.parts, part] };
  const parts = [...m.parts];
  parts[idx] = part;
  return { ...m, parts };
}

function patchRequestPart(
  qc: QueryClient,
  threadId: string,
  runId: string,
  requestId: string,
  fn: (p: MessagePart) => MessagePart,
): void {
  patchMessages(qc, threadId, (msgs) =>
    msgs.map((m) =>
      m.runId !== runId
        ? m
        : {
            ...m,
            parts: m.parts.map((p) =>
              (p.type === "approval" || p.type === "question") && p.requestId === requestId
                ? fn(p)
                : p,
            ),
          },
    ),
  );
}

/** The run's assistant message: the daemon created it at run start, so a cache holding the thread has it. */
function patchRunMessage(
  qc: QueryClient,
  threadId: string,
  runId: string,
  fn: (m: Message) => Message,
): void {
  patchMessages(qc, threadId, (msgs) =>
    msgs.map((m) => (m.runId === runId && m.role === "assistant" ? fn(m) : m)),
  );
}

export function handleCoreEvent(event: CoreEvent, ctx: HandlerCtx): void {
  const { qc } = ctx;
  const runs = useRunsStore.getState();
  switch (event.topic) {
    case "project.schematic_focus":
      ctx.onSchematicFocus?.(event.focus);
      break;
    case "agent.started":
      runs.startRun({
        runId: event.runId,
        threadId: event.threadId,
        agentId: event.agentId,
        startedAt: event.ts,
      });
      break;
    case "agent.delta": {
      const threadId = runs.threadByRun[event.runId];
      if (!threadId) break;
      patchMessages(qc, threadId, (msgs) =>
        updateMessage(
          ensureMessage(msgs, event.messageId, threadId, event.runId),
          event.messageId,
          (m) => appendDelta(m, event.part, event.delta),
        ),
      );
      break;
    }
    case "agent.tool_use": {
      const threadId = runs.threadByRun[event.runId];
      if (!threadId) break;
      patchMessages(qc, threadId, (msgs) =>
        updateMessage(
          ensureMessage(msgs, event.messageId, threadId, event.runId),
          event.messageId,
          (m) =>
            appendPart(m, { type: "tool_use", id: event.id, name: event.name, input: event.input }),
        ),
      );
      break;
    }
    case "agent.tool_result": {
      const threadId = runs.threadByRun[event.runId];
      if (!threadId) break;
      patchMessages(qc, threadId, (msgs) =>
        updateMessage(
          ensureMessage(msgs, event.messageId, threadId, event.runId),
          event.messageId,
          (m) =>
            appendPart(m, {
              type: "tool_result",
              id: event.id,
              output: event.output,
              ...(event.isError !== undefined ? { isError: event.isError } : {}),
            }),
        ),
      );
      break;
    }
    case "agent.usage":
      runs.setRunUsage(event.runId, {
        ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      });
      break;
    case "agent.error":
      runs.setRunError(event.runId, event.message);
      break;
    case "agent.done": {
      runs.endRun(event.runId);
      void qc.invalidateQueries({ queryKey: ["thread", event.threadId] });
      void qc.invalidateQueries({ queryKey: messagesKey(event.threadId) });
      void qc.invalidateQueries({ queryKey: ["threads"] });
      break;
    }
    case "agent.approval_requested":
      patchRunMessage(qc, event.threadId, event.runId, (m) =>
        upsertRequestPart(m, {
          type: "approval",
          requestId: event.requestId,
          tool: event.tool,
          input: event.input,
          summary: event.summary,
          decision: "pending",
        }),
      );
      // `["thread", id]` carries `pending`, which is what a badge or the phone's banner reads.
      void qc.invalidateQueries({ queryKey: ["thread", event.threadId] });
      break;
    case "agent.approval_resolved":
      patchRequestPart(qc, event.threadId, event.runId, event.requestId, (p) =>
        p.type === "approval" ? { ...p, decision: event.decision } : p,
      );
      void qc.invalidateQueries({ queryKey: ["thread", event.threadId] });
      break;
    case "agent.input_requested":
      patchRunMessage(qc, event.threadId, event.runId, (m) =>
        upsertRequestPart(m, {
          type: "question",
          requestId: event.requestId,
          question: event.question,
          ...(event.options ? { options: event.options } : {}),
          answer: null,
        }),
      );
      void qc.invalidateQueries({ queryKey: ["thread", event.threadId] });
      break;
    case "agent.input_resolved":
      patchRequestPart(qc, event.threadId, event.runId, event.requestId, (p) =>
        p.type === "question" ? { ...p, answer: event.answer } : p,
      );
      void qc.invalidateQueries({ queryKey: ["thread", event.threadId] });
      break;
    case "job.started":
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      runs.upsertJob({
        jobId: event.jobId,
        endpoint: ctx.client.baseUrl,
        kind: event.kind,
        status: "running",
        startedAt: event.ts,
        ...(event.projectId ? { projectId: event.projectId } : {}),
      });
      break;
    case "job.progress":
      runs.patchJob(event.jobId, {
        ...(event.progress !== undefined ? { progress: event.progress } : {}),
        ...(event.note !== undefined ? { note: event.note } : {}),
      });
      break;
    case "job.done":
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      runs.patchJob(event.jobId, { status: "done", result: event.result, progress: 1 });
      void qc.invalidateQueries({ queryKey: ["job", event.jobId] });
      break;
    case "job.failed":
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      runs.patchJob(event.jobId, { status: "failed", error: event.error });
      void qc.invalidateQueries({ queryKey: ["job", event.jobId] });
      break;
    case "job.cancelled":
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      runs.patchJob(event.jobId, { status: "cancelled" });
      void qc.invalidateQueries({ queryKey: ["job", event.jobId] });
      break;
    case "route.meta":
      ctx.route?.ingest(event.meta as RouteFrameLine);
      break;
    case "route.static":
      ctx.route?.ingest(event.static as RouteFrameLine);
      break;
    case "route.frame":
      ctx.route?.ingest(event.frame as RouteFrameLine);
      break;
    case "route.done":
      ctx.route?.setDone(event.result);
      break;
    case "project.changed":
      if (event.paths.some(path => BOARD_WORKSPACE_PATHS.test(path))) void qc.invalidateQueries({ queryKey: [BOARD_WORKSPACE_QUERY_KEY, event.projectId] });
      if (event.paths.some(path => /(?:\.kicad_(?:sch|pro|pcb)$|(?:^|\/)(?:circuit\.netlist\.json|project\.parts\.json|fabplane\.assembly\.json)$)/.test(path))) void qc.invalidateQueries({ queryKey: ["project-bom", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["kept-output-identity", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["board-sources", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["assembly-board-inspection", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["assembly-pcb-check", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["assembly-check-summaries", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["assembly-model-summaries", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["pcb-check-revision", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["pcb-outline", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["pcb-parts", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["enclosure-source-revision", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["pcb-preview-revision", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["assembly-board-model", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["assembly-schematic-preview", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["root-schematic-preview", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["board-model-revision", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["video-input-revision", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["output-revision", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["finish-it-needs-work", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["project", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      for (const p of event.paths)
        void qc.invalidateQueries({ queryKey: ["file", event.projectId, p] });
      void qc.invalidateQueries({ queryKey: ["file", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["comments", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["notes", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["project-order", event.projectId] });
      break;
    case "thread.created":
      // The list may be filtered by project; the daemon is the only place that knows the rest of
      // the row, so this is a refetch rather than a patch.
      void qc.invalidateQueries({ queryKey: ["threads"] });
      break;
    case "thread.updated": {
      const title = event.title;
      if (title !== undefined) patchThreadCaches(qc, event.threadId, (t) => ({ ...t, title }));
      void qc.invalidateQueries({ queryKey: ["threads"] });
      void qc.invalidateQueries({ queryKey: ["thread", event.threadId] });
      void qc.invalidateQueries({ queryKey: messagesKey(event.threadId) });
      break;
    }
    case "thread.deleted":
      patchThreadCaches(qc, event.threadId, () => null);
      // A screen still showing the thread must not refetch it into a 404; drop the caches instead.
      qc.removeQueries({ queryKey: ["thread", event.threadId] });
      qc.removeQueries({ queryKey: messagesKey(event.threadId) });
      void qc.invalidateQueries({ queryKey: ["threads"] });
      break;
    case "auth.state":
      useAuthStore.getState().setState(event.state);
      qc.setQueryData(["auth"], event.state);
      break;
    case "core.shutdown":
      break;
    case "finish_it.started":
    case "finish_it.progress":
    case "finish_it.milestone":
    case "finish_it.stopped":
    case "finish_it.done":
    case "finish_it.failed":
      qc.setQueryData(["finish-it", event.session.projectId], event.session);
      if (event.topic === "finish_it.done")
        void qc.invalidateQueries({ queryKey: ["finish-it-needs-work", event.session.projectId] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
      void qc.invalidateQueries({ queryKey: ["thread", event.session.threadId] });
      void qc.invalidateQueries({ queryKey: messagesKey(event.session.threadId) });
      break;
    default:
      break;
  }
}

/**
 * Brings the live-run store in line with the daemon after the stream (re)opens: runs in progress
 * that the store never saw (the app started while the agent was already working, or the
 * `agent.started` fell in a gap) are added, and runs the daemon no longer has are ended (a daemon
 * restart marks them failed at startup, before anyone is listening, so no `agent.done` comes).
 * Returns the thread ids whose state changed.
 */
export async function syncLiveRuns(
  client: Pick<CoreClient, "liveRuns">,
  runs: Pick<RunsState, "runsByThread" | "startRun" | "endRun"> = useRunsStore.getState(),
): Promise<string[]> {
  const live = await client.liveRuns().catch(() => null);
  if (!live) return [];
  const changed: string[] = [];
  const liveByThread = new Map(live.map((r) => [r.threadId, r]));
  for (const run of Object.values(runs.runsByThread)) {
    if (liveByThread.get(run.threadId)?.runId === run.runId) continue;
    runs.endRun(run.runId);
    changed.push(run.threadId);
  }
  for (const r of live) {
    if (runs.runsByThread[r.threadId]?.runId === r.runId) continue;
    runs.startRun({
      runId: r.runId,
      threadId: r.threadId,
      agentId: r.agentId,
      startedAt: Date.parse(r.startedAt),
    });
    changed.push(r.threadId);
  }
  return changed;
}
