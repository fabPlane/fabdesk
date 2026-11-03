import {
  connectorOpening,
  enclosureOpeningClearance,
  defaultConnectorAccess,
  type MechanicalDesign,
} from "@fabdesk/protocol";
import type { LayoutBoard } from "./enclosure-layout";

/** Refresh generated openings after moving a board; never rewrite manually sized openings. */
export function refreshEnclosureOpenings(
  design: MechanicalDesign,
  boards: LayoutBoard[],
): MechanicalDesign {
  const edges = ["maxX", "maxY", "minX", "minY"] as const;
  return {
    ...design,
    openings: design.openings.flatMap((o) => {
      if (!o.followBoard || !o.boardPath || !o.ref) return [o];
      const b = boards.find((b) => b.placement.path === o.boardPath);
      const placement = design.boards.find((b) => b.path === o.boardPath);
      const c = b?.features.connectors?.find((c) => c.ref === o.ref);
      if (!b || !c || !placement)
        throw Error(`Reload ${o.name}'s board before updating its port opening.`);
      const access = design.portAccess?.find((p) => p.boardPath === o.boardPath && p.ref === o.ref);
      if ((access?.access ?? defaultConnectorAccess(c.footprint ?? "")) === "internal") return [];
      const rotation = ((placement.rotation % 360) + 360) % 360;
      if (rotation % 90 !== 0)
        throw Error(
          `Turn ${o.name}'s board to 0°, 90°, 180° or 270° so its port faces a wall, or use a custom opening.`,
        );
      const edge = access?.face ?? c.edge;
      const wall = edges[(edges.indexOf(edge) + rotation / 90) % 4]!;
      const face = connectorOpening(c, edge, access?.aperture);
      const a = (rotation * Math.PI) / 180;
      const x = placement.x + face.x * Math.cos(a) - face.y * Math.sin(a);
      const y = placement.y + face.x * Math.sin(a) + face.y * Math.cos(a);
      const bottom = b.features.components?.some((p) => p.ref === c.ref && p.bottom);
      const centerZ =
        placement.z + (bottom ? -face.centerZ : b.features.thicknessMm + face.centerZ);
      const padding = enclosureOpeningClearance(design);
      return [
        {
          ...o,
          wall,
          offset: wall.endsWith("X") ? y : x,
          z: centerZ - face.height / 2 - padding,
          width: face.width + 2 * padding,
          height: face.height + 2 * padding,
          shape: face.shape,
        },
      ];
    }),
  };
}
