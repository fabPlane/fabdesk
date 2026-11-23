import type { PhotoPipelineSession, PhotoPipelineStepState } from "@fabdesk/protocol";

export const PHOTO_STATUS_LABEL: Record<PhotoPipelineSession["status"], string> = {
  running: "Drafting from photos",
  completed: "Photo draft ready",
  failed: "Photo draft failed",
};

export function photoActive(session: PhotoPipelineSession | null | undefined): boolean {
  return session?.status === "running";
}

export function photoStepTone(
  status: PhotoPipelineStepState,
): "pending" | "running" | "done" | "failed" {
  return status;
}

export function photoSummary(session: PhotoPipelineSession): string {
  if (session.status === "failed") return session.error ?? "The photo draft failed.";
  if (session.status === "completed") return "Review the draft on the Photo board tab.";
  const current = session.steps.find((s) => s.id === session.currentStep);
  return current?.note ?? current?.label ?? "Working…";
}
