import type { AgentId } from "@fabdesk/protocol";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
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
import { useMessages, useThread, useThreadMutations } from "@fabdesk/client-core";
import { useRunsStore } from "@fabdesk/client-core";
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
      <div className="fd-thread-header relative flex min-h-16 shrink-0 flex-wrap items-center gap-2 py-2 pl-5 pr-[52px]">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Icon name="folder" width={18} height={18} className="shrink-0 text-fg" />
          <div className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em]" title={thread?.title ?? "New chat"}>{thread?.title ?? "New chat"}</div>
        </div>
        {thread?.pinned && <Badge tone="accent">pinned</Badge>}
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
