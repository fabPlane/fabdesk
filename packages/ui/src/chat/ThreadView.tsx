import type { AgentId } from "@fabdesk/protocol";
import { useCallback, useEffect } from "react";
import { Icon } from "../components/Icon";
import { CircuitLogo } from "../components/CircuitLogo";
import { Badge, Button } from "../components/ui";
import { CoreHttpError, useMessages, useThread, useThreadMutations } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function ThreadView() {
  const activeThreadId = useUiStore((s) => s.activeThreadId);
  const projectId = useUiStore((s) => s.activeProjectId);
  const setSketchOpen = useUiStore((s) => s.setSketchOpen);
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
  const onCreateThread = useCallback(
    async (input: { agentId: AgentId; model?: string }) => {
      try {
        const t = await create.mutateAsync({
          projectId,
          agentId: input.agentId,
          ...(input.model ? { model: input.model } : {}),
        });
        setActiveThread(t.id);
        return t.id;
      } catch (error) {
        if (error instanceof CoreHttpError && error.code === "project_not_found") {
          const ui = useUiStore.getState();
          if (ui.activeProjectId === projectId && ui.activeThreadId === null) {
            ui.setActiveProject(null);
            ui.setProjectPickerOpen(true);
          }
        }
        // The composer keeps the draft and attachments on failure; never silently resend.
        throw error;
      }
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
      </div>
      <div className={activeThreadId ? "fd-thread-body" : "fd-thread-body fd-new-chat-body"}>
      {activeThreadId ? (
        <MessageList thread={thread} messages={messages.data ?? []} loading={messages.isLoading} />
      ) : (
        <div className="fd-empty-hero">
          <CircuitLogo className="fd-hero-icon mb-3 shrink-0 text-accent" />
          <div className="fd-eyebrow">Your PCB workspace</div>
          <h1>{projectId ? "What board are we building?" : "What would you like to make?"}</h1>
          <div className="fd-hero-description">
            Describe your circuit or attach a sketch. Build, route, and verify your board with an agent, then prepare it for manufacturing.
          </div>
          <div className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Start from a sketch">
            <Button onClick={() => setSketchOpen(true, "draw")}><Icon name="compose" width={16} height={16} />Draw a sketch</Button>
            <Button onClick={() => setSketchOpen(true, "upload")}><Icon name="paperclip" width={16} height={16} />Upload an image</Button>
          </div>
          {!projectId && <p className="mt-3 text-xs text-muted">Saving a sketch creates a project automatically.</p>}
        </div>
      )}
      <Composer thread={thread} onCreateThread={onCreateThread} />
      </div>
    </div>
  );
}
