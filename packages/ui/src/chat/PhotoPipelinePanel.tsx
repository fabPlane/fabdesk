import { useId } from "react";
import type { PhotoPipelineSession } from "@fabdesk/protocol";
import { PHOTO_STATUS_LABEL, photoActive, photoStepTone, photoSummary } from "./photo-view";

export function PhotoPipelinePanel({ session }: { session: PhotoPipelineSession }) {
  const detailsId = useId();
  const active = photoActive(session);
  return (
    <div
      className="mb-2 rounded-xl border border-border bg-panel p-3"
      id={detailsId}
      data-testid="photo-pipeline-panel"
      aria-live="polite"
    >
      <div className="text-[13px] font-semibold tracking-[-0.01em]">
        {PHOTO_STATUS_LABEL[session.status]}
      </div>
      <div className="mt-0.5 text-xs text-muted">{photoSummary(session)}</div>
      <ol className="mt-2 grid gap-1">
        {session.steps.map((step) => {
          const tone = photoStepTone(step.status);
          return (
            <li
              key={step.id}
              className="flex items-center gap-2 text-xs"
              data-step={step.id}
              data-status={step.status}
              aria-busy={tone === "running"}
            >
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
                {tone === "running" ? "…" : tone === "done" ? "✓" : tone === "failed" ? "!" : "○"}
                <span className="sr-only">
                  {tone === "running"
                    ? "In progress: "
                    : tone === "done"
                      ? "Complete: "
                      : tone === "failed"
                        ? "Failed: "
                        : "Pending: "}
                </span>
              </span>
              <span className={tone === "pending" ? "text-muted" : "text-fg"}>{step.label}</span>
              {step.note && <span className="text-muted">· {step.note}</span>}
            </li>
          );
        })}
      </ol>
      {active && (
        <p className="mt-2 text-[11px] text-muted">
          Intermediate files land in photo/. Correct the What I see table on the Photo tab before
          continuing.
        </p>
      )}
    </div>
  );
}
