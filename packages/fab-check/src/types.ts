/** Verdict for one check or the whole report. */
export type CheckVerdict = "pass" | "warn" | "fail" | "skip";

export type FabId = "jlcpcb" | "pcbway" | "generic";

export type LayerKind =
  | "copper"
  | "mask"
  | "paste"
  | "silk"
  | "outline"
  | "drill"
  | "other";

export type LayerSide = "top" | "bottom" | "inner" | "both" | "none";

export type Point = { x: number; y: number };

export type Rect = { minX: number; minY: number; maxX: number; maxY: number };

export type FabRules = {
  fab: FabId;
  label: string;
  minTraceMm: number;
  minSpacingMm: number;
  minSilkWidthMm: number;
  minSilkTextMm: number;
  minHoleMm: number;
  /** Degrees added to the design rotation before comparing pick-and-place. */
  rotationOffsetDeg: number;
  /** Archive paths the fab quote form expects (globs, posix). */
  zipLayout: string[];
};

export type ClassifiedFile = {
  name: string;
  kind: LayerKind;
  side: LayerSide;
  /** Copper index, 1-based from the top, when kind is copper. */
  copperIndex?: number;
  body: string;
  bytes: Uint8Array;
};

export type PackageFile = {
  name: string;
  bytes: Uint8Array;
};

export type DesignPart = {
  ref: string;
  value: string;
  footprint: string;
  x: number;
  y: number;
  rotationDeg: number;
  side: "top" | "bottom";
  dnp: boolean;
};

export type DesignSnapshot = {
  pcbText?: string;
  pcbRevision?: string;
  outline?: Rect & { widthMm: number; heightMm: number; closed: boolean };
  copperLayers?: number;
  parts?: DesignPart[];
  bomCsv?: string;
  posCsv?: string;
  drc?: { errors: number; warnings: number; stale?: boolean };
};

export type FabCheckFinding = {
  id: string;
  check: string;
  severity: "warn" | "fail";
  message: string;
  x?: number;
  y?: number;
  layer?: string;
  ref?: string;
};

export type FabCheckSection = {
  id: string;
  title: string;
  verdict: CheckVerdict;
  summary: string;
  findings: FabCheckFinding[];
};

export type LayerRender = {
  layer: string;
  kind: LayerKind;
  side: LayerSide;
  svg: string;
  pngPath: string;
  svgPath: string;
  /** Gerber millimetre bounds of the written PNG, for overlaying findings. */
  bounds?: Rect;
};

export type FabCheckReport = {
  version: 1;
  createdAt: string;
  overall: "pass" | "warn" | "fail";
  fab: FabId;
  rules: FabRules;
  packageHash: string;
  source: string;
  layerCount: number;
  files: string[];
  checks: FabCheckSection[];
  findings: FabCheckFinding[];
  layers: Array<{
    name: string;
    kind: LayerKind;
    side: LayerSide;
    unit: "mm" | "in" | null;
    ops: number;
  }>;
  renders: LayerRender[];
  notes: string[];
};

export type CheckOptions = {
  fab?: FabId;
  minSpacingMm?: number;
  minTraceMm?: number;
  minSilkWidthMm?: number;
  minSilkTextMm?: number;
  design?: DesignSnapshot;
  /** Directory to write PNG/SVG renders into (created by the caller). */
  renderDir?: string;
  /** Project-relative prefix for render paths, default `reports/fab-check/layers`. */
  renderPrefix?: string;
};

export const FAB_CHECK_REPORT_DIR = "reports/fab-check";
export const FAB_CHECK_REPORT_FILE = `${FAB_CHECK_REPORT_DIR}/latest.json`;
export const FAB_CHECK_LAYER_DIR = `${FAB_CHECK_REPORT_DIR}/layers`;
