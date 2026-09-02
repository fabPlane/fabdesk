import type { Message, MessagePart, Thread } from "@fabdesk/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { Spinner } from "../components/ui";
import { useCoreClient } from "../core/CoreProvider";
import { useRunsStore } from "../stores/runs";
import { useUiStore } from "../stores/ui";
import { cn, formatRelative } from "../util";
import { Markdown } from "./Markdown";
import { ProjectImage } from "./ProjectImage";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

type ToolResult = Extract<MessagePart, { type: "tool_result" }>;

function ImagePart({ path }: { path: string }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  return (
    <div className="my-1.5">
      <ProjectImage projectId={projectId} path={path} />
    </div>
  );
}

export function renderParts(m: Message, streaming: boolean): ReactNode[] {
  const results = new Map<string, ToolResult>();
  for (const p of m.parts) if (p.type === "tool_result") results.set(p.id, p);
  const consumed = new Set<string>();
  const out: ReactNode[] = [];
  m.parts.forEach((p, i) => {
    const last = i === m.parts.length - 1;
    switch (p.type) {
      case "text":
        out.push(<Markdown key={i} text={p.text} className={cn(streaming && last && "fd-caret")} />);
        break;
      case "thinking":
        out.push(<ThinkingBlock key={i} text={p.text} streaming={streaming && last} />);
        break;
      case "tool_use": {
        const r = results.get(p.id);
        if (r) consumed.add(p.id);
        out.push(<ToolCallCard key={i} use={p} result={r} />);
        break;
      }
      case "tool_result":
        if (!consumed.has(p.id)) {
          out.push(
            <pre key={i} className="my-1 max-h-60 overflow-auto rounded bg-panel-2 p-2 font-mono text-xs">
              {typeof p.output === "string" ? p.output : JSON.stringify(p.output, null, 2)}
            </pre>,
          );
        }
        break;
      case "image":
        out.push(<ImagePart key={i} path={p.path} />);
        break;
      default:
        break;
    }
  });
  return out;
}

export function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  const isUser = message.role === "user";
  if (message.role === "system") {
    return <div className="mx-auto my-2 max-w-xl text-center text-xs text-muted">{message.contentMd}</div>;
  }
  const body =
    message.parts.length > 0
      ? renderParts(message, streaming)
      : message.contentMd
        ? [<Markdown key="md" text={message.contentMd} className={cn(streaming && "fd-caret")} />]
        : [];
  return (
    <div className={cn("group flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative max-w-[85%] text-[13.5px]",
          isUser ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2" : "w-full",
        )}
      >
        {isUser ? message.contentMd : body}
        {!isUser && streaming && body.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner /> waiting for the agent...
          </div>
        )}
        <div
          className={cn(
            "mt-0.5 text-[10px] text-muted opacity-0 transition-opacity group-hover:opacity-100",
            isUser && "text-right",
          )}
        >
          {formatRelative(message.createdAt)}
        </div>
      </div>
    </div>
  );
}

export function BranchHeader({ thread }: { thread: Thread }) {
  const client = useCoreClient();
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  const parent = useQuery({
    queryKey: ["threads", "one", thread.parentThreadId],
    queryFn: async () => (await client.listThreads()).find((t) => t.id === thread.parentThreadId) ?? null,
    enabled: !!thread.parentThreadId,
  });
  if (!thread.parentThreadId) return null;
  return (
    <div className="mx-auto mb-3 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-muted">
      <span>&#8916; Branched from</span>
      <button className="font-medium text-fg hover:underline" onClick={() => setActiveThread(thread.parentThreadId)}>
        {parent.data?.title ?? "parent thread"}
      </button>
    </div>
  );
}

export function MessageList({
  thread,
  messages,
  loading,
}: {
  thread: Thread | null;
  messages: Message[];
  loading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const run = useRunsStore((s) => (thread ? s.runsByThread[thread.id] : undefined));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  const lastId = messages[messages.length - 1]?.id;
  const lastRole = messages[messages.length - 1]?.role;
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {thread && <BranchHeader thread={thread} />}
        {loading && messages.length === 0 && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} streaming={!!run && m.id === lastId && m.role === "assistant"} />
        ))}
        {run && (messages.length === 0 || lastRole === "user") && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner /> {run.agentId} is working...
          </div>
        )}
        {run?.error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{run.error}</div>
        )}
      </div>
    </div>
  );
}
