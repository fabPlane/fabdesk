import type { OpeningShape } from "./opening-profile";
/** A port's visible face is separate from its pads/courtyard collision envelope. */
export type ConnectorFace = {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  heightMm: number;
  centerZ: number;
  source:
    | "fabrication-outline"
    | "GCT USB4105 drawing"
    | "Hirose DM3D-SF drawing"
    | "PCB Height property";
};

export const DEFAULT_OPENING_CLEARANCE = 0.4;

/** Two opposing surfaces may each consume their stated dimensional allowance. */
export function enclosureOpeningClearance(d: {
  openingClearance?: number | undefined;
  fitAllowance?: number | undefined;
}) {
  return (d.openingClearance ?? DEFAULT_OPENING_CLEARANCE) + 2 * (d.fitAllowance ?? 0);
}

export function connectorOpening(
  connector: {
    edge: "minX" | "maxX" | "minY" | "maxY";
    x: number;
    y: number;
    widthMm: number;
    heightMm: number;
    bounds?: ConnectorFace["bounds"];
    face?: ConnectorFace;
    footprint?: string;
  },
  edge = connector.edge,
  override?: { width: number; height: number; shape?: OpeningShape | undefined },
) {
  const face = connector.face;
  const r = face?.bounds ?? connector.bounds;
  return {
    x: r ? (r.minX + r.maxX) / 2 : connector.x,
    y: r ? (r.minY + r.maxY) / 2 : connector.y,
    width:
      override?.width ??
      (r
        ? edge === "minX" || edge === "maxX"
          ? r.maxY - r.minY
          : r.maxX - r.minX
        : connector.widthMm),
    height: override?.height ?? face?.heightMm ?? connector.heightMm,
    centerZ: face?.centerZ ?? connector.heightMm / 2,
    shape:
      override?.shape ??
      ((/usb[_ -]?c(?:_|\b)/i.test(connector.footprint ?? "")
        ? "rounded"
        : "rectangle") as OpeningShape),
    source: override ? "Custom measurement" : (face?.source ?? "Estimated footprint bounds"),
  };
}
