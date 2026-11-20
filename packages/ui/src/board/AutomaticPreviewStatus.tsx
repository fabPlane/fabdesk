import { PreviewInTrashError, useLivePreview, type PreviewKind, type PreviewScope } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { Button, EmptyState } from "../components/ui";

export function AutomaticPreviewStatus({ kind, ...scope }: PreviewScope & { kind: PreviewKind }) {
  const preview = useLivePreview(kind, scope);
  return <span role="status" className="text-xs text-muted">{preview.error ? <>
    {preview.error.message} <PreviewRecovery error={preview.error} retry={() => void preview.retry()} />
  </> : !preview.available ? "Waiting for saved source…" : preview.updating ? "Updating preview automatically…" : "Preview follows saved source"}</span>;
}

export function PreviewRecovery({ error, retry }: { error: Error; retry: () => void }) {
  return error instanceof PreviewInTrashError
    ? <Button size="sm" onClick={() => useUiStore.getState().setBoardTab("renders")}>Open outputs</Button>
    : <Button size="sm" onClick={retry}>Retry preview</Button>;
}

export function PreviewError({ error, retry }: { error: Error; retry: () => void }) {
  return <EmptyState title={error.message} action={<PreviewRecovery error={error} retry={retry} />} />;
}
