import type { AgentId } from "@fabdesk/protocol";
import { useCallback, useEffect, useState } from "react";
import { CircuitLogo } from "../components/CircuitLogo";

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
  useEffect(() => {
    if (thread && thread.id === useUiStore.getState().activeThreadId) {
      useUiStore.setState({ activeProjectId: thread.projectId ?? null });
    }
  }, [thread]);
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
    <div className="fd-chat-pane flex h-full min-w-0 flex-col bg-bg">
      <div className="fd-thread-header relative flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-border py-2 pl-5 pr-[52px]">
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
            aria-pressed={thread.runtimeMode === "supervised"}
            className="min-h-8 rounded-md border border-border px-2 text-xs text-muted hover:bg-panel-2"
          >
            <span className={modeError ? "text-danger" : thread.runtimeMode === "supervised" ? "text-warning" : "text-fg"}>
              {modeError ? "Cannot change mode" : thread.runtimeMode === "supervised" ? "Approval required" : "Unsupervised"}
            </span>
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
      <div className={activeThreadId ? "fd-thread-body" : "fd-thread-body fd-new-chat-body"}>
      {activeThreadId ? (
        <MessageList thread={thread} messages={messages.data ?? []} loading={messages.isLoading} />
      ) : (
        <div className="fd-empty-hero">
          <CircuitLogo className="fd-hero-icon mb-3 shrink-0 text-accent" />
          <div className="fd-eyebrow">Your PCB workspace</div>
          <h1>What board are we building?</h1>
          <div className="fd-hero-description">
            Describe your circuit or attach a sketch. Build, route, and verify your board with an agent, then prepare it for manufacturing.
          </div>
        </div>
      )}
      <Composer thread={thread} onCreateThread={onCreateThread} />
      </div>
    </div>
  );
}
