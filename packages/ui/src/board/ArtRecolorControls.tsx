import { useMemo } from "react";
import { convertImage, previewSvg, ORIGINAL_RECOLOR, type ArtworkRecolor, type GrayImage } from "@fabdesk/board-art";

const EFFECTS = [["original", "Original"], ["grayscale", "Grayscale"], ["duotone", "Duotone"]] as const;

export function ArtRecolorControls({ image, value, onChange }: {
  image: GrayImage | null; value: ArtworkRecolor; onChange(value: ArtworkRecolor): void;
}) {
  const thumbnails = useMemo(() => EFFECTS.map(([mode]) => {
    if (!image?.rgba) return null;
    const art = convertImage(image, {
      style: "realistic", color: "white", outline: "rectangle", widthMm: 30, heightMm: 20,
      marginMm: 1, pitchMm: 1, colorMode: "multicolor", recolor: { ...value, mode },
    });
    return `data:image/svg+xml,${encodeURIComponent(previewSvg(art.options, art.clipped, false, true))}`;
  }), [image, value]);
  return <section className="fd-art-recolor" aria-label="Recolor artwork">
    <div className="fd-art-color-heading"><span>Recolor artwork</span></div>
    <p className="fd-art-color-help">Original keeps your image colors. Effects are optional.</p>
    <div className="fd-art-effect-presets" role="group" aria-label="Artwork color effects">
      {EFFECTS.map(([mode, label], index) => <button type="button" key={mode}
        aria-label={`${label} artwork colors`} aria-pressed={value.mode === mode}
        onClick={() => onChange(mode === "original" ? { ...ORIGINAL_RECOLOR } : { ...value, mode })}>
        {thumbnails[index] && <img src={thumbnails[index]!} alt="" />}
        <span>{label}</span>
      </button>)}
    </div>
    {value.mode !== "original" && <>
      <label className="fd-art-effect-strength">Effect strength <span>{Math.round(value.amount * 100)}%</span>
        <input type="range" min="0" max="100" step="1" value={Math.round(value.amount * 100)}
          onChange={event => onChange({ ...value, amount: Number(event.target.value) / 100 })} />
      </label>
      {value.mode === "duotone" && <div className="fd-art-effect-colors">
        {([['shadow', 'Dark tones'], ['highlight', 'Light tones']] as const).map(([key, label]) => <label key={key}>
          <span>{label}</span><input type="color" value={value[key]} onChange={event => onChange({ ...value, [key]: event.target.value })} />
          <span>{value[key]}</span>
        </label>)}
      </div>}
      <button type="button" className="fd-art-reset-colors" onClick={() => onChange({ ...ORIGINAL_RECOLOR })}>Reset to original colors</button>
    </>}
  </section>;
}
