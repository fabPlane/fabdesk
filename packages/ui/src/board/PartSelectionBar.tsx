import { useContext } from "react";
import { createPortal } from "react-dom";
import { ComparisonControls } from "./ComparisonControls";
import { Button } from "../components/ui";
import { PartPicker } from "./PartPicker";
import "./part-selection.css";
export function PartSelectionBar({ reference, references, values, onSelect, onClear, onFocus, onActions, notice, onRetry, retrying = false, target }: { reference: string | null; references: string[]; values: ReadonlyMap<string, string>; onSelect: (ref: string) => void; onClear: () => void; onFocus?: (() => void) | undefined; onActions?: (() => void) | undefined; notice?: string | undefined; onRetry?: (() => void) | undefined; retrying?: boolean; target?: HTMLElement | null | undefined }) {
  const comparison = useContext(ComparisonControls);
  if (comparison) return comparison.target ? createPortal(<>
    {notice && <span className="fd-comparison-selection-notice" role="status" title={notice}>{notice}</span>}
    {onRetry && <Button size="sm" disabled={retrying} aria-label={`Retry component inspection in ${comparison.label}`} onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</Button>}
    {reference && <>{onActions && <Button size="sm" variant="ghost" aria-label={`Actions for selected part in ${comparison.label}`} onClick={onActions}>Actions</Button>}<Button size="sm" disabled={!onFocus} aria-label={`Focus selected in ${comparison.label}`} onClick={onFocus}>Focus</Button></>}
  </>, comparison.target) : null;
  const content = <div className="fd-part-selection-bar" data-testid="part-selection-bar">
    <PartPicker reference={reference} references={references} values={values} onSelect={onSelect} onClear={onClear}>
      {notice && <span role="status" title={notice}>{notice}</span>}
      {onRetry && <Button size="sm" disabled={retrying} aria-label="Retry component inspection" onClick={onRetry}>{retrying ? "Retrying…" : "Retry"}</Button>}
      {reference && onActions && <Button size="sm" variant="ghost" onClick={onActions}>Actions</Button>}
      {reference && <Button size="sm" disabled={!onFocus} onClick={onFocus}>Focus</Button>}
    </PartPicker>
  </div>;
  return target === undefined ? content : target ? createPortal(content, target) : null;
}
