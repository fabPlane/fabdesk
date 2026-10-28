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
  unset = false,
  onClear,
  presets = true,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  unset?: boolean;
  onClear?: () => void;
  presets?: boolean;
}) {
  const [text, setText] = useState(unset ? "" : value);
  useEffect(() => setText(unset ? "" : value), [value, unset]);
  const invalid = !(unset && text === "") && !/^#[0-9a-f]{6}$/i.test(text);
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
          placeholder={unset ? "Not set" : "#RRGGBB"}
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
        {onClear && (
          <button
            type="button"
            className="fd-art-no-color"
            aria-label="Use board color (no printed background)"
            title="Not set — use board color"
            aria-pressed={unset}
            onClick={() => {
              setText("");
              onClear();
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5.5 18.5 18.5 5.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        )}
      </div>
      {invalid && (
        <span role="status" className="text-[11px] text-muted">
          Enter # and six hex digits. Preview keeps the last valid color.
        </span>
      )}
      {presets && (
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
      )}
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
  background: string | null;
  onBackground(value: string | null): void;
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
            ? "White solder mask required for JLCPCB multicolor. A custom printed background is optional."
            : `${mask} · JLCPCB palette. Swatches approximate the physical finish.`}
        </span>
      </div>
      {mode === "multicolor" ? (
        <>
          <HexColor
            label="Printed background"
            value={background ?? "#ffffff"}
            unset={background === null}
            onChange={onBackground}
            onClear={() => onBackground(null)}
            presets={false}
          />
          <p className="text-[11px] text-muted">
            Optional color over the board, independent of the source image. Not set leaves the board
            color visible between artwork dots.
          </p>
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
