/**
 * Supervised runtime mode, desktop side: the card for a tool call waiting on a person and for a
 * question the agent asked. Deliberately small — the phone is the primary surface; this is enough
 * to approve from the desk and to see what was decided after a reload.
 */
import type { ApprovalPart, QuestionPart } from "@fabdesk/protocol";
import { useCoreClient } from "@fabdesk/client-core";
import { useState } from "react";
import { Button, Input, Spinner } from "../components/ui";
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
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = part.answer === null;
  const answer = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.request(
        `/threads/${encodeURIComponent(threadId)}/inputs/${encodeURIComponent(part.requestId)}`,
        { method: "POST", json: { answer: value } },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={cn(
        "my-1.5 rounded-lg border px-2.5 py-2 text-xs",
        pending ? "border-accent/60 bg-accent/5" : "border-border bg-panel-2/40",
      )}
      data-testid="question-card"
    >
      <div className="mb-1.5 flex items-center gap-2">
        {pending && <Spinner className="h-3 w-3" />}
        <span className="font-medium">{part.question}</span>
      </div>
      {pending ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {(part.options ?? []).map((o) => (
            <Button
              key={o}
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void answer(o)}
            >
              {o}
            </Button>
          ))}
          <form
            className="flex min-w-[12rem] flex-1 items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void answer(text);
            }}
          >
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={part.options?.length ? "Or type an answer" : "Type an answer"}
              disabled={busy}
              className="h-7 flex-1 text-xs"
            />
            <Button size="sm" type="submit" disabled={busy || !text.trim()}>
              Send
            </Button>
          </form>
        </div>
      ) : (
        <div className="text-muted">
          Answered: <span className="text-fg">{part.answer}</span>
        </div>
      )}
      {error && <div className="pt-1 text-danger">{error}</div>}
    </div>
  );
}
