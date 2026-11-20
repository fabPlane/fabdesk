import { PreviewInTrashError, useLivePreview, type PreviewKind, type PreviewScope } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { Button, EmptyState } from "../components/ui";

export function AutomaticPreviewStatus({ kind, ...scope }: PreviewScope & { kind: PreviewKind }) {
  const preview = useLivePreview(kind, scope);
  return <span role="status" className="text-xs text-muted">{preview.error ? <>
    {preview.error.message} <Button size="sm" variant="ghost" onClick={() => void preview.retry()}>Retry preview</Button>
  </> : !preview.available ? "Waiting for saved source…" : preview.updating ? "Updating preview automatically…" : "Preview follows saved source"}</span>;
}

export function PreviewError({ error, retry }: { error: Error; retry: () => void }) {
  const inTrash = error instanceof PreviewInTrashError;
  return <EmptyState title={error.message} action={inTrash
    ? <Button onClick={() => useUiStore.getState().setBoardTab("renders")}>Open outputs</Button>
    : <Button onClick={retry}>Try again</Button>} />;
}
