import type { AgentId } from "@fabdesk/protocol";
import { useCallback } from "react";
import { Badge } from "../components/ui";
import { useMessages, useThread, useThreadMutations } from "../hooks/queries";
import { useRunsStore } from "../stores/runs";
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

  const onCreateThread = useCallback(
    async (input: { title: string; agentId: AgentId; model?: string }) => {
      const t = await create.mutateAsync({
        projectId,
        title: input.title,
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
      <div className="flex h-10 items-center gap-2 border-b border-border px-4">
        <div className="truncate text-sm font-medium">{thread?.title ?? "New chat"}</div>
        {thread && (
          <Badge tone="neutral" title={`Agent: ${thread.agentId}${thread.model ? ` / ${thread.model}` : ""}`}>
            {thread.agentId}
            {thread.model ? ` / ${thread.model}` : ""}
          </Badge>
        )}
        {thread?.pinned && <Badge tone="accent">pinned</Badge>}
        {run && (
          <Badge
            tone="success"
            title={run.usage ? `${run.usage.inputTokens ?? 0} in / ${run.usage.outputTokens ?? 0} out` : "running"}
          >
            running
          </Badge>
        )}
        {run?.usage?.costUsd !== undefined && <span className="text-xs text-muted">${run.usage.costUsd.toFixed(3)}</span>}
      </div>
      {activeThreadId ? (
        <MessageList thread={thread} messages={messages.data ?? []} loading={messages.isLoading} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="text-xl font-semibold">What board are we building?</div>
          <div className="max-w-md text-sm text-muted">
            Describe the circuit, attach a sketch, and the agent will write the tscircuit source, route it, run DRC
            and render it. Watch the board panel as it works.
          </div>
        </div>
      )}
      <Composer thread={thread} onCreateThread={onCreateThread} />
    </div>
  );
}
