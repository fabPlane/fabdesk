import { useEffect, useState } from "react";
import { BOARD_COLORS, BOARD_FINISH, type BoardColor, type ColorMode } from "@fabdesk/board-art";
import type { ReactNode } from "react";

const PRESETS = [
  ["White", "#ffffff"],
  ["Board green", BOARD_FINISH.green.mask],
  ["Blue", "#1d3f7a"],
  ["Black", "#171717"],
  ["Cream", "#f4efd8"],
  ["Coral", "#e76f51"],
  ["Purple", "#6c43a6"],
] as const;

function NoColorIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 18.5 18.5 5.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function HexColor({
  label,
  value,
  onChange,
  unset = false,
  onClear,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  unset?: boolean;
  onClear?: () => void;
}) {
  const [text, setText] = useState(unset ? "" : value);
  useEffect(() => setText(unset ? "" : value), [value, unset]);
  const invalid = !(unset && text === "") && !/^#[0-9a-f]{6}$/i.test(text);
  return (
    <section className="fd-art-color-card" aria-label={label}>
      <div className="fd-art-color-heading">
        <span>{label}</span>
        {onClear && <span className="fd-art-color-badge">Optional</span>}
      </div>
      {onClear && (
        <p className="fd-art-color-help">
          A solid base behind your artwork, independent of the source image.
        </p>
      )}
      {onClear && (
        <button
          type="button"
          className="fd-art-inherit-color"
          aria-label="Use board color (no printed background)"
          title="Not set — use board color"
          aria-pressed={unset}
          onClick={() => {
            setText("");
            onClear();
          }}
        >
          <NoColorIcon />
          <span>Use board color</span>
          <span className="fd-art-inherit-value">White</span>
          <span className="fd-art-inherit-check" aria-hidden="true">
            {unset ? "✓" : ""}
          </span>
        </button>
      )}
      <div className="fd-art-color-subtitle">Custom color</div>
      <div className={`fd-art-custom-color${!unset ? " is-active" : ""}`}>
        <label className="fd-art-color-picker" title="Color wheel · choose any color">
          <span className="fd-art-color-wheel-icon" aria-hidden="true" />
          <input
            type="color"
            aria-label={`${label} color wheel`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
        <div className="fd-art-hex-field">
          {!unset && (
            <span
              className="fd-art-picked-color"
              style={{ backgroundColor: value }}
              aria-hidden="true"
            />
          )}
          <input
            aria-label={`${label} hex`}
            placeholder="#RRGGBB"
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
      </div>
      {invalid && (
        <p role="status" className="fd-art-color-help">
          Use # followed by six hex digits.
        </p>
      )}
      <div className="fd-art-color-subtitle">
        {onClear ? "Suggested backgrounds" : "Suggested ink colors"}
      </div>
      <div
        className="fd-art-color-swatches fd-art-suggested-colors"
        role="group"
        aria-label={`${label} presets`}
      >
        {PRESETS.map(([name, hex]) => (
          <button
            type="button"
            key={hex}
            title={name}
            aria-label={`${label}: ${name}`}
            aria-pressed={!unset && value === hex}
            style={{ backgroundColor: hex }}
            onClick={() => onChange(hex)}
          />
        ))}
      </div>
    </section>
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
  recolorControls,
}: {
  mode: ColorMode;
  onMode(value: ColorMode): void;
  mask: BoardColor;
  onMask(value: BoardColor): void;
  background: string | null;
  onBackground(value: string | null): void;
  ink: string;
  onInk(value: string): void;
  recolorControls?: ReactNode;
}) {
  return (
    <div className="fd-art-colors">
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
        {mode === "multicolor" ? (
          <div className="fd-art-fixed-mask">
            <span
              className="fd-art-fixed-mask-swatch"
              style={{ backgroundColor: BOARD_FINISH.white.mask }}
              aria-hidden="true"
            />
            <div>
              <span>White</span>
              <span className="fd-art-color-help">Required for JLCPCB multicolor</span>
            </div>
            <svg
              className="fd-art-mask-lock"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              aria-label="Fixed by manufacturing process"
              role="img"
            >
              <rect
                x="5"
                y="10"
                width="14"
                height="11"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M8 10V7a4 4 0 0 1 8 0v3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </div>
        ) : (
          <>
            <div
              className="fd-art-color-swatches fd-art-mask-swatches"
              role="group"
              aria-label="Physical solder mask color"
            >
              {BOARD_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  title={c}
                  aria-label={`${c} solder mask`}
                  aria-pressed={mask === c}
                  style={{ backgroundColor: BOARD_FINISH[c].mask }}
                  onClick={() => onMask(c)}
                />
              ))}
            </div>
            <span className="fd-art-color-help">{mask} · approximate JLCPCB finish</span>
          </>
        )}
      </div>
      {mode === "multicolor" ? (
        <>
          {recolorControls}
          <HexColor
            label="Printed background"
            value={background ?? "#ffffff"}
            unset={background === null}
            onChange={onBackground}
            onClear={() => onBackground(null)}
          />
          <div className="fd-art-print-guidance">
            <p>Color export is an SVG reference.</p>
            <details>
              <summary>Manufacturing &amp; export</summary>
              <p>
                JLCPCB multicolor uses white physical solder mask. A printed background changes its
                visible color. Switch to Monotone to choose another physical mask color.
              </p>
              <p>
                Generate the final color-production files in EasyEDA Pro and check feature sizes and
                pad clearances before ordering.
              </p>
              <a
                href="https://jlcpcb.com/help/article/how-to-design-multi-color-silkscreen-using-easyeda"
                target="_blank"
                rel="noreferrer"
              >
                JLCPCB process guide ↗
              </a>
            </details>
          </div>
        </>
      ) : (
        <>
          <HexColor label="Monotone ink preview" value={ink} onChange={onInk} />
          <p className="fd-art-color-help">
            Select ink and mask colors when ordering. Gerber contains geometry only.
          </p>
        </>
      )}
    </div>
  );
}
