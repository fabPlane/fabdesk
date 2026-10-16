import { useEffect, useState } from "react";
import type { LiveRun } from "@fabdesk/client-core";

/** Only this small status line ticks; the message tree and header do not. */
export function RunActivity({ run, waiting = false }: { run: LiveRun; waiting?: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.runId, run.startedAt]);
  const seconds = Math.max(0, Math.floor((now - run.startedAt) / 1000));
  const elapsed = seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
  const usage = run.usage ? (run.usage.inputTokens ?? 0) + " input tokens / " + (run.usage.outputTokens ?? 0) + " output tokens" : undefined;
  return <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="run-activity" title={usage}>
    <span>{waiting ? "Waiting" : "Working"} for {elapsed}</span>
    {run.usage?.costUsd !== undefined && <span>· {"$" + run.usage.costUsd.toFixed(3)}</span>}
  </div>;
}
