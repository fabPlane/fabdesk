import type { RouterId } from "@fabdesk/protocol";

/** The capacity autorouter works in SimpleRouteJson millimetres; frames are posted unscaled. */
export const CAPACITY_UNITS_PER_MM = 1;

/**
 * js_autorouter's SRJ importer writes the design at `resolution = 10 000` units per mm with the
 * board scale factor left at 1 (`srjToDesign` in vendor/js_autorouter, `emptyDesign()`), so board
 * coordinates -- what the cinema capture reports -- are 10 000 per mm. The freerouting adapter
 * checks this against the run's actual `CoordinateTransform` and reports a mismatch in `detail`.
 */
export const FREEROUTING_UNITS_PER_MM = 10_000;

/** Multiply mm by this to get the frame units a router posts (`RouteMeta.unitsPerMm`). */
export function frameUnitsPerMm(router: RouterId): number {
  switch (router) {
    case "capacity":
      return CAPACITY_UNITS_PER_MM;
    case "freerouting":
      return FREEROUTING_UNITS_PER_MM;
  }
}

/** tscircuit's layer names for a stack of `layerCount` copper layers: top, inner1..N, bottom. */
export function srjLayerNames(layerCount: number): string[] {
  if (layerCount <= 1) {
    return ["top"];
  }
  const names = ["top"];
  for (let i = 1; i <= layerCount - 2; i += 1) {
    names.push(`inner${i}`);
  }
  names.push("bottom");
  return names;
}
