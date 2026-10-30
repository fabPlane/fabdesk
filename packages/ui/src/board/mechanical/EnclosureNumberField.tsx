import { useEffect, useId, useState } from "react";
export function NumberField({
  label,
  inputLabel,
  value,
  onChange,
  min = -10000,
  max = 10000,
  unit = "mm",
}: {
  label: string;
  inputLabel?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  unit?: string;
}) {
  const displayValue = String(Number(value.toFixed(3)));
  const [draft, setDraft] = useState(displayValue);
  const [validation, setValidation] = useState("");
  const validationId = useId();
  useEffect(() => {
    setDraft(displayValue);
    setValidation("");
  }, [displayValue]);
  return (
    <label className="fd-case-number">
      <span>{label}</span>
      <div>
        <input
          aria-label={inputLabel ?? label}
          type="number"
          step="0.1"
          min={min}
          max={max}
          aria-invalid={!!validation}
          aria-describedby={validation ? validationId : undefined}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setValidation("");
          }}
          onBlur={() => {
            const next = Number(draft);
            if (draft.trim() && Number.isFinite(next) && next >= min && next <= max) {
              if (next !== Number(displayValue)) onChange(next);
            } else {
              setDraft(displayValue);
              setValidation(`Use a value from ${min} to ${max}. Previous value kept.`);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(displayValue);
              setValidation("");
              e.stopPropagation();
            }
          }}
        />
        <span>{unit}</span>
      </div>
      {validation && (
        <small id={validationId} className="fd-case-input-error" role="alert">
          {validation}
        </small>
      )}
    </label>
  );
}
