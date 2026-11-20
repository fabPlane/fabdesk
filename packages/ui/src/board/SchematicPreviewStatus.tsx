import { Icon } from "../components/Icon";
import { Button } from "../components/ui";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";

/** Captured native bytes are compared separately from electrical checks and external libraries. */
export function SchematicPreviewStatus({ scopeReady, hasSource, sourceState, circuit, busy, updated, error, onUpdate, onOpenSource, onRetryScope }: {
  sourceState?: string | undefined; scopeReady: boolean; hasSource: boolean; circuit: boolean; busy: boolean; updated: boolean; error: string | null;
  onUpdate: () => void; onOpenSource: () => void; onRetryScope?: () => void;
}) {
  const label = busy ? "Updating schematic drawing…" : !scopeReady ? "Board source scope unverified" : hasSource ? sourceState === "source-unchanged" ? "Saved native sheets match this drawing" : sourceState === "source-changed" ? "Schematic changed · Showing an earlier drawing" : sourceState === "artifact-changed" ? "Drawing changed or is missing · Reopen circuit view" : updated ? "Drawing updated · Source unverified" : "Saved preview · Source unverified" : "Saved drawing · Native schematic missing";
  return <div className="fd-preview-status fd-schematic-status" data-state={scopeReady && (!hasSource || sourceState === "source-changed" || sourceState === "artifact-changed") ? "changed" : sourceState === "source-unchanged" ? "matches-source" : "unverified"}>
    <div><span role="status">{label}</span>{error && <Button size="sm" disabled={!scopeReady || busy} onClick={onUpdate}>Retry preview</Button>}
      <WorkspaceMenu label={<span aria-label="Schematic drawing tools"><Icon name="more" width={16} height={16} /></span>}>
        <div className="fd-menu-caption">Preview updates automatically from saved sheets.</div>
        <button disabled={!hasSource} onClick={onOpenSource}>Show schematic source</button>
        {onRetryScope && <button onClick={onRetryScope}>Retry source check</button>}
        <div className="fd-menu-caption">Recorded native source bytes are compared for circuit previews. External libraries, ERC and PCB parity remain separate checks.</div>
      </WorkspaceMenu>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
