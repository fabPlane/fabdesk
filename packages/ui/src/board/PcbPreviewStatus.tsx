import { usePcbPreviewRevision } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** A small source-specific status, never a schematic-sync or compatibility badge. */
export function PcbPreviewStatus({ projectId, busy, error, onUpdate, coordinatesVerified }: { projectId: string; coordinatesVerified: boolean; busy: boolean; error: string | null; onUpdate: () => void }) {
  const revision = usePcbPreviewRevision(projectId);
  const state = revision.data;
  const changed = state === "source-changed";
  const matches = state === "matches-source" && coordinatesVerified;
  const label = busy ? "Updating preview…" : revision.isPending ? "Checking preview…" : revision.isError ? "Could not verify preview" : matches ? "Preview matches PCB" : state === "matches-source" && !coordinatesVerified ? "Preview origin unverified" : changed ? "PCB changed since preview" : state === "artifact-changed" ? "Preview changed outside export" : state === "missing-source" ? "PCB source missing" : "Saved preview · unverified";
  return <div className="fd-preview-status" data-state={matches ? "matches" : changed ? "changed" : "unverified"}>
    <div title="Compares this SVG and board.kicad_pcb against the recorded export hashes. It does not check schematic synchronization, other outputs or electrical compatibility.">
      <Icon name={matches ? "check" : changed ? "warning" : "pcb"} width={14} height={14} /><span role="status">{label}</span>
      {!matches && state !== "missing-source" && !revision.isPending && <Button size="sm" variant="ghost" disabled={busy} onClick={onUpdate}>Update preview</Button>}
      {revision.isError && <Button size="sm" variant="ghost" onClick={() => void revision.refetch()}>Retry check</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
