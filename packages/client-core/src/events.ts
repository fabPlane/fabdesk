/**
 * Turns the daemon's event stream into client state: react-query caches plus the run store.
 * Pure of any platform: shared verbatim by the Electron renderer and the mobile client.
 */
import type {
  CoreEvent,
  Message,
  MessagePart,
  RouteFrameLine,
  RouteResult,
} from "@fabdesk/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { CoreClient } from "./CoreClient";
import { useAuthStore } from "./stores/auth";
import { useRunsStore } from "./stores/runs";

export const EVENT_TOPICS = [
  "agent.*",
  "route.*",
  "job.*",
  "project.*",
  "thread.*",
  "auth.*",
  "core.*",
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
}

export function messagesKey(threadId: string) {
  return ["messages", threadId] as const;
}

function patchMessages(qc: QueryClient, threadId: string, fn: (msgs: Message[]) => Message[]) {
  qc.setQueryData<Message[]>(messagesKey(threadId), (old) => fn(old ?? []));
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

export function handleCoreEvent(event: CoreEvent, ctx: HandlerCtx): void {
  const { qc } = ctx;
  const runs = useRunsStore.getState();
  switch (event.topic) {
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
      void qc.invalidateQueries({ queryKey: messagesKey(event.threadId) });
      void qc.invalidateQueries({ queryKey: ["threads"] });
      break;
    }
    case "job.started":
      runs.upsertJob({
        jobId: event.jobId,
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
      runs.patchJob(event.jobId, { status: "done", result: event.result, progress: 1 });
      void qc.invalidateQueries({ queryKey: ["job", event.jobId] });
      break;
    case "job.failed":
      runs.patchJob(event.jobId, { status: "failed", error: event.error });
      void qc.invalidateQueries({ queryKey: ["job", event.jobId] });
      break;
    case "job.cancelled":
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
      void qc.invalidateQueries({ queryKey: ["project", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      for (const p of event.paths)
        void qc.invalidateQueries({ queryKey: ["file", event.projectId, p] });
      void qc.invalidateQueries({ queryKey: ["file", event.projectId] });
      break;
    case "thread.updated":
      void qc.invalidateQueries({ queryKey: ["threads"] });
      void qc.invalidateQueries({ queryKey: messagesKey(event.threadId) });
      break;
    case "auth.state":
      useAuthStore.getState().setState(event.state);
      qc.setQueryData(["auth"], event.state);
      break;
    case "core.shutdown":
      break;
    default:
      break;
  }
}
