import { useEffect, useState } from "react";

export function BoardDimensions({
  widthMm,
  heightMm,
  circular,
  onChange,
}: {
  widthMm: number;
  heightMm: number;
  circular: boolean;
  onChange: (width: number, height: number) => void;
}) {
  const [width, setWidth] = useState(String(widthMm));
  const [height, setHeight] = useState(String(heightMm));
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setWidth(String(widthMm));
    setHeight(String(heightMm));
    setError(null);
  };
  useEffect(reset, [widthMm, heightMm, circular]);
  const commit = () => {
    const w = Number(width),
      h = circular ? w : Number(height);
    if (
      !width.trim() ||
      (!circular && !height.trim()) ||
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      w < 10 ||
      h < 10 ||
      w > 400 ||
      h > 400
    ) {
      setError("Enter a size from 10 to 400 mm.");
      return;
    }
    setError(null);
    if (w !== widthMm || h !== heightMm) onChange(w, h);
  };
  const field = (label: string, value: string, set: (s: string) => void) => (
    <label className="fd-art-field">
      {label}
      <input
        type="number"
        min={10}
        max={400}
        step={0.1}
        value={value}
        aria-invalid={!!error}
        onChange={(e) => {
          set(e.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            reset();
          }
        }}
      />
    </label>
  );
  return (
    <div>
      <div className={`fd-art-dimensions ${circular ? "is-circle" : ""}`}>
        {field(circular ? "Diameter (mm)" : "Width (mm)", width, setWidth)}
        {!circular && field("Height (mm)", height, setHeight)}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
