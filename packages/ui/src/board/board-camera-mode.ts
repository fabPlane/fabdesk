import type { OrthographicCamera, Vector3 } from "three";

export type BoardCameraMode = { mode: "2d" | "3d"; side: "top" | "bottom"; revision?: number };
export type SavedBoardCamera = { camera: OrthographicCamera; target: Vector3; view: BoardCameraMode };

/** Restore the actual board camera, including zoom/frustum, before applying a
 * newly requested side or mode. Replacing geometry must not reset an orbit. */
export function restoreBoardCamera(camera: OrthographicCamera, target: Vector3, saved: SavedBoardCamera) {
  camera.copy(saved.camera);
  target.copy(saved.target);
}

/** Entering 3D only unlocks orbit. Keep the same projection, framing and camera pose. */
export function alignBoardCamera(camera: OrthographicCamera, target: Vector3, next: BoardCameraMode, previous: BoardCameraMode | null) {
  if (previous && previous.side === next.side && previous.revision === next.revision && (next.mode === "3d" || previous.mode === "2d")) return;
  const distance = camera.position.distanceTo(target);
  camera.up.set(0, 0, -1);
  camera.position.copy(target);
  camera.position.y += next.side === "bottom" ? -distance : distance;
}
