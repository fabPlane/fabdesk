import { Box3, MathUtils, Quaternion, Vector3 } from "three";

/** Fit every corner in the current camera orientation, including perspective depth. */
export function fittedCameraDistance(
  box: Box3,
  orientation: Quaternion,
  verticalFov: number,
  aspect: number,
  margin = 1.12,
) {
  const center = box.getCenter(new Vector3());
  const inverse = orientation.clone().invert();
  const tanY = Math.tan(MathUtils.degToRad(verticalFov / 2));
  const tanX = tanY * Math.max(0.01, aspect);
  let distance = 5;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const p = new Vector3(x, y, z).sub(center).applyQuaternion(inverse);
        distance = Math.max(
          distance,
          p.z + margin * Math.max(Math.abs(p.x) / tanX, Math.abs(p.y) / tanY),
        );
      }
  return distance;
}
