import type { BoardConstructionId, BoardMaterialId } from "@fabdesk/protocol";
import { BOARD_MATERIAL_SUMMARIES, boardMaterialSummary } from "@fabdesk/protocol";
import { differentialWidthMm, firstCopperMm, firstDielectric, microstripWidthMm, round3 } from "./impedance";
import type { MaterialConstruction, MaterialPreset, MaterialRules, StackupLayer } from "./types";

function copper(name: string, thicknessMm: number): StackupLayer {
  return { kind: "copper", name, thicknessMm, copperName: name };
}

function dielectric(
  name: string,
  thicknessMm: number,
  material: string,
  er: number,
  tand: number,
  kind: NonNullable<StackupLayer["dielectric"]> = "core",
): StackupLayer {
  return { kind: "dielectric", name, thicknessMm, material, er, tand, dielectric: kind };
}

function mask(name: string, color: string, thicknessMm = 0.01): StackupLayer {
  return { kind: "soldermask", name, thicknessMm, color, material: "Soldermask" };
}

function silk(name: string, color: string): StackupLayer {
  return { kind: "silkscreen", name, thicknessMm: 0.01, color };
}

function paste(name: string): StackupLayer {
  return { kind: "paste", name, thicknessMm: 0.03 };
}

function coverlay(name: string, thicknessMm = 0.025): StackupLayer {
  return {
    kind: "coverlay",
    name,
    thicknessMm,
    material: "Polyimide coverlay",
    er: 3.4,
    tand: 0.002,
    color: "Amber",
    dielectric: "coverlay",
  };
}

function impedanceFor(layers: StackupLayer[], copperName = "F.Cu") {
  const d = firstDielectric(layers);
  const t = firstCopperMm(layers);
  const w50 = round3(microstripWidthMm({ z0: 50, er: d.er, heightMm: d.heightMm, copperMm: t }));
  const d90 = differentialWidthMm({ zDiff: 90, er: d.er, heightMm: d.heightMm, copperMm: t });
  const d100 = differentialWidthMm({ zDiff: 100, er: d.er, heightMm: d.heightMm, copperMm: t });
  return {
    single50: { z0: 50, widthMm: w50, layer: copperName },
    diff90: { z0: 90, widthMm: d90.widthMm, gapMm: d90.gapMm, layer: copperName },
    diff100: { z0: 100, widthMm: d100.widthMm, gapMm: d100.gapMm, layer: copperName },
  };
}

function construction(
  id: BoardConstructionId,
  label: string,
  layers: StackupLayer[],
  rules: MaterialRules,
): MaterialConstruction {
  const copperLayers = layers.filter((l) => l.kind === "copper").length;
  const thicknessMm = round3(layers.reduce((n, l) => n + l.thicknessMm, 0));
  return { id, label, copperLayers, thicknessMm, layers, rules, impedance: impedanceFor(layers) };
}

const FR4_2L_RULES: MaterialRules = {
  traceWidthMm: 0.15,
  clearanceMm: 0.15,
  viaDiameterMm: 0.6,
  viaDrillMm: 0.3,
  annularRingMm: 0.15,
  allowPth: true,
  allowBacksideSmd: true,
  viaPolicy: "through",
  teardrops: false,
  hatchedPours: false,
};

const FR4_4L_RULES: MaterialRules = { ...FR4_2L_RULES, traceWidthMm: 0.127, clearanceMm: 0.127 };

const FLEX_RULES: MaterialRules = {
  traceWidthMm: 0.1,
  clearanceMm: 0.1,
  viaDiameterMm: 0.45,
  viaDrillMm: 0.2,
  annularRingMm: 0.125,
  allowPth: true,
  allowBacksideSmd: true,
  viaPolicy: "through",
  teardrops: true,
  hatchedPours: true,
  minBendRadiusMm: 1.2,
};

const METAL_RULES: MaterialRules = {
  traceWidthMm: 0.2,
  clearanceMm: 0.2,
  viaDiameterMm: 0.8,
  viaDrillMm: 0.4,
  annularRingMm: 0.2,
  allowPth: false,
  allowBacksideSmd: false,
  viaPolicy: "none",
  teardrops: false,
  hatchedPours: false,
};

const RF_RULES: MaterialRules = {
  traceWidthMm: 0.15,
  clearanceMm: 0.15,
  viaDiameterMm: 0.5,
  viaDrillMm: 0.25,
  annularRingMm: 0.125,
  allowPth: true,
  allowBacksideSmd: true,
  viaPolicy: "through",
  teardrops: true,
  hatchedPours: false,
};

const PTFE_RULES: MaterialRules = { ...RF_RULES, traceWidthMm: 0.1, clearanceMm: 0.1 };

const HDI_RULES: MaterialRules = {
  traceWidthMm: 0.075,
  clearanceMm: 0.075,
  viaDiameterMm: 0.45,
  viaDrillMm: 0.2,
  annularRingMm: 0.1,
  microviaDrillMm: 0.1,
  microviaDiameterMm: 0.25,
  allowPth: true,
  allowBacksideSmd: true,
  viaPolicy: "microvia",
  teardrops: true,
  hatchedPours: false,
};

const fr4_2l = construction(
  "2l",
  "2-layer FR-4, 1.6 mm",
  [
    silk("F.SilkS", "White"),
    paste("F.Paste"),
    mask("F.Mask", "Green"),
    copper("F.Cu", 0.035),
    dielectric("dielectric 1", 1.51, "FR4", 4.5, 0.02, "core"),
    copper("B.Cu", 0.035),
    mask("B.Mask", "Green"),
    paste("B.Paste"),
    silk("B.SilkS", "White"),
  ],
  FR4_2L_RULES,
);

const fr4_4l = construction(
  "4l",
  "4-layer FR-4, 1.6 mm",
  [
    silk("F.SilkS", "White"),
    paste("F.Paste"),
    mask("F.Mask", "Green"),
    copper("F.Cu", 0.035),
    dielectric("dielectric 1", 0.2, "FR4", 4.5, 0.02, "prepreg"),
    copper("In1.Cu", 0.035),
    dielectric("dielectric 2", 1.065, "FR4", 4.5, 0.02, "core"),
    copper("In2.Cu", 0.035),
    dielectric("dielectric 3", 0.2, "FR4", 4.5, 0.02, "prepreg"),
    copper("B.Cu", 0.035),
    mask("B.Mask", "Green"),
    paste("B.Paste"),
    silk("B.SilkS", "White"),
  ],
  FR4_4L_RULES,
);

const fr4_6l = construction(
  "6l",
  "6-layer FR-4, 1.6 mm",
  [
    silk("F.SilkS", "White"),
    paste("F.Paste"),
    mask("F.Mask", "Green"),
    copper("F.Cu", 0.035),
    dielectric("dielectric 1", 0.15, "FR4", 4.5, 0.02, "prepreg"),
    copper("In1.Cu", 0.035),
    dielectric("dielectric 2", 0.2, "FR4", 4.5, 0.02, "core"),
    copper("In2.Cu", 0.035),
    dielectric("dielectric 3", 0.51, "FR4", 4.5, 0.02, "prepreg"),
    copper("In3.Cu", 0.035),
    dielectric("dielectric 4", 0.2, "FR4", 4.5, 0.02, "core"),
    copper("In4.Cu", 0.035),
    dielectric("dielectric 5", 0.15, "FR4", 4.5, 0.02, "prepreg"),
    copper("B.Cu", 0.035),
    mask("B.Mask", "Green"),
    paste("B.Paste"),
    silk("B.SilkS", "White"),
  ],
  { ...FR4_4L_RULES, traceWidthMm: 0.1, clearanceMm: 0.1 },
);

const flex_1l = construction(
  "1l",
  "1-layer polyimide flex",
  [
    coverlay("F.Coverlay"),
    copper("F.Cu", 0.018),
    dielectric("polyimide core", 0.05, "Polyimide", 3.4, 0.002, "core"),
    {
      kind: "stiffener",
      name: "Stiffener",
      thicknessMm: 0.2,
      material: "FR4 stiffener (optional, connector areas)",
      annotation: "User.2",
    },
  ],
  { ...FLEX_RULES, allowBacksideSmd: false, viaPolicy: "none" },
);

const flex_2l = construction(
  "2l",
  "2-layer polyimide flex",
  [
    coverlay("F.Coverlay"),
    copper("F.Cu", 0.018),
    dielectric("polyimide core", 0.05, "Polyimide", 3.4, 0.002, "core"),
    copper("B.Cu", 0.018),
    coverlay("B.Coverlay"),
    {
      kind: "stiffener",
      name: "Stiffener",
      thicknessMm: 0.2,
      material: "FR4 stiffener (optional, connector areas)",
      annotation: "User.2",
    },
  ],
  FLEX_RULES,
);

const aluminium_1l = construction(
  "1l",
  "Single-sided aluminium MCPCB",
  [
    silk("F.SilkS", "Black"),
    paste("F.Paste"),
    mask("F.Mask", "White"),
    copper("F.Cu", 0.035),
    dielectric("thermal dielectric", 0.1, "Thermal dielectric", 8.0, 0.02, "thermal"),
    {
      kind: "metal_base",
      name: "Aluminium base",
      thicknessMm: 1.5,
      material: "Aluminium 5052",
      color: "Silver",
      annotation: "User.1",
    },
  ],
  METAL_RULES,
);

const copper_core_1l = construction(
  "1l",
  "Copper-core direct heatsink",
  [
    silk("F.SilkS", "White"),
    paste("F.Paste"),
    mask("F.Mask", "Black"),
    copper("F.Cu", 0.07),
    dielectric("thermal dielectric", 0.075, "Thermal dielectric", 6.5, 0.02, "thermal"),
    {
      kind: "metal_base",
      name: "Copper base",
      thicknessMm: 1.0,
      material: "Copper C110",
      color: "Copper",
      annotation: "User.1 pedestal",
    },
  ],
  { ...METAL_RULES, viaPolicy: "isolated_npth" },
);

const rogers_2l = construction(
  "2l",
  "RO4350B-class 0.508 mm",
  [
    silk("F.SilkS", "White"),
    paste("F.Paste"),
    mask("F.Mask", "Green"),
    copper("F.Cu", 0.035),
    dielectric("RO4350B", 0.508, "RO4350B", 3.48, 0.0037, "core"),
    copper("B.Cu", 0.035),
    mask("B.Mask", "Green"),
    paste("B.Paste"),
    silk("B.SilkS", "White"),
  ],
  RF_RULES,
);

const rogers_hybrid = construction(
  "hybrid",
  "Hybrid RO4350B + FR-4",
  [
    silk("F.SilkS", "White"),
    paste("F.Paste"),
    mask("F.Mask", "Green"),
    copper("F.Cu", 0.035),
    dielectric("RO4350B", 0.254, "RO4350B", 3.48, 0.0037, "core"),
    copper("In1.Cu", 0.035),
    dielectric("FR4 core", 0.71, "FR4", 4.5, 0.02, "core"),
    copper("In2.Cu", 0.035),
    dielectric("FR4 prepreg", 0.2, "FR4", 4.5, 0.02, "prepreg"),
    copper("B.Cu", 0.035),
    mask("B.Mask", "Green"),
    paste("B.Paste"),
    silk("B.SilkS", "White"),
  ],
  RF_RULES,
);

const ptfe_2l = construction(
  "2l",
  "PTFE 0.254 mm",
  [
    silk("F.SilkS", "Black"),
    paste("F.Paste"),
    copper("F.Cu", 0.0175),
    dielectric("RT/duroid-class", 0.254, "PTFE", 2.2, 0.0009, "core"),
    copper("B.Cu", 0.0175),
    silk("B.SilkS", "Black"),
  ],
  PTFE_RULES,
);

const hdi_6l = construction(
  "6l",
  "6-layer HDI FR-4 with laser microvias",
  [
    silk("F.SilkS", "White"),
    paste("F.Paste"),
    mask("F.Mask", "Green"),
    copper("F.Cu", 0.018),
    dielectric("dielectric 1", 0.08, "FR4", 4.3, 0.02, "prepreg"),
    copper("In1.Cu", 0.018),
    dielectric("dielectric 2", 0.15, "FR4", 4.3, 0.02, "core"),
    copper("In2.Cu", 0.035),
    dielectric("dielectric 3", 0.3, "FR4", 4.3, 0.02, "prepreg"),
    copper("In3.Cu", 0.035),
    dielectric("dielectric 4", 0.15, "FR4", 4.3, 0.02, "core"),
    copper("In4.Cu", 0.018),
    dielectric("dielectric 5", 0.08, "FR4", 4.3, 0.02, "prepreg"),
    copper("B.Cu", 0.018),
    mask("B.Mask", "Green"),
    paste("B.Paste"),
    silk("B.SilkS", "White"),
  ],
  HDI_RULES,
);

export const MATERIAL_PRESETS: Record<BoardMaterialId, MaterialPreset> = {
  fr4: {
    id: "fr4",
    defaultConstruction: "2l",
    constructions: { "2l": fr4_2l, "4l": fr4_4l, "6l": fr4_6l },
    fabNotes: [
      "Standard FR-4, 1 oz outer copper, ENIG finish, green soldermask.",
      "Through-hole vias allowed. Controlled impedance uses εr 4.5 unless the stackup is edited.",
    ],
    userLayers: [],
  },
  flex: {
    id: "flex",
    defaultConstruction: "2l",
    constructions: { "1l": flex_1l, "2l": flex_2l },
    fabNotes: [
      "Polyimide core with coverlay (not liquid soldermask) on the copper faces.",
      "Optional FR-4 stiffeners on connector and part areas (User.2).",
      "Bend zones: no vias or pads. Use curved or teardropped traces and hatched pours.",
      "Minimum bend radius is 6–10× the finished flex thickness; default note 1.2 mm for the 2-layer stack.",
    ],
    userLayers: [
      { name: "User.1", purpose: "Coverlay outline" },
      { name: "User.2", purpose: "Stiffener" },
      { name: "User.3", purpose: "Bend zone" },
    ],
  },
  aluminium: {
    id: "aluminium",
    defaultConstruction: "1l",
    constructions: { "1l": aluminium_1l },
    fabNotes: [
      "Single copper layer on a thermal dielectric over an aluminium base.",
      "Single-sided placement only. No plated through-holes unless the fab isolates them from the plate.",
      "Tie LED and power thermal pads to large copper pours on F.Cu. The aluminium plate is the heatsink.",
    ],
    userLayers: [{ name: "User.1", purpose: "Aluminium base" }],
  },
  copper_core: {
    id: "copper_core",
    defaultConstruction: "1l",
    constructions: { "1l": copper_core_1l },
    fabNotes: [
      "Direct-heatsink copper core: thermal pads of power parts are pedestal pads into the copper base.",
      "Mark pedestal pads in fabdesk.json board.pedestalPads (reference + pad number).",
      "No plated through-holes into the copper plate unless isolated.",
    ],
    userLayers: [{ name: "User.1", purpose: "Copper base / pedestal" }],
  },
  rogers: {
    id: "rogers",
    defaultConstruction: "2l",
    constructions: { "2l": rogers_2l, hybrid: rogers_hybrid },
    fabNotes: [
      "RO4350B-class hydrocarbon laminate. Dk 3.48, Df 0.0037 at 10 GHz.",
      "50 Ω / 90–100 Ω differential widths are computed from this Dk and core thickness.",
      "Hybrid construction keeps RF on the Rogers face and digital on FR-4 inners.",
    ],
    userLayers: [],
  },
  ptfe: {
    id: "ptfe",
    defaultConstruction: "2l",
    constructions: { "2l": ptfe_2l },
    fabNotes: [
      "RT/duroid-class PTFE. Dk 2.2, Df 0.0009. For 24 GHz and similar millimetre-wave work.",
      "Etch tolerance is tighter than FR-4; call out ±0.02 mm on RF traces.",
      "Many houses need a PTFE process — do not send this as a standard FR-4 job.",
    ],
    userLayers: [],
  },
  hdi: {
    id: "hdi",
    defaultConstruction: "6l",
    constructions: { "6l": hdi_6l },
    fabNotes: [
      "6-layer HDI FR-4: laser microvias 0.10 mm drill / 0.25 mm pad, via-in-pad allowed.",
      "Blind vias F.Cu–In1.Cu and B.Cu–In4.Cu; buried vias In1–In4.",
      "Fine-pitch BGA fanout: 0.075 mm track/space on the outer layers.",
    ],
    userLayers: [],
  },
};

export function listMaterialPresets() {
  return BOARD_MATERIAL_SUMMARIES.map((summary) => {
    const preset = MATERIAL_PRESETS[summary.id];
    return {
      ...summary,
      constructions: summary.constructions.map((id) => {
        const c = preset.constructions[id];
        return {
          id,
          label: c?.label ?? id,
          copperLayers: c?.copperLayers ?? 0,
          thicknessMm: c?.thicknessMm ?? 0,
        };
      }),
    };
  });
}

export function resolveConstruction(
  material: BoardMaterialId,
  construction?: BoardConstructionId,
): MaterialConstruction {
  const preset = MATERIAL_PRESETS[material];
  const id = construction && preset.constructions[construction] ? construction : preset.defaultConstruction;
  const found = preset.constructions[id];
  if (!found) throw new Error(`material ${material} has no construction ${id}`);
  return found;
}

export function validateMaterialChoice(
  material: BoardMaterialId,
  construction?: BoardConstructionId,
  layers?: number,
): { ok: true; construction: BoardConstructionId } | { ok: false; error: string } {
  const summary = boardMaterialSummary(material);
  const preset = MATERIAL_PRESETS[material];
  const id = construction ?? preset.defaultConstruction;
  if (!preset.constructions[id]) {
    return {
      ok: false,
      error: `${summary.name} does not have construction "${id}". Use ${summary.constructions.join(", ")}.`,
    };
  }
  if (layers !== undefined) {
    const expected = preset.constructions[id]!.copperLayers;
    if (layers !== expected) {
      return {
        ok: false,
        error: `${summary.name} / ${id} is a ${expected}-layer stackup; requested ${layers} copper layers.`,
      };
    }
  }
  return { ok: true, construction: id };
}

export function copperLayerNames(count: number): string[] {
  if (count <= 1) return ["F.Cu"];
  const inner = Math.max(0, count - 2);
  const names = ["F.Cu"];
  for (let i = 1; i <= inner; i++) names.push(`In${i}.Cu`);
  names.push("B.Cu");
  return names;
}
