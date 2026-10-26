import { expandAabb, emptyAabb, mat4FromQuat, mat4Identity, mat4Multiply, mat4Scale, mat4Translate, transformDir, transformPoint, vec3, type Mat4, type Vec3 } from "./math";
import type { ScenePart, SceneTriangle } from "./types";

type Gltf = {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    name?: string;
  }>;
  meshes?: Array<{
    name?: string;
    primitives?: Array<{
      attributes?: Record<string, number>;
      indices?: number;
      material?: number;
    }>;
  }>;
  materials?: Array<{
    pbrMetallicRoughness?: { baseColorFactor?: number[] };
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  buffers?: Array<{ byteLength: number }>;
};

const COMP_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readHeader(buf: Uint8Array): { json: Gltf; bin: Uint8Array } {
  if (buf.byteLength < 12) throw new Error("GLB is too small");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB (missing glTF magic)");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  let offset = 12;
  let json: Gltf | null = null;
  let bin: Uint8Array = new Uint8Array(0);
  while (offset + 8 <= buf.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const chunk = buf.subarray(start, start + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
    else if (type === 0x004e4942) bin = chunk;
    offset = start + length;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, bin };
}

function nodeMatrix(node: NonNullable<Gltf["nodes"]>[number]): Mat4 {
  if (node.matrix && node.matrix.length === 16) return Float64Array.from(node.matrix);
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return mat4Multiply(
    mat4Translate(vec3(t[0] ?? 0, t[1] ?? 0, t[2] ?? 0)),
    mat4Multiply(mat4FromQuat(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1), mat4Scale(vec3(s[0] ?? 1, s[1] ?? 1, s[2] ?? 1))),
  );
}

function accessorBytes(gltf: Gltf, bin: Uint8Array, index: number): { data: Uint8Array; stride: number; count: number; componentType: number; comps: number } {
  const acc = gltf.accessors?.[index];
  if (!acc) throw new Error(`missing accessor ${index}`);
  const view = acc.bufferView !== undefined ? gltf.bufferViews?.[acc.bufferView] : undefined;
  if (!view) throw new Error(`accessor ${index} has no bufferView`);
  const comps = TYPE_COMPS[acc.type] ?? 1;
  const elem = (COMP_BYTES[acc.componentType] ?? 4) * comps;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? elem;
  return { data: bin.subarray(start, start + acc.count * stride), stride, count: acc.count, componentType: acc.componentType, comps };
}

function readFloats(src: { data: Uint8Array; stride: number; count: number; componentType: number; comps: number }, i: number): number[] {
  const view = new DataView(src.data.buffer, src.data.byteOffset, src.data.byteLength);
  const base = i * src.stride;
  const out: number[] = [];
  for (let c = 0; c < src.comps; c++) {
    const o = base + c * (COMP_BYTES[src.componentType] ?? 4);
    if (src.componentType === 5126) out.push(view.getFloat32(o, true));
    else if (src.componentType === 5125) out.push(view.getUint32(o, true));
    else if (src.componentType === 5123) out.push(view.getUint16(o, true));
    else if (src.componentType === 5121) out.push(view.getUint8(o));
    else if (src.componentType === 5122) out.push(view.getInt16(o, true));
    else out.push(view.getInt8(o));
  }
  return out;
}

function materialColor(gltf: Gltf, index: number | undefined): [number, number, number, number] {
  const f = index !== undefined ? gltf.materials?.[index]?.pbrMetallicRoughness?.baseColorFactor : undefined;
  if (!f || f.length < 3) return [0.55, 0.62, 0.48, 1];
  return [f[0] ?? 0.55, f[1] ?? 0.62, f[2] ?? 0.48, f[3] ?? 1];
}

function emitMesh(
  gltf: Gltf,
  bin: Uint8Array,
  meshIndex: number,
  world: Mat4,
  triangles: SceneTriangle[],
): void {
  const mesh = gltf.meshes?.[meshIndex];
  if (!mesh) return;
  for (const prim of mesh.primitives ?? []) {
    const posIdx = prim.attributes?.["POSITION"];
    if (posIdx === undefined) continue;
    const positions = accessorBytes(gltf, bin, posIdx);
    const normals = prim.attributes?.["NORMAL"] !== undefined ? accessorBytes(gltf, bin, prim.attributes["NORMAL"]!) : null;
    const color = materialColor(gltf, prim.material);
    const indexCount = prim.indices !== undefined ? accessorBytes(gltf, bin, prim.indices) : null;
    const triCount = indexCount ? Math.floor(indexCount.count / 3) : Math.floor(positions.count / 3);
    const indexAt = (i: number): number => (indexCount ? (readFloats(indexCount, i)[0] ?? 0) : i);
    const vertex = (i: number): { p: Vec3; n: Vec3 } => {
      const p = readFloats(positions, i);
      const n = normals ? readFloats(normals, i) : [0, 1, 0];
      return {
        p: transformPoint(world, vec3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0)),
        n: transformDir(world, vec3(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0)),
      };
    };
    for (let t = 0; t < triCount; t++) {
      const ia = indexAt(t * 3);
      const ib = indexAt(t * 3 + 1);
      const ic = indexAt(t * 3 + 2);
      const a = vertex(ia);
      const b = vertex(ib);
      const c = vertex(ic);
      triangles.push({ a: a.p, b: b.p, c: c.p, na: a.n, nb: b.n, nc: c.n, color });
    }
  }
}

/** Load one GLB into triangles, applying node transforms. */
export function loadGlb(bytes: Uint8Array, id: string, path: string, role: ScenePart["role"]): ScenePart {
  const { json, bin } = readHeader(bytes);
  const triangles: SceneTriangle[] = [];
  const walk = (nodeIndex: number, parent: Mat4) => {
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    const world = mat4Multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) emitMesh(json, bin, node.mesh, world, triangles);
    for (const child of node.children ?? []) walk(child, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? json.nodes?.map((_, i) => i) ?? [];
  for (const root of roots) walk(root, mat4Identity());
  const bounds = emptyAabb();
  for (const tri of triangles) {
    expandAabb(bounds, tri.a);
    expandAabb(bounds, tri.b);
    expandAabb(bounds, tri.c);
  }
  const centroid = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  return { id, path, role, triangles, bounds, centroid };
}
