/** Small 3D math used by camera paths and the software rasterizer. */

export type Vec3 = { x: number; y: number; z: number };

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const n = length(a);
  return n < 1e-12 ? { x: 0, y: 1, z: 0 } : scale(a, 1 / n);
}

export function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function saturate(t: number): number {
  return clamp(t, 0, 1);
}

/** Smoothstep 0→1. */
export function easeInOut(t: number): number {
  const x = saturate(t);
  return x * x * (3 - 2 * x);
}

export type Mat4 = Float64Array;

export function mat4Identity(): Mat4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        (a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!) as number;
    }
  }
  return o;
}

export function mat4Translate(t: Vec3): Mat4 {
  const m = mat4Identity();
  m[12] = t.x;
  m[13] = t.y;
  m[14] = t.z;
  return m;
}

export function mat4Scale(s: Vec3): Mat4 {
  const m = mat4Identity();
  m[0] = s.x;
  m[5] = s.y;
  m[10] = s.z;
  return m;
}

/** glTF quaternion (x, y, z, w) to a column-major matrix. */
export function mat4FromQuat(x: number, y: number, z: number, w: number): Mat4 {
  const xx = x * x,
    yy = y * y,
    zz = z * z;
  const xy = x * y,
    xz = x * z,
    yz = y * z;
  const wx = w * x,
    wy = w * y,
    wz = w * z;
  return new Float64Array([
    1 - 2 * (yy + zz),
    2 * (xy + wz),
    2 * (xz - wy),
    0,
    2 * (xy - wz),
    1 - 2 * (xx + zz),
    2 * (yz + wx),
    0,
    2 * (xz + wy),
    2 * (yz - wx),
    1 - 2 * (xx + yy),
    0,
    0,
    0,
    0,
    1,
  ]);
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const f = normalize(sub(target, eye));
  let s = cross(f, up);
  if (length(s) < 1e-8) {
    const fallback = Math.abs(f.y) > 0.9 ? vec3(0, 0, 1) : vec3(0, 1, 0);
    s = cross(f, fallback);
  }
  s = normalize(s);
  const u = cross(s, f);
  return new Float64Array([
    s.x,
    u.x,
    -f.x,
    0,
    s.y,
    u.y,
    -f.y,
    0,
    s.z,
    u.z,
    -f.z,
    0,
    -dot(s, eye),
    -dot(u, eye),
    dot(f, eye),
    1,
  ]);
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float64Array(16);
  m[0] = f / Math.max(aspect, 1e-6);
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  const x = m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!;
  const y = m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!;
  const z = m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!;
  const w = m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!;
  if (Math.abs(w) < 1e-12) return { x, y, z };
  return { x: x / w, y: y / w, z: z / w };
}

export function transformDir(m: Mat4, p: Vec3): Vec3 {
  return {
    x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z,
    y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z,
    z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z,
  };
}

export type Aabb = { min: Vec3; max: Vec3 };

export function emptyAabb(): Aabb {
  return {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
}

export function expandAabb(box: Aabb, p: Vec3): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
  if (p.x < box.min.x) box.min.x = p.x;
  if (p.y < box.min.y) box.min.y = p.y;
  if (p.z < box.min.z) box.min.z = p.z;
  if (p.x > box.max.x) box.max.x = p.x;
  if (p.y > box.max.y) box.max.y = p.y;
  if (p.z > box.max.z) box.max.z = p.z;
}

export function aabbCenter(box: Aabb): Vec3 {
  return scale(add(box.min, box.max), 0.5);
}

export function aabbSize(box: Aabb): Vec3 {
  return sub(box.max, box.min);
}

export function aabbValid(box: Aabb): boolean {
  return Number.isFinite(box.min.x) && Number.isFinite(box.max.x);
}

export function mergeAabb(a: Aabb, b: Aabb): Aabb {
  const out = emptyAabb();
  // Skip empty AABBs (min=+Inf / max=-Inf). Folding those corners in would
  // make the result infinite and send the camera to NaN.
  if (aabbValid(a)) {
    expandAabb(out, a.min);
    expandAabb(out, a.max);
  }
  if (aabbValid(b)) {
    expandAabb(out, b.min);
    expandAabb(out, b.max);
  }
  return out;
}
