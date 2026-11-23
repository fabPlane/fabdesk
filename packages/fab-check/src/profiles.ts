import type { FabId, FabRules } from "./types";

/** Built-in fab rules. Quote-live profiles (open PR) can override these later. */
export const FAB_PROFILES: Record<FabId, FabRules> = {
  generic: {
    fab: "generic",
    label: "Generic (0.15 mm)",
    minTraceMm: 0.15,
    minSpacingMm: 0.15,
    minSilkWidthMm: 0.15,
    minSilkTextMm: 0.8,
    minHoleMm: 0.2,
    rotationOffsetDeg: 0,
    zipLayout: ["*.gbr", "*.drl", "bom.csv", "positions.csv"],
  },
  jlcpcb: {
    fab: "jlcpcb",
    label: "JLCPCB",
    minTraceMm: 0.127,
    minSpacingMm: 0.127,
    minSilkWidthMm: 0.15,
    minSilkTextMm: 0.8,
    minHoleMm: 0.2,
    rotationOffsetDeg: 0,
    zipLayout: ["*.gbr", "*.drl"],
  },
  pcbway: {
    fab: "pcbway",
    label: "PCBWay",
    minTraceMm: 0.15,
    minSpacingMm: 0.15,
    minSilkWidthMm: 0.15,
    minSilkTextMm: 0.8,
    minHoleMm: 0.2,
    rotationOffsetDeg: 0,
    zipLayout: ["*.gbr", "*.drl"],
  },
};

export function resolveRules(
  fab: FabId = "generic",
  overrides: {
    minSpacingMm?: number;
    minTraceMm?: number;
    minSilkWidthMm?: number;
    minSilkTextMm?: number;
  } = {},
): FabRules {
  const base = FAB_PROFILES[fab];
  return {
    ...base,
    minSpacingMm: overrides.minSpacingMm ?? base.minSpacingMm,
    minTraceMm: overrides.minTraceMm ?? base.minTraceMm,
    minSilkWidthMm: overrides.minSilkWidthMm ?? base.minSilkWidthMm,
    minSilkTextMm: overrides.minSilkTextMm ?? base.minSilkTextMm,
  };
}

export function parseFabId(value: string | undefined): FabId {
  if (value === "jlcpcb" || value === "pcbway" || value === "generic") return value;
  return "generic";
}
