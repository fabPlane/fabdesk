import type { Message, MessagePart, Thread } from "@fabdesk/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useCoreClient } from "@fabdesk/client-core";
import { useRunsStore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";
import { Markdown } from "./Markdown";
import { ProjectImage } from "./ProjectImage";
import { RunActivity } from "./RunActivity";
import { ThinkingBlock } from "./ThinkingBlock";
import { PendingApprovalCard, PendingQuestionCard } from "./PendingRequestCard";
import { extractImages, isCommandTool, isImageTool, ToolCallCard } from "./ToolCallCard";

type ToolResult = Extract<MessagePart, { type: "tool_result" }>;
type ToolUse = Extract<MessagePart, { type: "tool_use" }>;

/**
 * A run of consecutive tool calls, folded into one row under the paragraph that preceded it.
 * Collapsed by default: activity, count, and errors; the arrow expands compact tool rows.
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
  const detailsId = useId();
  const projectId = useUiStore((s) => s.activeProjectId);
  const history = calls.filter((c) => !isImageTool(c.use.name) && (!!c.result || !streaming));
  const errors = history.filter((c) => c.result?.isError === true).length;
  const pending = history.filter((c) => !c.result);
  const visibleCalls = open ? calls : calls.filter((c) => (streaming && !c.result) || isImageTool(c.use.name));
  const images = calls.filter((c) => !visibleCalls.includes(c)).flatMap((c) => (c.result ? extractImages(c.result.output) : []));
  const commandsOnly = history.every((call) => isCommandTool(call.use.name));
  const label = pending.length > 0 ? (commandsOnly ? "Commands" : "Tool activity") : commandsOnly ? "Ran commands" : "Used tools";
  return (
    <div className="fd-tool-group my-2 min-w-0 text-[13px]" data-testid="tool-group">
      {history.length > 0 && <button type="button" className="flex min-h-8 max-w-full items-center gap-2 rounded-md py-1.5 text-left text-muted hover:text-fg"
        onClick={() => setOpen((o) => !o)} title={open ? "Hide tool calls" : "Show tool calls"} aria-expanded={open} aria-controls={visibleCalls.length > 0 ? detailsId : undefined}>
        <Icon name={commandsOnly ? "terminal" : "tool"} width={16} height={16} className="shrink-0" />
        <span>{label}</span><span className="text-xs tabular-nums">{history.length}</span>
        {errors > 0 && <span className="text-xs text-danger">{errors} error{errors === 1 ? "" : "s"}</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} width={12} height={12} className="shrink-0" />
      </button>}
      {!open && images.length > 0 && (
        <div className="flex flex-wrap gap-2 py-2">
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
      {visibleCalls.length > 0 && (
        <div id={detailsId} className="min-w-0">
          {visibleCalls.map((c, i) => (
            <ToolCallCard key={c.use.id || i} use={c.use} result={c.result} streaming={streaming} />
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
  const executing = streaming && !m.parts.some((p) => (p.type === "approval" && p.decision === "pending") || (p.type === "question" && p.answer === null));
  const results = new Map<string, ToolResult>();
  for (const p of m.parts) if (p.type === "tool_result") results.set(p.id, p);
  const consumed = new Set<string>();
  const out: ReactNode[] = [];
  // Consecutive tool calls (results interleaved) fold into one collapsed group.
  let group: Array<{ use: ToolUse; result?: ToolResult | undefined }> = [];
  let groupKey = 0;
  const flush = () => {
    if (group.length === 0) return;
    out.push(<ToolGroup key={`g${groupKey}`} calls={group} streaming={executing} />);
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

export function MessageActions({ message, latestReply = false }: { message: Message; latestReply?: boolean }) {
  const [feedback, setFeedback] = useState<"" | "copied" | "error">("");
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(""), 2500);
    return () => clearTimeout(timer);
  }, [feedback]);
  // Copy the reply, not hidden reasoning, tool payloads, or attachment paths.
  const text = message.role === "assistant" && message.parts.length > 0
    ? message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n")
    : message.contentMd;
  const fullTime = new Date(message.createdAt).toLocaleString();
  return (
    <div className="fd-message-actions" data-role={message.role} data-latest-reply={latestReply || undefined}>
      {text.trim() && <button
        type="button"
        className="fd-message-copy"
        aria-label={feedback === "copied" ? "Message copied" : "Copy message"}
        title={feedback === "copied" ? "Copied" : "Copy message"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setFeedback("copied");
          } catch {
            setFeedback("error");
          }
        }}
      ><Icon name={feedback === "copied" ? "check" : "copy"} width={16} height={16} /></button>}
      <time tabIndex={0} dateTime={message.createdAt} title={fullTime} aria-label={fullTime} className="fd-message-time">
        {new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
      <span role="status" className={feedback === "error" ? "text-xs text-danger" : "sr-only"}>
        {feedback === "copied" ? "Message copied" : feedback === "error" ? "Could not copy. Try again or select the text." : ""}
      </span>
    </div>
  );
}

export function MessageBubble({ message, streaming, latestReply = false }: { message: Message; streaming: boolean; latestReply?: boolean }) {
  const isUser = message.role === "user";
  const waitingApproval = message.parts.some((p) => p.type === "approval" && p.decision === "pending");
  const waitingAnswer = message.parts.some((p) => p.type === "question" && p.answer === null);
  const hasPendingTool = message.parts.some((p) => p.type === "tool_use" && !message.parts.some((r) => r.type === "tool_result" && r.id === p.id));
  const thinking = message.parts.at(-1)?.type === "thinking";
  if (message.role === "system") {
    return (
      <div className="fd-message mx-auto my-3 flex max-w-xl flex-col items-center text-center text-xs text-muted">
        {message.contentMd}
        <MessageActions message={message} />
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
    <div className={cn("fd-message flex w-full flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "relative min-w-0 text-sm [overflow-wrap:anywhere]",
          isUser
            ? "fd-user-message max-w-[90%] rounded-2xl rounded-br-md border border-border/60 bg-panel-2/60 px-3 py-2 leading-[1.5]"
            : "w-full max-w-full leading-[1.75]",
        )}
      >
        {!isUser && <div className="mb-3 flex items-center gap-2 text-[11px] font-medium text-muted"><span className="h-1.5 w-1.5 rounded-full bg-accent" />Agent</div>}
        {isUser ? (
          <>
            {message.contentMd && <div className="whitespace-pre-wrap">{message.contentMd}</div>}
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
        {!isUser && streaming && (waitingApproval || waitingAnswer || (!hasPendingTool && !thinking)) && (
          <div className="mt-2 text-[13px] text-muted" role="status">
            <span className={cn(!waitingApproval && !waitingAnswer && "fd-activity-shimmer")}>
              {waitingApproval ? "Waiting for approval" : waitingAnswer ? "Waiting for your answer" : "Working…"}
            </span>
          </div>
        )}
      </div>
      <MessageActions message={message} latestReply={latestReply} />
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
  const focusMessageId = useUiStore((s) => s.focusMessageId);
  const setFocusMessageId = useUiStore((s) => s.setFocusMessageId);
  useEffect(() => {
    if (!focusMessageId || !messages.some((message) => message.id === focusMessageId)) return;
    const target = [...(ref.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])].find((element) => element.dataset.messageId === focusMessageId);
    if (!target) return;
    stick.current = false;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("fd-search-highlight");
    const timer = setTimeout(() => {
      target.classList.remove("fd-search-highlight");
      setFocusMessageId(null);
    }, 2500);
    return () => { clearTimeout(timer); target.classList.remove("fd-search-highlight"); };
  }, [focusMessageId, messages, setFocusMessageId]);
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
  const lastId = messages.findLast((message) => message.role === "assistant")?.id;
  const visibleMessages = messages.filter((message) => message.status !== "queued");
  const activeMessages = run ? visibleMessages.filter((m) => m.role === "assistant" && m.runId === run.runId) : [];
  const firstActiveId = activeMessages[0]?.id;
  const waiting = activeMessages.some((m) => m.parts.some((p) => (p.type === "approval" && p.decision === "pending") || (p.type === "question" && p.answer === null)));
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        {thread && <BranchHeader thread={thread} />}
        {loading && messages.length === 0 && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}
        {visibleMessages.map((m, index, visible) => {
          const day = new Date(m.createdAt).toDateString();
          const previousDay = visible[index - 1] ? new Date(visible[index - 1]!.createdAt).toDateString() : null;
          return <div key={m.id} data-message-id={m.id} className="scroll-mt-8 rounded-xl">
            {day !== previousDay && <div className="my-3 flex items-center gap-3 text-[11px] text-muted"><span className="h-px flex-1 bg-border" /><time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleDateString([], { dateStyle: "medium" })}</time><span className="h-px flex-1 bg-border" /></div>}
            {run && m.id === firstActiveId && <RunActivity key={run.runId} run={run} waiting={waiting} />}
            <MessageBubble message={m} latestReply={m.role === "assistant" && m.id === lastId} streaming={!!run && m.runId === run.runId && m.role === "assistant"} />
          </div>;
        })}
        {run && !firstActiveId && <div><RunActivity key={run.runId} run={run} /><div className="text-[13px] text-muted" role="status"><span className="fd-activity-shimmer">Working…</span></div></div>}
        {run?.error && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {run.error}
          </div>
        )}
      </div>
    </div>
  );
}
