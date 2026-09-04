import { Button, Spinner } from "../components/ui";
import type { CoreStatusInfo } from "./types";

/** Shown while the core daemon is starting, restarting or has crashed (no client available yet). */
export function CoreStatusScreen({
  status,
  onRestart,
  onOpenLogs,
}: {
  status: CoreStatusInfo | null;
  onRestart?: (() => void) | undefined;
  onOpenLogs?: (() => void) | undefined;
}) {
  const state = status?.state ?? "starting";
  const crashed = state === "crashed" || state === "stopped";
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-6 text-center shadow-xl">
        <div className="mb-2 text-lg font-semibold">fabPlane</div>
        {crashed ? (
          <>
            <div className="text-sm text-danger">Core daemon {state === "stopped" ? "stopped" : "is unavailable"}</div>
            {status?.message && <div className="mt-2 break-words font-mono text-[11px] text-muted">{status.message}</div>}
            <div className="mt-4 flex justify-center gap-2">
              {onRestart && (
                <Button variant="primary" onClick={onRestart}>
                  Restart core
                </Button>
              )}
              {onOpenLogs && <Button onClick={onOpenLogs}>Open logs</Button>}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-center gap-2 text-sm">
              <Spinner /> {state === "restarting" ? `Restarting core (attempt ${status?.attempt ?? 1})...` : "Starting core daemon..."}
            </div>
            {status?.message && <div className="mt-2 text-xs text-muted">{status.message}</div>}
          </>
        )}
      </div>
    </div>
  );
}
