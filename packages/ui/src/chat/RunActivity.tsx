import { Icon } from "../components/Icon";
import type { Run } from "@fabdesk/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { useCore, useMessages, summarizeRunWork, type LiveRun } from "@fabdesk/client-core";

/** Only this small status line ticks; the message tree and header do not. */
export function RunActivity({ run, waiting = false }: { run: LiveRun; waiting?: boolean }) {
  const { client } = useCore();
  const messages = useMessages(run.threadId);
  const work = summarizeRunWork(messages.data ?? [], run.startedAt);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setError(false); setStopping(false); }, [run.runId]);
  const stop = async () => {
    if (stopping) return;
    setStopping(true); setError(false);
    try { await client.abort(run.threadId); }
    catch { setError(true); }
    finally { setStopping(false); }
  };
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.runId, run.startedAt]);
  const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000));
  const elapsed = seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  const usage = run.usage ? (run.usage.inputTokens ?? 0) + " input tokens / " + (run.usage.outputTokens ?? 0) + " output tokens" : undefined;
  return <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3 text-xs text-muted" data-testid="run-activity" title={usage}>
    <span>{waiting ? "Waiting for your response" : work?.stage ?? "Working"} · {elapsed}</span>
    {work && <span className="basis-full" role="status">{work.completed}{work.attempts > 1 ? ` · ${work.attempts} consecutive attempts (history in details)` : ""}{work.state === "blocked" ? ` · ${work.next}` : ""}</span>}
    {run.usage?.costUsd !== undefined && <span>· {"$" + run.usage.costUsd.toFixed(3)}</span>}
    <button type="button" className="rounded px-1 hover:text-fg focus-visible:text-fg" disabled={stopping} onClick={() => void stop()} aria-label="Stop current run; queued messages stay scheduled" title="Stop current run. Queued messages stay scheduled.">{stopping ? "Stopping…" : "Stop"}</button>
    {error && <span role="alert" className="text-danger">Could not stop. Try again.</span>}
  </div>;
}

/** Older runs can still fold their history when persisted timing is unavailable. */
export function WorkedActivity({ run, children, hasError = false, unanswered = false }: { run?: Run | null; children?: ReactNode; hasError?: boolean; unanswered?: boolean }) {
  if (run?.status === "running") return null;
  const elapsedMs = run?.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : NaN;
  const seconds = Math.floor(elapsedMs / 1000);
  const duration = Number.isFinite(seconds) && seconds >= 0
    ? seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s"
    : null;
  const label = <><span>{duration ? "Worked for " + duration : "Worked"}{run?.status === "failed" ? " · Failed" : run?.status === "aborted" ? " · Stopped" : ""}</span>
    {hasError && <span role="img" aria-label="Activity contains an error" title="Expand to inspect the error" className="inline-flex text-danger"><Icon name="warning" width={15} height={15} /></span>}</>;
  if (!children) return <div className="mb-4 flex items-center gap-2 border-b border-border pb-3 text-xs text-muted" data-testid="worked-activity">{label}</div>;
  return <details open={run?.status === "failed" || run?.status === "aborted" || hasError || unanswered} className="fd-worked-history group mb-4 border-b border-border pb-3 text-xs text-muted" data-testid="worked-activity">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded py-1 hover:text-fg [&::-webkit-details-marker]:hidden">
      {label}<Icon name="chevronRight" width={13} height={13} className="transition-transform group-open:rotate-90" />
    </summary>
    <div className="mt-3 space-y-4 text-fg">{children}</div>
  </details>;
}
