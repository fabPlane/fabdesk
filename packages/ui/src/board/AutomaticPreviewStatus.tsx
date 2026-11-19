import { useLivePreview, type PreviewKind, type PreviewScope } from "@fabdesk/client-core";
import { Button } from "../components/ui";

export function AutomaticPreviewStatus({ kind, ...scope }: PreviewScope & { kind: PreviewKind }) {
  const preview = useLivePreview(kind, scope);
  return <span role="status" className="text-xs text-muted">{preview.error ? <>
    {preview.error.message} <Button size="sm" variant="ghost" onClick={() => void preview.retry()}>Retry preview</Button>
  </> : !preview.available ? "Waiting for saved source…" : preview.updating ? "Updating preview automatically…" : "Preview follows saved source"}</span>;
}
