import { aabbCenter, aabbSize, add, clamp, cross, dot, length, lookAt, normalize, perspective, sub, type Vec3 } from "./math";
import { explodeOffset } from "./presets";
import type { FramePose, PixelBuffer, ProductScene, SceneTriangle, VideoBackground } from "./types";
import { backgroundRgba } from "./types";

const LIGHT = normalize({ x: 0.45, y: 0.85, z: 0.35 });

export function createBuffer(width: number, height: number): PixelBuffer {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function clearBuffer(buf: PixelBuffer, rgba: [number, number, number, number]): void {
  const { data } = buf;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
}

function shade(tri: SceneTriangle, n: Vec3): [number, number, number, number] {
  const ndotl = Math.max(0, dot(normalize(n), LIGHT));
  const amb = 0.32;
  const diff = 0.68 * ndotl;
  const k = amb + diff;
  return [
    clamp(Math.round(tri.color[0] * 255 * k), 0, 255),
    clamp(Math.round(tri.color[1] * 255 * k), 0, 255),
    clamp(Math.round(tri.color[2] * 255 * k), 0, 255),
    clamp(Math.round(tri.color[3] * 255), 0, 255),
  ];
}

type Proj = { x: number; y: number; z: number; n: Vec3 };

function project(p: Vec3, n: Vec3, viewProj: (v: Vec3) => { x: number; y: number; z: number; w: number }, w: number, h: number): Proj | null {
  const c = viewProj(p);
  if (c.w <= 1e-5) return null;
  const ndcX = c.x / c.w;
  const ndcY = c.y / c.w;
  const ndcZ = c.z / c.w;
  return { x: (ndcX * 0.5 + 0.5) * w, y: (1 - (ndcY * 0.5 + 0.5)) * h, z: ndcZ, n };
}

function mulViewProj(view: Float64Array, proj: Float64Array, p: Vec3): { x: number; y: number; z: number; w: number } {
  const vx = view[0]! * p.x + view[4]! * p.y + view[8]! * p.z + view[12]!;
  const vy = view[1]! * p.x + view[5]! * p.y + view[9]! * p.z + view[13]!;
  const vz = view[2]! * p.x + view[6]! * p.y + view[10]! * p.z + view[14]!;
  const vw = view[3]! * p.x + view[7]! * p.y + view[11]! * p.z + view[15]!;
  return {
    x: proj[0]! * vx + proj[4]! * vy + proj[8]! * vz + proj[12]! * vw,
    y: proj[1]! * vx + proj[5]! * vy + proj[9]! * vz + proj[13]! * vw,
    z: proj[2]! * vx + proj[6]! * vy + proj[10]! * vz + proj[14]! * vw,
    w: proj[3]! * vx + proj[7]! * vy + proj[11]! * vz + proj[15]! * vw,
  };
}

function rasterTri(buf: PixelBuffer, zbuf: Float32Array, tri: SceneTriangle, offset: Vec3, view: Float64Array, proj: Float64Array): void {
  const a = project(add(tri.a, offset), tri.na, (p) => mulViewProj(view, proj, p), buf.width, buf.height);
  const b = project(add(tri.b, offset), tri.nb, (p) => mulViewProj(view, proj, p), buf.width, buf.height);
  const c = project(add(tri.c, offset), tri.nc, (p) => mulViewProj(view, proj, p), buf.width, buf.height);
  if (!a || !b || !c) return;
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-6) return;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(buf.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(buf.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const n = normalize({
    x: (a.n.x + b.n.x + c.n.x) / 3,
    y: (a.n.y + b.n.y + c.n.y) / 3,
    z: (a.n.z + b.n.z + c.n.z) / 3,
  });
  const [sr, sg, sb, sa] = shade(tri, n);
  const data = buf.data;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const wA = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
      const wB = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
      const wC = 1 - wA - wB;
      if (wA < 0 || wB < 0 || wC < 0) continue;
      const z = a.z * wA + b.z * wB + c.z * wC;
      const zi = y * buf.width + x;
      if (z <= (zbuf[zi] ?? 1) && z >= -1 && z <= 1) {
        zbuf[zi] = z;
        const i = zi * 4;
        data[i] = sr;
        data[i + 1] = sg;
        data[i + 2] = sb;
        data[i + 3] = sa;
      }
    }
  }
}

export function renderFrame(
  scene: ProductScene,
  pose: FramePose,
  width: number,
  height: number,
  background: VideoBackground,
): PixelBuffer {
  const buf = createBuffer(width, height);
  clearBuffer(buf, backgroundRgba(background));
  const zbuf = new Float32Array(width * height);
  zbuf.fill(1);
  const view = lookAt(pose.camera.eye, pose.camera.target, pose.camera.up);
  const dist = Math.max(length(sub(pose.camera.eye, pose.camera.target)), 1);
  const size = aabbSize(scene.bounds);
  const span = Math.max(size.x, size.y, size.z, 1);
  const near = Math.max(dist * 0.02, span * 0.01, 0.01);
  const far = Math.max(dist + span * 6, near * 50);
  const proj = perspective(pose.camera.fovY, width / Math.max(height, 1), near, far);
  const center = aabbCenter(scene.bounds);
  for (const part of scene.parts) {
    const offset = explodeOffset(part.centroid, center, pose.explode, span);
    for (const tri of part.triangles) rasterTri(buf, zbuf, tri, offset, view, proj);
  }
  return buf;
}

/** Cheap coverage check used by tests: count non-background pixels. */
export function paintedPixels(buf: PixelBuffer, background: VideoBackground): number {
  const [br, bg, bb, ba] = backgroundRgba(background);
  let n = 0;
  for (let i = 0; i < buf.data.length; i += 4) {
    if (buf.data[i] !== br || buf.data[i + 1] !== bg || buf.data[i + 2] !== bb || buf.data[i + 3] !== ba) n++;
  }
  return n;
}

export function cloneBuffer(buf: PixelBuffer): PixelBuffer {
  return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
}

export function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  return normalize(cross(sub(b, a), sub(c, a)));
}
