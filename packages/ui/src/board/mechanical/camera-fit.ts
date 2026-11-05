import { Box3, MathUtils, Quaternion, Vector3 } from "three";

/** Keep depth precision around the assembly instead of a nearly infinite scene. */
export function assemblyClipRange(box: Box3, position: Vector3, orientation: Quaternion) {
  if (box.isEmpty()) return { near: 0.01, far: 1000 };
  const inverse = orientation.clone().invert();
  const padding = Math.max(1, box.getSize(new Vector3()).length() * 0.05);
  let closest = Infinity,
    farthest = -Infinity;
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const depth = -new Vector3(x, y, z).sub(position).applyQuaternion(inverse).z;
        closest = Math.min(closest, depth);
        farthest = Math.max(farthest, depth);
      }
  const near = Math.max(0.01, closest - padding);
  return { near, far: Math.max(near + 1, farthest + padding) };
}

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
