import { DisclosureSummary } from "../components/DisclosureSummary";
import { useVideoInputRevision, videoInputsNeedReview, type VideoInputRevisionState } from "@fabdesk/client-core";
import { Button } from "../components/ui";

export function videoInputLabel(state: VideoInputRevisionState | undefined): string {
  return state === "board-source-changed" ? "PCB changed since the video’s board model"
    : state === "board-source-unverified" ? "Video board model · PCB source unverified"
    : state === "inputs-changed" ? "Video model inputs changed"
    : state === "inputs-unchanged" ? "Models unchanged since video export"
    : state === "artifact-changed" ? "Video file changed · Source unverified"
    : state === "missing-input" ? "A recorded video model is missing"
    : state === "missing-artifact" ? "Saved video is missing"
    : "Saved video · Source unverified";
}

/** Tracked source-qualified provenance is checked; captions and full-scene freshness remain separate. */
export function VideoSourceStatus({ projectId, path, updating }: { projectId: string; path: string; updating: boolean }) {
  const revision = useVideoInputRevision(projectId, path);
  return <div className="fd-board-model-status" data-warning={videoInputsNeedReview(revision.data)} aria-live="polite">
    <strong>{updating ? "Updating video…" : revision.isFetching || revision.isPending ? "Checking video inputs…" : revision.isError ? "Video inputs could not be checked" : videoInputLabel(revision.data)}</strong>
    <details><DisclosureSummary icon="folderOpen" label="Video source details" variant="compact" /><p>Checks the saved video, its recorded models and the PCB source of a tracked board model. Video uses saved 3D meshes; a board image may show component geometry that those meshes omit. Captions, model coverage, new scene content and external component files still need review. The saved video stays until you choose Make video.</p></details>
    {revision.isError && <Button size="sm" variant="ghost" onClick={() => void revision.refetch()}>Retry video source check</Button>}
  </div>;
}
