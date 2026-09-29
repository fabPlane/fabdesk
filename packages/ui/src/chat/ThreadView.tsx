import type { AgentId } from "@fabdesk/protocol";
import { useCallback, useEffect, useState } from "react";

/** Seconds since `startedAt`, ticking once a second while a run is active (undefined otherwise). */
function useElapsedSeconds(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt === undefined ? undefined : Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
import { Badge } from "../components/ui";
import { useCoreClient, useMessages, useThread, useThreadMutations } from "@fabdesk/client-core";
import { useRunsStore } from "@fabdesk/client-core";
import { useQueryClient } from "@tanstack/react-query";
import { useUiStore } from "../stores/ui";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function ThreadView() {
  const activeThreadId = useUiStore((s) => s.activeThreadId);
  const projectId = useUiStore((s) => s.activeProjectId);
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const threadQuery = useThread(activeThreadId);
  const thread = threadQuery.data ?? null;
  const messages = useMessages(activeThreadId);
  const { create } = useThreadMutations();
  const run = useRunsStore((s) => (activeThreadId ? s.runsByThread[activeThreadId] : undefined));
  const elapsed = useElapsedSeconds(run?.startedAt);
  const client = useCoreClient();
  const qc = useQueryClient();
  const [modeError, setModeError] = useState<string | null>(null);
  // Runtime mode toggle: `supervised` pauses writes for approval (cards in the timeline, or the
  // phone). Takes effect on the next run. A 400 here means the agent cannot pause — say so.
  const toggleMode = useCallback(async () => {
    if (!thread) return;
    const runtimeMode = thread.runtimeMode === "supervised" ? "full" : "supervised";
    setModeError(null);
    try {
      await client.request(`/threads/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        json: { runtimeMode },
      });
      void qc.invalidateQueries({ queryKey: ["thread", thread.id] });
      void qc.invalidateQueries({ queryKey: ["threads"] });
    } catch (e) {
      setModeError(e instanceof Error ? e.message : String(e));
    }
  }, [client, qc, thread]);

  const onCreateThread = useCallback(
    async (input: { agentId: AgentId; model?: string }) => {
      const t = await create.mutateAsync({
        projectId,
        agentId: input.agentId,
        ...(input.model ? { model: input.model } : {}),
      });
      setActiveThread(t.id);
      return t.id;
    },
    [create, projectId, setActiveThread],
  );

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex min-h-12 items-center gap-2 overflow-hidden border-b border-border px-5">
        <div className="min-w-0 max-w-[45%] truncate text-[13px] font-semibold tracking-[-0.01em]" title={thread?.title ?? "New chat"}>{thread?.title ?? "New chat"}</div>
        {thread && (
          <Badge className="max-w-36 overflow-hidden"
            tone="neutral"
            title={`Agent: ${thread.agentId}${thread.model ? ` / ${thread.model}` : ""}`}
          >
            <span className="truncate">{thread.agentId}{thread.model ? ` / ${thread.model}` : ""}</span>
          </Badge>
        )}
        {thread?.pinned && <Badge tone="accent">pinned</Badge>}
        {thread && (
          <button
            type="button"
            onClick={() => void toggleMode()}
            title={
              modeError ??
              (thread.runtimeMode === "supervised"
                ? "Supervised: writes wait for your approval. Click for full mode."
                : "Full: the agent runs unattended. Click to supervise writes.")
            }
            data-testid="runtime-mode-toggle"
          >
            <Badge
              tone={
                modeError ? "danger" : thread.runtimeMode === "supervised" ? "warning" : "neutral"
              }
            >
              {modeError ? "cannot supervise" : (thread.runtimeMode ?? "full")}
            </Badge>
          </button>
        )}
        {run && (
          <Badge className="ml-auto"
            tone="success"
            title={
              run.usage
                ? `${run.usage.inputTokens ?? 0} in / ${run.usage.outputTokens ?? 0} out`
                : "running"
            }
          >
            running{elapsed !== undefined ? ` · ${formatElapsed(elapsed)}` : ""}
          </Badge>
        )}
        {run?.usage?.costUsd !== undefined && (
          <span className="text-xs text-muted">${run.usage.costUsd.toFixed(3)}</span>
        )}
      </div>
      {activeThreadId ? (
        <MessageList thread={thread} messages={messages.data ?? []} loading={messages.isLoading} />
      ) : (
        <div className="fd-empty-hero flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-8 pb-12 text-center">
          <svg className="fd-hero-icon mb-3 shrink-0 text-accent" width="52" height="52" viewBox="0 0 52 52" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="8" y="8" width="36" height="36" rx="7" />
            <path d="M8 20h10l7 7h10M44 18h-8l-6 6M18 44v-9l7-8" />
            <circle cx="18" cy="20" r="2" fill="currentColor" /><circle cx="35" cy="27" r="2" fill="currentColor" /><circle cx="30" cy="24" r="2" fill="currentColor" />
          </svg>
          <div className="fd-eyebrow">Your PCB workspace</div>
          <h1 className="text-[22px] font-semibold tracking-[-0.035em]">What board are we building?</h1>
          <div className="max-w-md text-[13px] leading-6 text-muted">
            Describe the circuit or attach a sketch. The agent can create the native schematic and
            PCB, route and verify the board, then prepare manufacturing outputs. Watch the board
            panel as it works.
          </div>
        </div>
      )}
      <Composer thread={thread} onCreateThread={onCreateThread} />
    </div>
  );
}
