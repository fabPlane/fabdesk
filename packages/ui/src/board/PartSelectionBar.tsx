import { useContext } from "react";
import { createPortal } from "react-dom";
import { ComparisonControls } from "./ComparisonControls";
import { Button } from "../components/ui";
import "./part-selection.css";
export function PartSelectionBar({ reference, references, onSelect, onClear, onFocus, onActions, notice, onRetry, retrying = false, target }: { reference: string | null; references: string[]; onSelect: (ref: string) => void; onClear: () => void; onFocus?: (() => void) | undefined; onActions?: (() => void) | undefined; notice?: string | undefined; onRetry?: (() => void) | undefined; retrying?: boolean; target?: HTMLElement | null | undefined }) {
  const comparison = useContext(ComparisonControls);
  if (comparison) return comparison.target ? createPortal(<>
    {notice && <span className="fd-comparison-selection-notice" role="status" title={notice}>{notice}</span>}
    {onRetry && <Button size="sm" disabled={retrying} aria-label={`Retry component inspection in ${comparison.label}`} onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</Button>}
    {reference && <>{onActions && <Button size="sm" variant="ghost" aria-label={`Actions for selected part in ${comparison.label}`} onClick={onActions}>Actions</Button>}<Button size="sm" disabled={!onFocus} aria-label={`Focus selected in ${comparison.label}`} onClick={onFocus}>Focus</Button></>}
  </>, comparison.target) : null;
  const content = <div className="fd-part-selection-bar" data-testid="part-selection-bar">
    <select aria-label="Selected component across views" disabled={!references.length} value={references.includes(reference ?? "") ? reference! : ""} onChange={e => e.target.value ? onSelect(e.target.value) : onClear()}>
      <option value="">Select a part…</option>{references.map(ref => <option key={ref} value={ref}>{ref}</option>)}
    </select>
    <span role="status" title={notice}>{notice ?? (reference ? `${reference} selected across views` : target !== undefined ? "" : "Click a part to highlight it across views")}</span>
    {onRetry && <Button size="sm" disabled={retrying} aria-label="Retry component inspection" onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</Button>}
    {reference && <>{onActions && <Button size="sm" variant="ghost" onClick={onActions}>Actions</Button>}<Button size="sm" disabled={!onFocus} onClick={onFocus}>Focus selected</Button><Button size="sm" variant="ghost" onClick={onClear}>Clear</Button></>}
  </div>;
  return target === undefined ? content : target ? createPortal(content, target) : null;
}
