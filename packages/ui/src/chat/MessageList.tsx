import type { Message, MessagePart, Thread } from "@fabdesk/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Spinner } from "../components/ui";
import { useCoreClient } from "@fabdesk/client-core";
import { useRunsStore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn, formatRelative } from "../util";
import { Markdown } from "./Markdown";
import { ProjectImage } from "./ProjectImage";
import { ThinkingBlock } from "./ThinkingBlock";
import { PendingApprovalCard, PendingQuestionCard } from "./PendingRequestCard";
import { extractImages, ToolCallCard } from "./ToolCallCard";

type ToolResult = Extract<MessagePart, { type: "tool_result" }>;
type ToolUse = Extract<MessagePart, { type: "tool_use" }>;

function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "");
}

/**
 * A run of consecutive tool calls, folded into one row under the paragraph that preceded it.
 * Collapsed by default: count, errors, and the tool still running; the arrow expands the cards.
 * Image results (board renders) stay visible even when collapsed.
 */
export function ToolGroup({
  calls,
  streaming,
}: {
  calls: Array<{ use: ToolUse; result?: ToolResult | undefined }>;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const projectId = useUiStore((s) => s.activeProjectId);
  const errors = calls.filter((c) => c.result?.isError === true).length;
  const pending = calls.filter((c) => !c.result);
  const running = streaming && pending.length > 0 ? pending[pending.length - 1] : undefined;
  const images = calls.flatMap((c) => (c.result ? extractImages(c.result.output) : []));
  const label = `${calls.length} tool call${calls.length === 1 ? "" : "s"}`;
  return (
    <div className="my-1 text-xs" data-testid="tool-group">
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-muted hover:bg-panel-2/60",
          open && "text-fg",
        )}
        onClick={() => setOpen((o) => !o)}
        title={open ? "Hide tool calls" : "Show tool calls"}
        aria-expanded={open}
      >
        <span className={cn("inline-block transition-transform", open && "rotate-90")}>
          &#9656;
        </span>
        <span>{label}</span>
        {errors > 0 && (
          <span className="text-danger">
            {errors} error{errors === 1 ? "" : "s"}
          </span>
        )}
        {running && (
          <span className="flex items-center gap-1.5 font-mono">
            <Spinner className="h-3 w-3" />
            {shortToolName(running.use.name)}
          </span>
        )}
        {!running && !open && calls.length > 0 && (
          <span className="truncate font-mono opacity-70">
            {calls
              .map((c) => shortToolName(c.use.name))
              .slice(-3)
              .join(" · ")}
          </span>
        )}
      </button>
      {!open && images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pt-1">
          {images.map((img, i) =>
            img.kind === "data" ? (
              <img
                key={i}
                src={img.src}
                alt="tool result"
                className="max-h-72 rounded border border-border"
              />
            ) : (
              <ProjectImage key={i} projectId={projectId} path={img.src} />
            ),
          )}
        </div>
      )}
      {open && (
        <div className="pl-1">
          {calls.map((c, i) => (
            <ToolCallCard key={c.use.id || i} use={c.use} result={c.result} />
          ))}
        </div>
      )}
    </div>
  );
}

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
  // Consecutive tool calls (results interleaved) fold into one collapsed group.
  let group: Array<{ use: ToolUse; result?: ToolResult | undefined }> = [];
  let groupKey = 0;
  const flush = () => {
    if (group.length === 0) return;
    out.push(<ToolGroup key={`g${groupKey}`} calls={group} streaming={streaming} />);
    group = [];
  };
  m.parts.forEach((p, i) => {
    const last = i === m.parts.length - 1;
    if (p.type !== "tool_use" && p.type !== "tool_result") {
      flush();
      groupKey = i;
    }
    switch (p.type) {
      case "text":
        out.push(
          <Markdown key={i} text={p.text} className={cn(streaming && last && "fd-caret")} />,
        );
        break;
      case "thinking":
        out.push(<ThinkingBlock key={i} text={p.text} streaming={streaming && last} />);
        break;
      case "tool_use": {
        const r = results.get(p.id);
        if (r) consumed.add(p.id);
        if (group.length === 0) groupKey = i;
        group.push({ use: p, result: r });
        break;
      }
      case "tool_result":
        if (!consumed.has(p.id)) {
          out.push(
            <pre
              key={i}
              className="my-1 max-h-60 overflow-auto rounded bg-panel-2 p-2 font-mono text-xs"
            >
              {typeof p.output === "string" ? p.output : JSON.stringify(p.output, null, 2)}
            </pre>,
          );
        }
        break;
      case "image":
        out.push(<ImagePart key={i} path={p.path} />);
        break;
      case "approval":
        out.push(<PendingApprovalCard key={p.requestId} threadId={m.threadId} part={p} />);
        break;
      case "question":
        out.push(<PendingQuestionCard key={p.requestId} threadId={m.threadId} part={p} />);
        break;
      default:
        break;
    }
  });
  flush();
  return out;
}

export function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  const isUser = message.role === "user";
  if (message.role === "system") {
    return (
      <div className="mx-auto my-2 max-w-xl text-center text-xs text-muted">
        {message.contentMd}
      </div>
    );
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
          isUser
            ? "whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent/15 px-3.5 py-2"
            : "w-full",
        )}
      >
        {isUser ? (
          <>
            {message.contentMd}
            {/* A photo attached on the phone arrives as an image part next to the text. */}
            {message.parts
              .filter((p) => p.type === "image")
              .map((p, i) => (
                <ImagePart key={i} path={(p as { path: string }).path} />
              ))}
          </>
        ) : (
          body
        )}
        {message.status === "queued" && (
          <div className="mt-1 text-right text-[10px] uppercase tracking-wide text-muted">
            Queued · sends when the run ends
          </div>
        )}
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
    queryFn: async () =>
      (await client.listThreads()).find((t) => t.id === thread.parentThreadId) ?? null,
    enabled: !!thread.parentThreadId,
  });
  if (!thread.parentThreadId) return null;
  return (
    <div className="mx-auto mb-3 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-muted">
      <span>&#8916; Branched from</span>
      <button
        className="font-medium text-fg hover:underline"
        onClick={() => setActiveThread(thread.parentThreadId)}
      >
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
          <MessageBubble
            key={m.id}
            message={m}
            streaming={!!run && m.id === lastId && m.role === "assistant"}
          />
        ))}
        {run && (messages.length === 0 || lastRole === "user") && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner /> {run.agentId} is working...
          </div>
        )}
        {run?.error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {run.error}
          </div>
        )}
      </div>
    </div>
  );
}
