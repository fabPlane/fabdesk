import { Button } from "../components/ui";
import "./part-selection.css";
export function PartSelectionBar({ reference, references, onSelect, onClear, onFocus, onActions, notice }: { reference: string | null; references: string[]; onSelect: (ref: string) => void; onClear: () => void; onFocus?: (() => void) | undefined; onActions?: (() => void) | undefined; notice?: string | undefined }) {
  return <div className="fd-part-selection-bar" data-testid="part-selection-bar">
    <select aria-label="Selected component across views" value={references.includes(reference ?? "") ? reference! : ""} onChange={e => e.target.value ? onSelect(e.target.value) : onClear()}>
      <option value="">Select a part…</option>{references.map(ref => <option key={ref} value={ref}>{ref}</option>)}
    </select>
    <span role="status">{notice ?? (reference ? `${reference} selected across views` : "Click a part to highlight it across views")}</span>
    {reference && <>{onActions && <Button size="sm" variant="ghost" onClick={onActions}>Actions</Button>}<Button size="sm" disabled={!onFocus} onClick={onFocus}>Focus selected</Button><Button size="sm" variant="ghost" onClick={onClear}>Clear</Button></>}
  </div>;
}
