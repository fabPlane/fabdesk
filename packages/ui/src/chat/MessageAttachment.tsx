import { DisclosureSummary } from "../components/DisclosureSummary";
import { useUiStore } from "../stores/ui";
import { ProjectImage } from "./ProjectImage";

/** Stored attachment parts retain their MIME type, including native design files. */
export function MessageAttachment({ path, mime = "image/png" }: { path: string; mime?: string }) {
  const projectId = useUiStore(state => state.activeProjectId);
  if (!mime.startsWith("image/")) return <details className="my-1.5 max-w-full rounded-lg border border-border bg-panel-2 text-xs">
    <DisclosureSummary icon="paperclip" label={path.split(/[\\/]/).at(-1) || path} badge="File" variant="compact" />
    <div className="space-y-1 px-3 pb-3 text-muted"><p>File attached to this request.</p><p className="break-all font-mono">{path}</p></div>
  </details>;
  return <div className="my-1.5"><ProjectImage projectId={projectId} path={path} /></div>;
}
