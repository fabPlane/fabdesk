import type { ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySelection, type AssemblySceneSelection } from "./assembly-scene";
import type { PcbPreviewState } from "./pcb-preview-revision";
export type LiveAssemblyPreview = { selection: AssemblySceneSelection; sourceSha256: string; name: string };
type Preview = { sourceId: string; data?: PcbPreviewState | undefined; isFetching: boolean; isError: boolean };
/** A mounted project's saved-source observer. Initial/imported/stale previews are never automatically overwritten. */
export class LiveAssemblyPreviewQueue {
  private scope: string | null = null;
  private observed = new Map<string, string>();
  private pending = new Map<string, LiveAssemblyPreview>();
  observe(data: ProjectBoardSources, previews: readonly Preview[]) {
    const scope = `${data.projectId}/${data.manifestSha256}`;
    if (data.mode !== "assembly" || !data.manifestSha256) { this.scope = null; this.observed.clear(); this.pending.clear(); return; }
    if (this.scope !== scope) {
      this.scope = scope; this.pending.clear(); this.observed = new Map(data.sources.flatMap(row => row.status === "available" && row.pcbSha256 ? [[row.source.id, row.pcbSha256] as const] : []));
      return;
    }
    for (const row of data.sources) {
      const id = row.source.id, hash = row.pcbSha256, previous = this.observed.get(id);
      if (row.status !== "available" || row.source.location !== "project" || !hash) { this.observed.delete(id); this.pending.delete(id); continue; }
      this.observed.set(id, hash);
      const instance = data.assembly?.instances.find(item => item.sourceId === id), selection = instance ? captureAssemblySelection(data, instance.id) : null;
      if (previous && previous !== hash && row.previewPath && selection) this.pending.set(id, { selection, sourceSha256: hash, name: row.source.name });
      const preview = previews.find(item => item.sourceId === id);
      // Wait for an authoritative read; never replace a changed/unverified artifact or invent a preview.
      if (!row.previewPath || !selection || preview && !preview.isFetching && !preview.isError && preview.data !== "source-changed") this.pending.delete(id);
    }
    for (const id of this.pending.keys()) if (!data.sources.some(row => row.source.id === id)) this.pending.delete(id);
  }
  next(previews: readonly Preview[]): LiveAssemblyPreview | null {
    for (const [id, target] of this.pending) {
      const preview = previews.find(row => row.sourceId === id);
      if (!preview || preview.isFetching || preview.isError || preview.data !== "source-changed") continue;
      this.pending.delete(id); // An error stays explicit; no automatic retry loop for these saved bytes.
      return structuredClone(target);
    }
    return null;
  }
}
