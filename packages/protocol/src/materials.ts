/** First-class board laminate / construction presets stored on `fabdesk.json` `board.material`. */
import { z } from "zod/v4";

export const BOARD_MATERIAL_IDS = [
  "fr4",
  "flex",
  "aluminium",
  "copper_core",
  "rogers",
  "ptfe",
  "hdi",
] as const;
export type BoardMaterialId = (typeof BOARD_MATERIAL_IDS)[number];
export const BoardMaterialId = z.enum(BOARD_MATERIAL_IDS);

export const BOARD_CONSTRUCTION_IDS = ["1l", "2l", "4l", "6l", "hybrid"] as const;
export type BoardConstructionId = (typeof BOARD_CONSTRUCTION_IDS)[number];
export const BoardConstructionId = z.enum(BOARD_CONSTRUCTION_IDS);

export const RectMm = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});
export type RectMm = z.infer<typeof RectMm>;

export const PedestalPad = z.object({
  ref: z.string().min(1),
  pad: z.string().min(1),
});
export type PedestalPad = z.infer<typeof PedestalPad>;

export type BoardMaterialAppearance = {
  soldermask: string;
  silkscreen: string;
  /** Substrate / core colour used by 3D and cinema previews. */
  substrate: string;
  finish: string;
  look: string;
};

export type BoardMaterialSummary = {
  id: BoardMaterialId;
  name: string;
  shortName: string;
  blurb: string;
  whenToUse: string;
  constructions: readonly BoardConstructionId[];
  defaultConstruction: BoardConstructionId;
  specialistFab: boolean;
  appearance: BoardMaterialAppearance;
};

/** Short copy shared by the desktop picker, agent docs, and MCP list. */
export const BOARD_MATERIAL_SUMMARIES: readonly BoardMaterialSummary[] = [
  {
    id: "fr4",
    name: "FR-4 rigid",
    shortName: "FR-4",
    blurb: "Standard glass-epoxy rigid board. Default when nothing is chosen.",
    whenToUse: "Everyday digital, analog, and power boards that do not need flex, metal-core cooling, or RF laminates.",
    constructions: ["2l", "4l", "6l"],
    defaultConstruction: "2l",
    specialistFab: false,
    appearance: {
      soldermask: "Green",
      silkscreen: "White",
      substrate: "#c4b48a",
      finish: "ENIG",
      look: "Green soldermask on FR-4",
    },
  },
  {
    id: "flex",
    name: "Polyimide flex",
    shortName: "Flex",
    blurb: "Thin polyimide with coverlay. Bends; keep vias and pads out of bend zones.",
    whenToUse: "Wearables, probes, display tails, and anything that must fold or follow a curve.",
    constructions: ["1l", "2l"],
    defaultConstruction: "2l",
    specialistFab: true,
    appearance: {
      soldermask: "None",
      silkscreen: "White",
      substrate: "#d4a017",
      finish: "ENIG",
      look: "Amber polyimide with coverlay",
    },
  },
  {
    id: "aluminium",
    name: "Aluminium metal-core",
    shortName: "Aluminium",
    blurb: "One copper layer on a thermal dielectric over an aluminium plate.",
    whenToUse: "Hot LED tiles and power boards that dump heat into a metal plate. Single-sided; no plated through-holes unless isolated.",
    constructions: ["1l"],
    defaultConstruction: "1l",
    specialistFab: true,
    appearance: {
      soldermask: "White",
      silkscreen: "Black",
      substrate: "#c0c6cc",
      finish: "OSP",
      look: "White mask on silver aluminium",
    },
  },
  {
    id: "copper_core",
    name: "Copper core / direct heatsink",
    shortName: "Copper core",
    blurb: "Thermal pads of power parts sit on copper pedestals into the metal base.",
    whenToUse: "High-power LED engines and converters where the thermal pad must reach the copper plate.",
    constructions: ["1l"],
    defaultConstruction: "1l",
    specialistFab: true,
    appearance: {
      soldermask: "Black",
      silkscreen: "White",
      substrate: "#b87333",
      finish: "ENIG",
      look: "Copper plate with black mask",
    },
  },
  {
    id: "rogers",
    name: "Rogers RO4350B-class",
    shortName: "Rogers",
    blurb: "Low-loss hydrocarbon laminate. Impedance widths use the real Dk and thickness.",
    whenToUse: "Microwave and RF boards from hundreds of MHz through several GHz. Hybrid Rogers + FR-4 is available.",
    constructions: ["2l", "hybrid"],
    defaultConstruction: "2l",
    specialistFab: true,
    appearance: {
      soldermask: "Green",
      silkscreen: "White",
      substrate: "#8b7355",
      finish: "ENIG",
      look: "Low-loss tan laminate",
    },
  },
  {
    id: "ptfe",
    name: "PTFE (RT/duroid-class)",
    shortName: "PTFE",
    blurb: "Very low-loss PTFE for millimetre-wave work. Tight etch tolerance.",
    whenToUse: "24 GHz and similar radar, splitters, and mmWave front-ends.",
    constructions: ["2l"],
    defaultConstruction: "2l",
    specialistFab: true,
    appearance: {
      soldermask: "None",
      silkscreen: "Black",
      substrate: "#f4f1e8",
      finish: "ENIG",
      look: "Off-white PTFE",
    },
  },
  {
    id: "hdi",
    name: "HDI FR-4",
    shortName: "HDI",
    blurb: "Six or more layers with laser microvias, via-in-pad, and blind/buried vias.",
    whenToUse: "Fine-pitch BGA fanout, compact MCU/FPGA sticks, and anything that needs microvias.",
    constructions: ["6l"],
    defaultConstruction: "6l",
    specialistFab: false,
    appearance: {
      soldermask: "Green",
      silkscreen: "White",
      substrate: "#c4b48a",
      finish: "ENIG",
      look: "Thin green HDI FR-4",
    },
  },
];

export const DEFAULT_BOARD_MATERIAL: BoardMaterialId = "fr4";

export function boardMaterialSummary(id: BoardMaterialId): BoardMaterialSummary {
  return BOARD_MATERIAL_SUMMARIES.find((m) => m.id === id) ?? BOARD_MATERIAL_SUMMARIES[0]!;
}

export function resolveBoardMaterial(
  material: BoardMaterialId | undefined,
): BoardMaterialId {
  return material ?? DEFAULT_BOARD_MATERIAL;
}

export function specialistFabNote(id: BoardMaterialId): string | undefined {
  const summary = boardMaterialSummary(id);
  if (!summary.specialistFab) return undefined;
  return `${summary.name} is not a standard FR-4 order. The fabs listed here quote FR-4 boards. Download the fabrication package and send it to a flex, metal-core, or RF house.`;
}

/** Copper-layer count implied by a construction id (hybrid is a 4-layer stack). */
export function layersForConstruction(construction: BoardConstructionId): number {
  if (construction === "1l") return 1;
  if (construction === "4l" || construction === "hybrid") return 4;
  if (construction === "6l") return 6;
  return 2;
}

export const BOARD_MATERIAL_DEFAULT_LAYERS: Record<BoardMaterialId, number> = {
  fr4: 2,
  flex: 2,
  aluminium: 1,
  copper_core: 1,
  rogers: 2,
  ptfe: 2,
  hdi: 6,
};
