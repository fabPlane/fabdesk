import type { MechanicalDesign } from "@fabdesk/protocol";
import type { EnclosureBoardSummary } from "./enclosure-design";
export type MountBoard = {
  placement: MechanicalDesign["boards"][number];
  features: EnclosureBoardSummary;
};
export function mountingCandidates(features: EnclosureBoardSummary) {
  return features.holes.filter(
    (h) =>
      h.shape !== "slot" &&
      (h.purpose
        ? h.purpose === "mounting" || h.purpose === "unclassified"
        : !h.ref || !features.components?.some((p) => p.ref === h.ref)),
  );
}
export function mountAtHole(
  board: MountBoard,
  hole: EnclosureBoardSummary["holes"][number],
  floor: number,
): MechanicalDesign["mounts"][number] {
  const a = (board.placement.rotation * Math.PI) / 180;
  return {
    x: board.placement.x + hole.x * Math.cos(a) - hole.y * Math.sin(a),
    y: board.placement.y + hole.x * Math.sin(a) + hole.y * Math.cos(a),
    diameter: hole.diameterMm,
    outer: hole.diameterMm + 2.4,
    height: board.placement.z - floor,
    ...(hole.id ? { boardPath: board.placement.path, holeId: hole.id } : {}),
  };
}
/** Only explicitly linked posts follow board movement. User-entered posts remain untouched. */
export function alignEnclosureMounts(
  design: MechanicalDesign,
  boards: MountBoard[],
): MechanicalDesign {
  return {
    ...design,
    mounts: design.mounts.map((mount) => {
      const board = boards.find((b) => b.placement.path === mount.boardPath);
      const hole = board?.features.holes.find((h) => h.id === mount.holeId);
      if (!board || !hole) return mount;
      const aligned = mountAtHole(board, hole, design.space.floor);
      return { ...mount, x: aligned.x, y: aligned.y, height: aligned.height };
    }),
  };
}
/** Explicit migration for old/manual posts: only a unique measured hole may be linked. */
export function linkEnclosureMounts(
  design: MechanicalDesign,
  boards: MountBoard[],
): MechanicalDesign {
  return {
    ...design,
    mounts: design.mounts.map((mount) => {
      if (mount.boardPath || mount.holeId) return mount;
      const matches = boards.flatMap((board) =>
        mountingCandidates(board.features).flatMap((hole) => {
          const target = mountAtHole(board, hole, design.space.floor);
          return hole.id &&
            mount.diameter <= hole.diameterMm &&
            Math.hypot(target.x - mount.x, target.y - mount.y) < 0.05
            ? [target]
            : [];
        }),
      );
      const match = matches.length === 1 ? matches[0] : undefined;
      return match?.boardPath && match.holeId
        ? { ...mount, boardPath: match.boardPath, holeId: match.holeId }
        : mount;
    }),
  };
}
