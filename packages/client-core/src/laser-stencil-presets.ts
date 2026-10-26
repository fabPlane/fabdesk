export const LASER_STENCIL_PRESET_IDS = ["mylar-uv", "kapton", "stainless-0.1"] as const;
export type LaserStencilPresetId = (typeof LASER_STENCIL_PRESET_IDS)[number];

export type LaserStencilUiPreset = {
  id: LaserStencilPresetId;
  label: string;
  material: string;
  thicknessMm: number;
  apertureOffsetMm: number;
  kerfMm: number;
  alignmentHoleMm: number;
  includeFiducials: boolean;
  powerPct: number;
  speedMmPerS: number;
  frequencyKhz: number;
  pulseNs: number;
  passes: number;
};

/**
 * Files-tab catalog. Numeric fields must match `@fabdesk/kicad` `LASER_STENCIL_PRESETS`
 * (export-time source of truth). Keep both tables in lockstep; kicad tests compare them.
 */
export const LASER_STENCIL_UI_PRESETS: Record<LaserStencilPresetId, LaserStencilUiPreset> = {
  "mylar-uv": {
    id: "mylar-uv",
    label: "0.1 mm Mylar (PET) · default",
    material: "Mylar / polyester (PET) film · ComMarker Omni X 355 nm UV",
    thicknessMm: 0.1,
    apertureOffsetMm: 0.05,
    kerfMm: 0.015,
    alignmentHoleMm: 3.2,
    includeFiducials: true,
    powerPct: 100,
    speedMmPerS: 1200,
    frequencyKhz: 30,
    pulseNs: 1,
    passes: 2,
  },
  kapton: {
    id: "kapton",
    label: "0.075 mm Kapton (PI)",
    material: "Kapton / polyimide (PI) film · Omni X 355 nm UV",
    thicknessMm: 0.075,
    apertureOffsetMm: 0.04,
    kerfMm: 0.015,
    alignmentHoleMm: 3.2,
    includeFiducials: true,
    powerPct: 100,
    speedMmPerS: 1600,
    frequencyKhz: 30,
    pulseNs: 1,
    passes: 2,
  },
  "stainless-0.1": {
    id: "stainless-0.1",
    label: "0.1 mm stainless foil",
    material: "Stainless-steel stencil foil · UV or fiber galvo",
    thicknessMm: 0.1,
    apertureOffsetMm: 0.05,
    kerfMm: 0.02,
    alignmentHoleMm: 3.2,
    includeFiducials: true,
    powerPct: 100,
    speedMmPerS: 20,
    frequencyKhz: 40,
    pulseNs: 1,
    passes: 8,
  },
};

export const DEFAULT_LASER_STENCIL_PRESET: LaserStencilPresetId = "mylar-uv";

export function laserStencilFormDefaults(id: LaserStencilPresetId = DEFAULT_LASER_STENCIL_PRESET): LaserStencilUiPreset {
  return LASER_STENCIL_UI_PRESETS[id];
}

export function parseLaserNumber(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
