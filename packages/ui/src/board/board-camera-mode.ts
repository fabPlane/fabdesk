import type { OrthographicCamera, Vector3 } from "three";

export type BoardCameraMode = { mode: "2d" | "3d"; side: "top" | "bottom" };

/** Entering 3D only unlocks orbit. Keep the same projection, framing and camera pose. */
export function alignBoardCamera(camera: OrthographicCamera, target: Vector3, next: BoardCameraMode, previous: BoardCameraMode | null) {
  if (previous && (next.mode === "3d" || previous.mode === "2d" && previous.side === next.side)) return;
  const distance = camera.position.distanceTo(target);
  camera.up.set(0, 0, -1);
  camera.position.copy(target);
  camera.position.y += next.side === "bottom" ? -distance : distance;
}
