import type {
  BoardConstructionId,
  BoardMaterialId,
  BoardRules,
  PedestalPad,
  RectMm,
} from "@fabdesk/protocol";

export type StackupLayerKind =
  | "copper"
  | "dielectric"
  | "soldermask"
  | "silkscreen"
  | "paste"
  | "coverlay"
  | "stiffener"
  | "metal_base";

export type StackupLayer = {
  kind: StackupLayerKind;
  name: string;
  thicknessMm: number;
  material?: string;
  er?: number;
  tand?: number;
  color?: string;
  copperName?: string;
  dielectric?: "core" | "prepreg" | "coverlay" | "thermal" | "other";
  annotation?: string;
};

export type ViaPolicy = "through" | "none" | "microvia" | "isolated_npth";

export type MaterialRules = BoardRules & {
  annularRingMm: number;
  microviaDrillMm?: number;
  microviaDiameterMm?: number;
  allowPth: boolean;
  allowBacksideSmd: boolean;
  viaPolicy: ViaPolicy;
  teardrops: boolean;
  hatchedPours: boolean;
  minBendRadiusMm?: number;
};

export type ImpedanceTarget = {
  z0: number;
  widthMm: number;
  layer: string;
  gapMm?: number;
};

export type MaterialConstruction = {
  id: BoardConstructionId;
  label: string;
  copperLayers: number;
  thicknessMm: number;
  layers: StackupLayer[];
  rules: MaterialRules;
  impedance: {
    single50: ImpedanceTarget;
    diff90: ImpedanceTarget;
    diff100: ImpedanceTarget;
  };
};

export type MaterialPreset = {
  id: BoardMaterialId;
  constructions: Record<string, MaterialConstruction>;
  defaultConstruction: BoardConstructionId;
  fabNotes: string[];
  userLayers: Array<{ name: string; purpose: string }>;
};

export type MaterialSelection = {
  id: BoardMaterialId;
  construction: BoardConstructionId;
  preset: MaterialConstruction;
  explicit: boolean;
};

export type StackupDiffLine = {
  field: string;
  from: string;
  to: string;
};

export type MaterialApplyPlan = {
  material: BoardMaterialId;
  construction: BoardConstructionId;
  copperLayers: number;
  thicknessMm: number;
  rules: MaterialRules;
  stackup: StackupLayer[];
  appearance: { soldermask: string; silkscreen: string; finish: string; substrate: string };
  fabNotes: string[];
  specialistFab: boolean;
  impedance: MaterialConstruction["impedance"];
  userLayers: Array<{ name: string; purpose: string }>;
  bendZones: RectMm[];
  pedestalPads: PedestalPad[];
  diff: StackupDiffLine[];
};

export type MaterialViolationKind =
  | "via_in_bend_zone"
  | "pad_in_bend_zone"
  | "pth_on_metal_core"
  | "backside_on_metal_core"
  | "impedance_width"
  | "missing_pedestal"
  | "via_not_allowed";

export type MaterialViolation = {
  kind: MaterialViolationKind;
  detail: string;
  x?: number;
  y?: number;
  ref?: string;
  net?: string;
};
