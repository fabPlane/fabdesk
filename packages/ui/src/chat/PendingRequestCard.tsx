/**
 * Supervised runtime mode, desktop side: the card for a tool call waiting on a person and for a
 * question the agent asked. Deliberately small — the phone is the primary surface; this is enough
 * to approve from the desk and to see what was decided after a reload.
 */
import type { ApprovalPart, QuestionPart } from "@fabdesk/protocol";
import { useCoreClient } from "@fabdesk/client-core";
import { useId, useRef, useState } from "react";
import { Button, Spinner, Textarea } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { cn } from "../util";

function stringifyInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function PendingApprovalCard({ threadId, part }: { threadId: string; part: ApprovalPart }) {
  const client = useCoreClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = part.decision === "pending";
  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    setError(null);
    try {
      await client.request(
        `/threads/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(part.requestId)}`,
        { method: "POST", json: { decision } },
      );
    } catch (e) {
      // A 409 means someone else (the phone, the timeout) got there first; the event patches the card.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div
      className={cn(
        "my-1.5 rounded-lg border text-xs",
        pending
          ? "border-warning/60 bg-warning/5"
          : part.decision === "approve"
            ? "border-border bg-panel-2/40"
            : "border-danger/40 bg-panel-2/40",
      )}
      data-testid="approval-card"
    >
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className={cn("inline-block text-muted transition-transform", open && "rotate-90")}>
            &#9656;
          </span>
          {pending && <Spinner className="h-3 w-3" />}
          <span className="truncate font-mono">{part.summary}</span>
        </button>
        {pending ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void decide("deny")}
            >
              {busy === "deny" ? "…" : "Deny"}
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void decide("approve")}>
              {busy === "approve" ? "…" : "Approve"}
            </Button>
          </span>
        ) : (
          <span
            className={cn("shrink-0", part.decision === "approve" ? "text-success" : "text-danger")}
          >
            {part.decision === "approve" ? "approved" : "denied"}
          </span>
        )}
      </div>
      {error && <div className="px-2.5 pb-1.5 text-danger">{error}</div>}
      {open && (
        <div className="border-t border-border px-2.5 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">{part.tool}</div>
          <pre className="max-h-60 overflow-auto rounded bg-panel p-2 font-mono">
            {stringifyInput(part.input)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function PendingQuestionCard({ threadId, part }: { threadId: string; part: QuestionPart }) {
  const client = useCoreClient();
  const id = useId();
  const options = part.options ?? [];
  const [selected, setSelected] = useState<number | "custom" | null>(
    options.length ? null : "custom",
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sending = useRef(false);
  const resolvedAnswer = part.answer ?? submitted;
  const pending = resolvedAnswer === null;
  const value =
    selected === "custom"
      ? text.trim()
      : typeof selected === "number"
        ? (options[selected] ?? "")
        : "";
  const answer = async (value: string) => {
    if (!value.trim() || sending.current || !pending) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.request(
        `/threads/${encodeURIComponent(threadId)}/inputs/${encodeURIComponent(part.requestId)}`,
        { method: "POST", json: { answer: value } },
      );
      setSubmitted(value);
    } catch (e) {
      setError(e);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className={cn(
        "my-3 rounded-xl border p-4 text-sm",
        pending ? "border-accent/60 bg-accent/5" : "border-border bg-panel-2/40",
      )}
      data-testid="question-card"
      data-pending-question={pending ? part.requestId : undefined}
    >
      <div className="mb-2 text-xs text-muted" role="status">
        {pending
          ? "Waiting for your answer"
          : resolvedAnswer
            ? "Answer submitted"
            : "Question closed without an answer"}
      </div>
      {pending ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void answer(value);
          }}
        >
          <fieldset disabled={busy} className="min-w-0 space-y-2">
            <legend className="mb-3 whitespace-pre-wrap font-medium">{part.question}</legend>
            {options.map((option, index) => (
              <label
                key={index}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                  selected === index
                    ? "border-accent bg-accent/10"
                    : "border-border hover:bg-panel-2/60",
                )}
              >
                <input
                  type="radio"
                  name={id}
                  checked={selected === index}
                  onChange={() => setSelected(index)}
                  className="mt-1 shrink-0 accent-primary"
                />
                <span className="min-w-0 whitespace-pre-wrap break-words">{option}</span>
              </label>
            ))}
            {options.length > 0 && (
              <label
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg border p-3",
                  selected === "custom"
                    ? "border-accent bg-accent/10"
                    : "border-border hover:bg-panel-2/60",
                )}
              >
                <input
                  type="radio"
                  name={id}
                  checked={selected === "custom"}
                  onChange={() => setSelected("custom")}
                  className="accent-primary"
                />
                <span>Write my own answer</span>
              </label>
            )}
            {selected === "custom" && (
              <div>
                <label htmlFor={`${id}-answer`} className="mb-1 block text-xs text-muted">
                  Your answer
                </label>
                <Textarea
                  id={`${id}-answer`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Tell me what you prefer…"
                  rows={3}
                  className="w-full text-sm"
                />
              </div>
            )}
          </fieldset>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-muted">
              {options.length
                ? "Choose one or write your own answer."
                : "Submit your answer to continue."}
            </span>
            <Button size="sm" variant="primary" type="submit" disabled={busy || !value}>
              {busy ? "Submitting…" : "Submit answer"}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <div className="font-medium whitespace-pre-wrap">{part.question}</div>
          <div className="mt-2 whitespace-pre-wrap break-words text-muted">
            {resolvedAnswer || "No answer was sent. Ask again in the chat to continue."}
          </div>
        </div>
      )}
      {error !== null && pending && <ErrorNotice error={error} />}
    </div>
  );
}
