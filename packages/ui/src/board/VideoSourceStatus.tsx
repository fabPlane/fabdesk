import { useVideoInputRevision, type VideoInputRevisionState } from "@fabdesk/client-core";
import { Button } from "../components/ui";

export function videoInputLabel(state: VideoInputRevisionState | undefined): string {
  return state === "inputs-changed" ? "Video model inputs changed"
    : state === "inputs-unchanged" ? "Recorded model inputs unchanged"
    : state === "artifact-changed" ? "Video file changed · Source unverified"
    : state === "missing-input" ? "A recorded video model is missing"
    : state === "missing-artifact" ? "Saved video is missing"
    : "Saved video · Source unverified";
}
export const videoInputsNeedReview = (state: VideoInputRevisionState | undefined) => ["inputs-changed", "artifact-changed", "missing-input", "missing-artifact"].includes(state ?? "");

/** Input identity is narrower than current PCB, caption or full-scene freshness. */
export function VideoSourceStatus({ projectId, path, updating }: { projectId: string; path: string; updating: boolean }) {
  const revision = useVideoInputRevision(projectId, path);
  return <div className="fd-board-model-status" data-warning={videoInputsNeedReview(revision.data)} aria-live="polite">
    <strong>{updating ? "Updating video…" : revision.isFetching || revision.isPending ? "Checking video inputs…" : revision.isError ? "Video inputs could not be checked" : videoInputLabel(revision.data)}</strong>
    <details><summary>Video source details</summary><p>Tracks the models used by this saved video. PCB changes, captions and newly added scene content need separate review. The saved video stays until you choose Make video.</p></details>
    {revision.isError && <Button size="sm" variant="ghost" onClick={() => void revision.refetch()}>Retry video source check</Button>}
  </div>;
}
