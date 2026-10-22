import type { FinishItSession } from "@fabdesk/protocol";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { finishItActive, finishItDisplayedMilestoneStatus, finishItMilestoneTone, finishItSummary, FINISH_IT_STATUS_LABEL } from "./finish-it-view";

export interface FinishItPanelProps {
  session: FinishItSession;
  onStop: () => void;
  stopping?: boolean;
}

export function FinishItPanel({ session, onStop, stopping }: FinishItPanelProps) {
  const active = finishItActive(session);
  return (
    <div
      className="mb-2 rounded-xl border border-border bg-panel p-3"
      data-testid="finish-it-panel"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold tracking-[-0.01em]">
            {FINISH_IT_STATUS_LABEL[session.status]}
          </div>
          <div className="mt-0.5 text-xs text-muted">{finishItSummary(session)}</div>
        </div>
        {active && (
          <Button
            variant="danger"
            size="sm"
            onClick={onStop}
            disabled={stopping || session.status === "stopping"}
            aria-label="Stop Finish it"
          >
            <Icon name="stop" width={14} height={14} /> Stop
          </Button>
        )}
      </div>
      <ol className="mt-2 grid gap-1">
        {session.milestones.map((m) => {
          const status = finishItDisplayedMilestoneStatus(session, m);
          const tone = finishItMilestoneTone(status);
          return (
            <li key={m.id} className="flex items-center gap-2 text-xs" data-milestone={m.id} data-status={status} aria-busy={tone === "running"}>
              <span
                className={
                  tone === "done"
                    ? "text-success"
                    : tone === "running"
                      ? "text-accent"
                      : tone === "failed"
                        ? "text-danger"
                        : "text-muted"
                }
              >
                {tone === "running" ? (
                  <span className="fd-finish-it-spinner" aria-hidden="true" />
                ) : tone === "done" ? "✓" : tone === "failed" ? "!" : "○"}
                <span className="sr-only">{tone === "running" ? "In progress: " : tone === "done" ? "Complete: " : tone === "failed" ? "Failed: " : "Pending: "}</span>
              </span>
              <span className={tone === "pending" ? "text-muted" : "text-fg"}>{m.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
