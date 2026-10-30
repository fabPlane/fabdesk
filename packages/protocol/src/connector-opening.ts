/** A port's visible face is separate from its pads/courtyard collision envelope. */
export type ConnectorFace = {
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  heightMm: number;
  centerZ: number;
  source: "fabrication-outline" | "GCT USB4105 drawing";
};

export const DEFAULT_OPENING_CLEARANCE = 0.4;

export function connectorOpening(
  connector: {
    edge: "minX" | "maxX" | "minY" | "maxY";
    x: number;
    y: number;
    widthMm: number;
    heightMm: number;
    bounds?: ConnectorFace["bounds"];
    face?: ConnectorFace;
  },
  edge = connector.edge,
  override?: { width: number; height: number },
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
    source: override ? "Custom measurement" : (face?.source ?? "Estimated footprint bounds"),
  };
}
