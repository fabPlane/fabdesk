type Evidence = {
  kind: "estimate" | "datasheet" | "measured";
  reference?: string | undefined;
};

/** A user's evidence record, never an automatic certification of entered numbers. */
export function EnclosureDimensionEvidence({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Evidence | undefined;
  onChange: (evidence: Evidence) => void;
}) {
  return (
    <>
      <label>
        Where did these sizes come from?
        <select
          aria-label={`${label} dimension source`}
          value={value?.kind ?? "estimate"}
          onChange={(e) => onChange({ ...value, kind: e.target.value as Evidence["kind"] })}
        >
          <option value="estimate">Assumed · needs review</option>
          <option value="datasheet">Manufacturer drawing</option>
          <option value="measured">Measured hardware</option>
        </select>
      </label>
      {value && value.kind !== "estimate" && (
        <label>
          Drawing or measurement reference
          <input
            aria-label={`${label} dimension reference`}
            value={value.reference ?? ""}
            maxLength={500}
            placeholder="Part number + drawing page, or measurement notes"
            onChange={(e) => onChange({ ...value, reference: e.target.value })}
          />
        </label>
      )}
      <small>
        Changing a size marks it assumed again. A reference records your evidence; it does not
        certify fit.
      </small>
    </>
  );
}
