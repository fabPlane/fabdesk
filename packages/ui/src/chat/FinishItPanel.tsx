import { useId, useState } from "react";
import type { FinishItSession } from "@fabdesk/protocol";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { finishItActive, finishItDisplayedMilestoneStatus, finishItMilestoneNote, finishItMilestoneTone, finishItNextStep, finishItSummary, FINISH_IT_STATUS_LABEL } from "./finish-it-view";

export interface FinishItPanelProps {
  session: FinishItSession;
  onStop: () => void;
  stopping?: boolean;
}

export function FinishItPanel({ session, onStop, stopping }: FinishItPanelProps) {
  const active = finishItActive(session);
  const finished = session.status === "completed";
  const [collapsedSession, setCollapsedSession] = useState<string | null>(null);
  const detailsId = useId();
  const collapsed = finished && collapsedSession === session.id;
  const nextStep = finishItNextStep(session);
  if (collapsed) {
    return (
      <div className="mb-2" data-testid="finish-it-panel">
        <button type="button" className="fd-finish-it-complete-toggle"
          aria-label="Show finished board details" aria-expanded={false}
          onClick={() => setCollapsedSession(null)}>
          <Icon name="check" width={15} height={15} aria-hidden="true" />
          <span>Board finished</span>
          <Icon name="chevronDown" width={14} height={14} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div
      className={`mb-2 rounded-xl border border-border bg-panel p-3${finished ? " fd-finish-it-complete" : ""}`}
      id={detailsId}
      data-testid="finish-it-panel"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        {finished && (
          <span className="fd-finish-it-success-icon" aria-hidden="true">
            <Icon name="check" width={17} height={17} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-semibold tracking-[-0.01em]${finished ? " text-success" : ""}`}>
            {FINISH_IT_STATUS_LABEL[session.status]}
          </div>
          <div className="mt-0.5 text-xs text-muted">{finishItSummary(session)}</div>
        </div>
        {finished && (
          <button type="button" className="fd-finish-it-close"
            aria-label="Hide finished board details" aria-expanded={true} aria-controls={detailsId}
            title="Hide details" onClick={() => setCollapsedSession(session.id)}>
            <Icon name="close" width={15} height={15} aria-hidden="true" />
          </button>
        )}
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
          const note = finishItMilestoneNote(session, m);
          return (
            <li key={m.id} className="flex items-baseline gap-2 text-xs" data-milestone={m.id} data-status={status} aria-busy={tone === "running"}>
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
              {note && <span className="min-w-0 text-muted">· {note}</span>}
            </li>
          );
        })}
      </ol>
      {nextStep && <p className="mt-2 text-xs text-muted">{nextStep}</p>}
    </div>
  );
}
