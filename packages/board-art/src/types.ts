import { validateArtPlacement } from "./placement";
/** Deterministic image → PCB art. Units are millimetres unless noted. */

export const ART_STYLES = ["realistic", "retro", "poster"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

export const BOARD_COLORS = ["green", "black", "blue", "red", "purple", "white", "yellow"] as const;
export type BoardColor = (typeof BOARD_COLORS)[number];

export const OUTLINE_KINDS = ["rectangle", "rounded", "circle"] as const;
export type OutlineKind = (typeof OUTLINE_KINDS)[number];

export const ART_LAYERS = ["silk", "mask", "copper"] as const;
export type ArtLayer = (typeof ART_LAYERS)[number];

/** Typical fab houses reject silkscreen strokes thinner than ~0.15 mm. */
export const MIN_FEATURE_MM = 0.15;
export const DEFAULT_FEATURE_MM = 0.2;
export const DEFAULT_WIDTH_MM = 80;
export const DEFAULT_HEIGHT_MM = 50;
export const DEFAULT_MARGIN_MM = 2;
export const MAX_PRIMITIVES = 12_000;

export const COLOR_MODES = ["monotone", "multicolor"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export function normalizeHex(value: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(value))
    throw new Error("Use a six-digit hex color, such as #1D3F7A.");
  return value.toLowerCase();
}

export type GrayImage = {
  /** Original RGBA retained for source-colored printing. */
  rgba?: Uint8Array;
  width: number;
  height: number;
  /** 0 = black, 255 = white. Length = width * height. */
  pixels: Uint8Array;
};

export type RgbaImage = {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
};

export type CirclePrim = { kind: "circle"; x: number; y: number; d: number };
export type LinePrim = { kind: "line"; x1: number; y1: number; x2: number; y2: number; w: number };
export type RectPrim = { kind: "rect"; x: number; y: number; w: number; h: number };
export type Primitive = (CirclePrim | LinePrim | RectPrim) & { color?: string };

export const IMAGE_CROPS = ["none", "circle", "rounded"] as const;
export type ImageCrop = (typeof IMAGE_CROPS)[number];

export type ArtPlacement = {
  centerXmm: number;
  centerYmm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
};

export type ArtOptions = {
  colorMode?: ColorMode;
  printedBackground?: string | null;
  /** Monotone ink is a preview/order choice; conventional Gerber carries geometry only. */
  inkColor?: string;
  crop?: ImageCrop;
  placement?: ArtPlacement;
  style: ArtStyle;
  widthMm: number;
  heightMm: number;
  color: BoardColor;
  outline: OutlineKind;
  /** Dark source pixels become ink when false (default). */
  invert?: boolean;
  minFeatureMm?: number;
  /** Grid pitch for dots/lines/poster cells. Auto when omitted. */
  pitchMm?: number;
  /** Poster cutoff, 0–1, darkness above this becomes ink. Default 0.5. */
  threshold?: number;
  marginMm?: number;
  layers?: readonly ArtLayer[];
  /** Solid copper under the soldermask so the zip is a real 2-layer board. Default true. */
  fillCopper?: boolean;
};

export type ResolvedArtOptions = {
  colorMode: ColorMode;
  printedBackground: string | null;
  inkColor: string;
  crop: ImageCrop;
  placement?: ArtPlacement;
  style: ArtStyle;
  widthMm: number;
  heightMm: number;
  color: BoardColor;
  outline: OutlineKind;
  invert: boolean;
  minFeatureMm: number;
  pitchMm: number;
  threshold: number;
  marginMm: number;
  layers: readonly ArtLayer[];
  fillCopper: boolean;
};

export type BoardArt = {
  options: ResolvedArtOptions;
  primitives: Primitive[];
  /** Same primitives, already clipped to the board outline. */
  clipped: Primitive[];
};

export type GerberFile = { name: string; body: string };

export type BoardFinish = {
  mask: string;
  silk: string;
  copper: string;
  fr4: string;
};

export const BOARD_FINISH: Record<BoardColor, BoardFinish> = {
  green: { mask: "#2f6b3a", silk: "#f4efd8", copper: "#c4a35a", fr4: "#c9b56a" },
  black: { mask: "#1a1a1a", silk: "#f4efd8", copper: "#c4a35a", fr4: "#c9b56a" },
  blue: { mask: "#1d3f7a", silk: "#f4efd8", copper: "#c4a35a", fr4: "#c9b56a" },
  red: { mask: "#8b1e1e", silk: "#f4efd8", copper: "#c4a35a", fr4: "#c9b56a" },
  purple: { mask: "#4a2a6b", silk: "#f4efd8", copper: "#c4a35a", fr4: "#c9b56a" },
  white: { mask: "#e8e4d8", silk: "#1a1a1a", copper: "#c4a35a", fr4: "#c9b56a" },
  yellow: { mask: "#d6b83a", silk: "#1a1a1a", copper: "#c4a35a", fr4: "#c9b56a" },
};

export function resolveArtOptions(raw: ArtOptions): ResolvedArtOptions {
  const widthMm = finitePositive(raw.widthMm, "widthMm");
  const heightMm = finitePositive(raw.heightMm, "heightMm");
  const minFeatureMm = Math.max(MIN_FEATURE_MM, raw.minFeatureMm ?? DEFAULT_FEATURE_MM);
  const marginMm = Math.max(0, raw.marginMm ?? DEFAULT_MARGIN_MM);
  const usable = Math.min(widthMm, heightMm) - 2 * marginMm;
  if (usable <= minFeatureMm)
    throw new Error("board is too small for the margin and minimum feature size");
  const pitchMm = Math.max(minFeatureMm, raw.pitchMm ?? Math.max(minFeatureMm, usable / 90));
  const layers = raw.layers && raw.layers.length > 0 ? raw.layers : (["silk"] as const);
  const colorMode = raw.colorMode ?? "monotone";
  if (!COLOR_MODES.includes(colorMode)) throw new Error("Unknown artwork color mode");
  if (colorMode === "multicolor" && raw.layers?.some((l) => l !== "silk"))
    throw new Error(
      "Multicolor artwork supports printed silkscreen only, not copper or mask openings.",
    );
  return {
    colorMode,
    printedBackground: raw.printedBackground == null ? null : normalizeHex(raw.printedBackground),
    inkColor: normalizeHex(raw.inkColor ?? BOARD_FINISH[raw.color].silk),
    ...(raw.placement ? { placement: validateArtPlacement(raw.placement) } : {}),
    crop: raw.crop ?? "none",
    style: raw.style,
    widthMm,
    heightMm,
    color: colorMode === "multicolor" ? "white" : raw.color,
    outline: raw.outline,
    invert: raw.invert === true,
    minFeatureMm,
    pitchMm,
    threshold: clamp01(raw.threshold ?? 0.5),
    marginMm,
    layers,
    fillCopper: raw.fillCopper !== false,
  };
}

function finitePositive(n: number, name: string): number {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
