import { Icon } from "../components/Icon";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";

/** Root schematic receipts are not checked by this view; never imply parity or freshness. */
export function SchematicPreviewStatus({ scopeReady, hasSource, busy, updated, error, onUpdate, onOpenSource, onRetryScope }: {
  scopeReady: boolean; hasSource: boolean; busy: boolean; updated: boolean; error: string | null;
  onUpdate: () => void; onOpenSource: () => void; onRetryScope?: () => void;
}) {
  const label = busy ? "Updating schematic drawing…" : !scopeReady ? "Board source scope unverified" : hasSource ? updated ? "Drawing updated · Freshness unverified" : "Saved preview · Freshness unverified" : "Saved drawing · Native schematic missing";
  return <div className="fd-preview-status fd-schematic-status" data-state={scopeReady && !hasSource ? "changed" : "unverified"}>
    <div><span role="status">{label}</span>
      <WorkspaceMenu label={<span aria-label="Schematic drawing tools"><Icon name="more" width={16} height={16} /></span>}>
        <button disabled={!scopeReady || !hasSource || busy} onClick={onUpdate}>{busy ? "Updating drawing…" : "Update from saved schematic"}</button>
        <button disabled={!hasSource} onClick={onOpenSource}>Show schematic source</button>
        {onRetryScope && <button onClick={onRetryScope}>Retry source check</button>}
        <div className="fd-menu-caption">Source receipts are not verified in this view. ERC and PCB parity are separate checks.</div>
      </WorkspaceMenu>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
