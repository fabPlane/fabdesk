import { enclosureFileLabel, type EnclosureBoardSummary } from "@fabdesk/client-core";
import { useId } from "react";

const mm = (value: number) => Number(value.toFixed(2)).toString();

export function EnclosureBoardDimensions({
  paths,
  selected,
  features,
  disabled,
  onSelect,
  onFocus,
}: {
  paths: string[];
  selected: string | null;
  features: EnclosureBoardSummary | null;
  disabled: boolean;
  onSelect: (path: string | null) => void;
  onFocus: () => void;
}) {
  const selectId = useId();
  if (!paths.length) return null;
  return (
    <section className="fd-case-board-dimensions" aria-label="Selected board measurements">
      <div className="fd-case-measure-heading">
        <label htmlFor={selectId}>Board measurements</label>
        {selected && (
          <button type="button" disabled={disabled} onClick={onFocus}>
            Focus
          </button>
        )}
      </div>
      <select
        id={selectId}
        value={selected ?? ""}
        disabled={disabled}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        <option value="">Select a board…</option>
        {paths.map((p) => (
          <option key={p} value={p}>
            {enclosureFileLabel(p)}
          </option>
        ))}
      </select>
      {selected && features ? (
        <>
          <dl>
            <div>
              <dt>Width</dt>
              <dd>
                {mm(features.outline.widthMm)} <small>mm</small>
              </dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>
                {mm(features.outline.heightMm)} <small>mm</small>
              </dd>
            </div>
            <div>
              <dt>Thickness</dt>
              <dd>
                {mm(features.thicknessMm)} <small>mm</small>
              </dd>
            </div>
          </dl>
          <p>
            PCB outline &amp; thickness · components excluded
            {features.outline.closed === false ? " · outline needs review" : ""}
          </p>
        </>
      ) : (
        <p>
          {selected
            ? "Board measurements are not available yet. Run a preview to read them."
            : "Click a board in 3D or choose one above."}
        </p>
      )}
    </section>
  );
}
