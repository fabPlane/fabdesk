import type { Run } from "@fabdesk/protocol";
import { useEffect, useState } from "react";
import { useCore, type LiveRun } from "@fabdesk/client-core";

/** Only this small status line ticks; the message tree and header do not. */
export function RunActivity({ run, waiting = false }: { run: LiveRun; waiting?: boolean }) {
  const { client } = useCore();
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
  const elapsed = seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
  const usage = run.usage ? (run.usage.inputTokens ?? 0) + " input tokens / " + (run.usage.outputTokens ?? 0) + " output tokens" : undefined;
  return <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3 text-xs text-muted" data-testid="run-activity" title={usage}>
    <span>{waiting ? "Waiting" : "Working"} for {elapsed}</span>
    {run.usage?.costUsd !== undefined && <span>· {"$" + run.usage.costUsd.toFixed(3)}</span>}
    <button type="button" className="rounded px-1 hover:text-fg focus-visible:text-fg" disabled={stopping} onClick={() => void stop()} aria-label="Stop current run; queued messages stay scheduled" title="Stop current run. Queued messages stay scheduled.">{stopping ? "Stopping…" : "Stop"}</button>
    {error && <span role="alert" className="text-danger">Could not stop. Try again.</span>}
  </div>;
}

/** Only persisted, finished timing is presented as completed work. */
export function WorkedActivity({ run }: { run: Run }) {
  if (run.status === "running" || !run.endedAt) return null;
  const elapsedMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  const seconds = Math.floor(elapsedMs / 1000);
  const duration = seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
  return <div className="mb-4 border-b border-border pb-3 text-xs text-muted" data-testid="worked-activity">
    Worked for {duration}{run.status === "failed" ? " · Failed" : run.status === "aborted" ? " · Stopped" : ""}
  </div>;
}
