/** The board's own definition of done: what onboarding derives and the acceptance checks read. */

export interface PowerClass {
  source_class: string;
  track_width: number;
  /** null: no inner-layer width is defined, so inner copper below the class width always fails. */
  inner_track_width: number | null;
  nets: string[];
  current_max_A?: number;
  /** 0: strict inner necks (every inner segment below inner_track_width fails A7, no neck allowance, no tap). */
  inner_neck_allowance_mm?: number;
  basis?: string;
}

export interface PairClass {
  source_class: string;
  track_width: number;
  diff_pair_width: number;
  diff_pair_gap: number;
  layers: string[];
  escape_layers: string[];
  escape_allowance_mm: number;
  inner_stray_mm: number;
  pairs: Array<[string, string]>;
  intra_pair_skew_max_mm: number;
  min_coupled_share: number;
  coupling_applies_from_mm: number;
  neck_min_width_ratio: number;
  neck_max_mm: number;
  basis?: string;
}

export interface ImpedanceClass {
  source_class: string;
  track_width: number;
  nets: string[];
  basis?: string;
}

export type NetClassSpec = Partial<PowerClass> & Partial<PairClass> & Partial<ImpedanceClass>;

export interface TapPad {
  width: number;
  basis: string;
}

export interface Acceptance {
  schema: string;
  status: string;
  purpose: string;
  authority: { circuit: string; mechanical: string; heights: string };
  heights: { F_max_mm: number; B_max_mm: number; basis?: string };
  manufacturing_rules: {
    adopted: {
      min_track_width: number;
      min_clearance: number;
      default_class: { track_width: number; clearance: number; via_diameter: number; via_drill: number };
    };
    scoped_rules: unknown[];
    basis: string;
    native_project_rules: boolean;
    native_project_rules_basis: string;
  };
  stack_policy: {
    copper_layers: string[];
    plane_layers: string[];
    no_track_layers?: string[];
    ground_net: string;
    /** `{ through: ["F.Cu","B.Cu"] }` or `{ blind: [["In1.Cu","In4.Cu"], ...] }`. */
    via_spans: Record<string, string[] | string[][]>;
  };
  net_classes: {
    tap_rule: string;
    /** net -> { "REF.PAD": { width, basis } }; a `_format` key may be present. */
    tap_pads: Record<string, Record<string, TapPad> | string>;
    neck_allowance: string;
    neck_scaling?: { cap_mm: number; ref_width_mm: number; ref_current_A: number };
    /** Net -> expected current in amps (read by the neck rule and the review stage). */
    net_current_A?: Record<string, number>;
    class_clearance: number;
    router_width_rules: { neck_floor_mm: number };
    classes: Record<string, NetClassSpec>;
  };
  /**
   * Courtyard overlaps accepted by name (A2 and the review's drc check): each entry names exactly two footprints in
   * `refs` and records the measured copper/body gaps and the basis; any other overlap still counts.
   */
  courtyard_overlap_exceptions?: Array<{ refs: string[]; [extra: string]: unknown }>;
  /** Names of nets whose value differences are accepted (A4). */
  value_exceptions?: string[];
  automatic_checks?: Record<string, string>;
  /**
   * Last-mile bench settings. `inherited_drc`: DRC classes this board carries on every candidate whatever is routed
   * (e.g. the R1N/C6 carrier's USB-C shell pads give `hole_clearance`); the bench's gate leaves them out of the DRC
   * count and never calls them a new class. Absent or empty: every DRC class counts.
   */
  lastmile?: { inherited_drc?: string[] };
  [extra: string]: unknown;
}

export interface CircuitRequirement {
  components: Array<{ reference: string; value: string | null; pins: Record<string, string> }>;
  basis: string;
}

export interface MechanicalRequirement {
  units: string;
  anchors: Array<{ reference: string; at: [string, string]; rotation: [string]; layer: string }>;
  basis: string;
}

export interface HeightsRequirement {
  entries: Array<{ ref: string; height_above_surface_mm?: number | null }>;
  basis: string;
}

export interface Requirements {
  acceptance: Acceptance;
  circuit: CircuitRequirement;
  mechanical: MechanicalRequirement;
  heights: HeightsRequirement;
}

export const REQUIREMENT_FILES = {
  acceptance: "acceptance.json",
  circuit: "circuit.json",
  mechanical: "mechanical.json",
  heights: "heights.json",
} as const;
