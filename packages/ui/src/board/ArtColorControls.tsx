import { useEffect, useState } from "react";
import { BOARD_COLORS, BOARD_FINISH, type BoardColor, type ColorMode } from "@fabdesk/board-art";

const PRESETS = [
  ["White", "#ffffff"],
  ["Sky blue", "#1d3f7a"],
  ["Black", "#171717"],
  ["Cream", "#f4efd8"],
  ["Coral", "#e76f51"],
  ["Purple", "#6c43a6"],
] as const;

function HexColor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const invalid = !/^#[0-9a-f]{6}$/i.test(text);
  return (
    <div className="fd-art-field">
      <span>{label}</span>
      <div className="fd-art-color-input">
        <input
          type="color"
          aria-label={`${label} color wheel`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          aria-label={`${label} hex`}
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-invalid={invalid}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase());
          }}
        />
      </div>
      {invalid && (
        <span role="status" className="text-[11px] text-muted">
          Enter # and six hex digits. Preview keeps the last valid color.
        </span>
      )}
      <div className="fd-art-color-swatches" role="group" aria-label={`${label} presets`}>
        {PRESETS.map(([name, hex]) => (
          <button
            type="button"
            key={hex}
            title={name}
            aria-label={`${label}: ${name}`}
            aria-pressed={value === hex}
            style={{ backgroundColor: hex }}
            onClick={() => onChange(hex)}
          />
        ))}
      </div>
    </div>
  );
}

export function ArtColorControls({
  mode,
  onMode,
  mask,
  onMask,
  background,
  onBackground,
  ink,
  onInk,
}: {
  mode: ColorMode;
  onMode(value: ColorMode): void;
  mask: BoardColor;
  onMask(value: BoardColor): void;
  background: string;
  onBackground(value: string): void;
  ink: string;
  onInk(value: string): void;
}) {
  return (
    <div className="space-y-4">
      <div className="fd-art-field">
        <span>Artwork colors</span>
        <div className="fd-art-color-modes" role="group" aria-label="Artwork color mode">
          {(["monotone", "multicolor"] as const).map((m) => (
            <button type="button" key={m} aria-pressed={mode === m} onClick={() => onMode(m)}>
              {m === "monotone" ? "Monotone" : "Multicolor"}
            </button>
          ))}
        </div>
      </div>
      <div className="fd-art-field">
        <span>Physical board · solder mask</span>
        <div className="fd-art-color-swatches" role="group" aria-label="Physical solder mask color">
          {BOARD_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              title={c}
              aria-label={`${c} solder mask`}
              aria-pressed={(mode === "multicolor" ? "white" : mask) === c}
              disabled={mode === "multicolor" && c !== "white"}
              style={{ backgroundColor: BOARD_FINISH[c].mask }}
              onClick={() => onMask(c)}
            />
          ))}
        </div>
        <span className="text-[11px] text-muted">
          {mode === "multicolor"
            ? "White solder mask required for JLCPCB multicolor. Choose a printed background below."
            : `${mask} · JLCPCB palette. Swatches approximate the physical finish.`}
        </span>
      </div>
      {mode === "multicolor" ? (
        <>
          <HexColor label="Printed background" value={background} onChange={onBackground} />
          <p className="text-[11px] text-muted">
            Printed over white solder mask, visible between source-colored dots. Artwork retains its
            original colors.
          </p>
          <button
            type="button"
            className="text-xs underline"
            onClick={() => onBackground("#ffffff")}
          >
            Reset printed background to white
          </button>
          <p className="text-[11px] text-muted">
            Color SVG reference only. JLCPCB requires EasyEDA Pro color-production files; this ZIP
            does not supply them. Halftone feature sizes need process review.
          </p>
          <a
            className="text-[11px] underline"
            href="https://jlcpcb.com/help/article/how-to-design-multi-color-silkscreen-using-easyeda"
            target="_blank"
            rel="noreferrer"
          >
            JLCPCB multicolor requirements
          </a>
        </>
      ) : (
        <>
          <HexColor label="Monotone ink preview" value={ink} onChange={onInk} />
          <p className="text-[11px] text-muted">
            Gerber carries geometry only. Choose supported ink and solder-mask colors with your
            manufacturer when ordering.
          </p>
        </>
      )}
    </div>
  );
}
