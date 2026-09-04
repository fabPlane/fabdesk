import type { UpdateCheckResult, UpdateDownloadState } from "@fabdesk/protocol";
import type { CoreEvent, Message, MessagePart, RouteFrameLine } from "@fabdesk/protocol";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuthStore } from "../stores/auth";
import { useCinemaStore } from "../stores/cinema";
import { useRunsStore } from "../stores/runs";
import { useUiStore } from "../stores/ui";
import { CoreClient } from "./CoreClient";
import type { SseStatus } from "./sse";

export interface FilePickOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** What the surrounding shell (Electron preload, or a web host) provides to the UI. */
export interface HostAdapter {
  platform: string;
  /** Dev-profile build (unpackaged, or FABDESK_DEV_PROFILE=1): staging/local sign-in is shown up front. */
  devBuild?: boolean;
  openExternal: (url: string) => Promise<void> | void;
  pickFile: (opts?: FilePickOptions) => Promise<string[]>;
  localAuthAllowed: () => Promise<boolean>;
  setLocalAuth?: (enabled: boolean) => Promise<void>;
  restartCore?: () => Promise<void>;
  openLogs?: () => Promise<void>;
  /** Last update-check result from the host (Electron main), if it performs checks. */
  updateStatus?: () => Promise<UpdateCheckResult | null>;
  checkForUpdates?: () => Promise<UpdateCheckResult>;
  onUpdateStatus?: (cb: (result: UpdateCheckResult) => void) => () => void;
  /** In-app installer download (Electron only); absent hosts fall back to opening the URL. */
  updateDownloadState?: () => Promise<UpdateDownloadState>;
  downloadUpdate?: () => Promise<UpdateDownloadState>;
  cancelUpdateDownload?: () => Promise<void>;
  openUpdate?: () => Promise<string>;
  onUpdateDownload?: (cb: (state: UpdateDownloadState) => void) => () => void;
}

export const browserHost: HostAdapter = {
  platform: "web",
  openExternal: (url) => {
    window.open(url, "_blank", "noopener");
  },
  pickFile: async () => [],
  localAuthAllowed: async () => false,
};

export interface CoreContextValue {
  client: CoreClient;
  host: HostAdapter;
  sseStatus: SseStatus;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export function useCore(): CoreContextValue {
  const v = useContext(CoreContext);
  if (!v) throw new Error("useCore must be used inside <CoreProvider>");
  return v;
}

export function useCoreClient(): CoreClient {
  return useCore().client;
}

export const EVENT_TOPICS = ["agent.*", "route.*", "job.*", "project.*", "thread.*", "auth.*", "core.*"];

export interface CoreProviderProps {
  client: CoreClient;
  host?: HostAdapter;
  queryClient?: QueryClient;
  children: ReactNode;
}

export function CoreProvider({ client, host = browserHost, queryClient, children }: CoreProviderProps) {
  const [qc] = useState(
    () =>
      queryClient ??
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
      }),
  );
  const [sseStatus, setSseStatus] = useState<SseStatus>("connecting");
  const value = useMemo<CoreContextValue>(() => ({ client, host, sseStatus }), [client, host, sseStatus]);
  return (
    <QueryClientProvider client={qc}>
      <CoreContext.Provider value={value}>
        <CoreEventBridge client={client} onStatus={setSseStatus} />
        {children}
      </CoreContext.Provider>
    </QueryClientProvider>
  );
}

function CoreEventBridge({ client, onStatus }: { client: CoreClient; onStatus: (s: SseStatus) => void }) {
  useCoreEvents(client, onStatus);
  return null;
}

/** Subscribes to the daemon's SSE stream and routes events into react-query and the stores. */
export function useCoreEvents(client: CoreClient, onStatus?: (s: SseStatus) => void): void {
  const qc = useQueryClient();
  useEffect(() => {
    const sub = client.subscribe(
      EVENT_TOPICS,
      (event) => handleCoreEvent(event, { qc, client }),
      (status) => onStatus?.(status),
    );
    return () => sub.close();
  }, [client, qc, onStatus]);
}

interface HandlerCtx {
  qc: QueryClient;
  client: CoreClient;
}

export function messagesKey(threadId: string) {
  return ["messages", threadId] as const;
}

function patchMessages(qc: QueryClient, threadId: string, fn: (msgs: Message[]) => Message[]) {
  qc.setQueryData<Message[]>(messagesKey(threadId), (old) => fn(old ?? []));
}

function ensureMessage(msgs: Message[], messageId: string, threadId: string, runId: string): Message[] {
  if (msgs.some((m) => m.id === messageId)) return msgs;
  return [
    ...msgs,
    { id: messageId, threadId, role: "assistant", contentMd: "", parts: [], runId, createdAt: new Date().toISOString() },
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
      runs.startRun({ runId: event.runId, threadId: event.threadId, agentId: event.agentId, startedAt: event.ts });
      break;
    case "agent.delta": {
      const threadId = runs.threadByRun[event.runId];
      if (!threadId) break;
      patchMessages(qc, threadId, (msgs) =>
        updateMessage(ensureMessage(msgs, event.messageId, threadId, event.runId), event.messageId, (m) =>
          appendDelta(m, event.part, event.delta),
        ),
      );
      break;
    }
    case "agent.tool_use": {
      const threadId = runs.threadByRun[event.runId];
      if (!threadId) break;
      patchMessages(qc, threadId, (msgs) =>
        updateMessage(ensureMessage(msgs, event.messageId, threadId, event.runId), event.messageId, (m) =>
          appendPart(m, { type: "tool_use", id: event.id, name: event.name, input: event.input }),
        ),
      );
      break;
    }
    case "agent.tool_result": {
      const threadId = runs.threadByRun[event.runId];
      if (!threadId) break;
      patchMessages(qc, threadId, (msgs) =>
        updateMessage(ensureMessage(msgs, event.messageId, threadId, event.runId), event.messageId, (m) =>
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
      useCinemaStore.getState().ingest(event.meta as RouteFrameLine);
      break;
    case "route.static":
      useCinemaStore.getState().ingest(event.static as RouteFrameLine);
      break;
    case "route.frame":
      useCinemaStore.getState().ingest(event.frame as RouteFrameLine);
      break;
    case "route.done":
      useCinemaStore.getState().setDone(event.result);
      break;
    case "project.changed":
      void qc.invalidateQueries({ queryKey: ["project", event.projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      for (const p of event.paths) void qc.invalidateQueries({ queryKey: ["file", event.projectId, p] });
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
  void useUiStore;
}
