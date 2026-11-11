type Vector = { x: number; y: number; z: number };
/** Fit the actual bounding-box corners to a perspective viewport; camera transforms never change model placement. */
export function fitModelCamera(size: Vector, verticalFovDegrees: number, aspect: number, fill = .8, viewDirection: Vector = { x: .7, y: .65, z: .85 }) {
  if (![size.x, size.y, size.z, verticalFovDegrees, aspect, fill, viewDirection.x, viewDirection.y, viewDirection.z].every(Number.isFinite) || Math.min(size.x, size.y, size.z) < 0 || Math.max(size.x, size.y, size.z) <= 0 || verticalFovDegrees <= 0 || verticalFovDegrees >= 180 || aspect <= 0 || fill <= 0 || fill >= 1 || Math.hypot(viewDirection.x, viewDirection.y, viewDirection.z) === 0) throw new Error("Model camera needs finite dimensions and a usable viewport");
  const normalize = (v: Vector): Vector => { const n = Math.hypot(v.x, v.y, v.z); return { x: v.x / n, y: v.y / n, z: v.z / n }; };
  const direction = normalize(viewDirection);
  const right = Math.hypot(direction.x, direction.z) < 1e-8 ? { x: 1, y: 0, z: 0 } : normalize({ x: direction.z, y: 0, z: -direction.x });
  const up = { x: direction.y * right.z, y: direction.z * right.x - direction.x * right.z, z: -direction.y * right.x };
  const tanY = Math.tan(verticalFovDegrees * Math.PI / 360), tanX = tanY * aspect;
  let distance = 0;
  for (const x of [-size.x / 2, size.x / 2]) for (const y of [-size.y / 2, size.y / 2]) for (const z of [-size.z / 2, size.z / 2]) {
    const depth = x * direction.x + y * direction.y + z * direction.z;
    distance = Math.max(distance, depth + Math.max(Math.abs(x * right.x + y * right.y + z * right.z) / tanX, Math.abs(x * up.x + y * up.y + z * up.z) / tanY) / fill);
  }
  return { distance, direction, right, up };
}
