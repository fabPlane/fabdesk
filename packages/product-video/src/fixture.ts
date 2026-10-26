import { vec3 } from "./math";
import type { ScenePart, SceneTriangle } from "./types";

function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: [number, number, number, number]): SceneTriangle[] {
  const hx = sx / 2,
    hy = sy / 2,
    hz = sz / 2;
  const faces: Array<{ n: [number, number, number]; q: Array<[number, number, number]> }> = [
    { n: [0, 1, 0], q: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, -1, 0], q: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]] },
    { n: [0, 0, 1], q: [[-1, -1, 1], [-1, 1, 1], [1, 1, 1], [1, -1, 1]] },
    { n: [0, 0, -1], q: [[1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, -1]] },
    { n: [1, 0, 0], q: [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]] },
    { n: [-1, 0, 0], q: [[-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]] },
  ];
  const out: SceneTriangle[] = [];
  for (const face of faces) {
    const pts = face.q.map(([x, y, z]) => vec3(cx + x * hx, cy + y * hy, cz + z * hz));
    const n = vec3(face.n[0], face.n[1], face.n[2]);
    out.push({ a: pts[0]!, b: pts[1]!, c: pts[2]!, na: n, nb: n, nc: n, color });
    out.push({ a: pts[0]!, b: pts[2]!, c: pts[3]!, na: n, nb: n, nc: n, color });
  }
  return out;
}

function partFrom(id: string, path: string, role: ScenePart["role"], triangles: SceneTriangle[]): ScenePart {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const t of triangles) {
    for (const p of [t.a, t.b, t.c]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  return {
    id,
    path,
    role,
    triangles,
    bounds: { min: vec3(minX, minY, minZ), max: vec3(maxX, maxY, maxZ) },
    centroid: vec3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
  };
}

/** Two-part fixture used by tests and sample-video generation: a green board and a grey lid. */
export function fixtureScene(): { parts: ScenePart[]; bounds: ReturnType<typeof partFrom>["bounds"]; sourceFiles: string[] } {
  const board = partFrom("board", "renders/board.glb", "board", box(0, 0, 0, 40, 1.6, 25, [0.18, 0.55, 0.32, 1]));
  const lid = partFrom("lid", "exports/enclosure.stl", "mechanical", box(0, 8, 0, 44, 2, 29, [0.7, 0.72, 0.76, 1]));
  return {
    parts: [board, lid],
    bounds: {
      min: vec3(-22, -0.8, -14.5),
      max: vec3(22, 9, 14.5),
    },
    sourceFiles: [board.path, lid.path],
  };
}

/** Minimal GLB (one green box) written into a project for tool / scene tests. */
export function buildBoxGlb(color: [number, number, number, number] = [0.2, 0.6, 0.35, 1]): Uint8Array {
  const triangles = box(0, 0, 0, 20, 1.6, 12, color);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let i = 0;
  for (const t of triangles) {
    for (const [p, n] of [
      [t.a, t.na],
      [t.b, t.nb],
      [t.c, t.nc],
    ] as const) {
      positions.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
    }
    indices.push(i, i + 1, i + 2);
    i += 3;
  }
  const posBytes = new Uint8Array(new Float32Array(positions).buffer);
  const nrmBytes = new Uint8Array(new Float32Array(normals).buffer);
  const idxBytes = new Uint8Array(new Uint16Array(indices).buffer);
  const bin = new Uint8Array(posBytes.length + nrmBytes.length + idxBytes.length);
  bin.set(posBytes, 0);
  bin.set(nrmBytes, posBytes.length);
  bin.set(idxBytes, posBytes.length + nrmBytes.length);
  const json = {
    asset: { version: "2.0", generator: "fabdesk-product-video-fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: color } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.length },
      { buffer: 0, byteOffset: posBytes.length, byteLength: nrmBytes.length },
      { buffer: 0, byteOffset: posBytes.length + nrmBytes.length, byteLength: idxBytes.length },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = jsonBytes.length + jsonPad;
  const binChunk = bin.length + binPad;
  const total = 12 + 8 + jsonChunk + 8 + binChunk;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let p = 0; p < jsonPad; p++) out[20 + jsonBytes.length + p] = 0x20;
  const binStart = 20 + jsonChunk;
  view.setUint32(binStart, binChunk, true);
  view.setUint32(binStart + 4, 0x004e4942, true);
  out.set(bin, binStart + 8);
  return out;
}

/** Binary STL of a grey lid box sitting above the origin. */
export function buildBoxStl(): Uint8Array {
  const triangles = box(0, 8, 0, 24, 2, 16, [0.7, 0.72, 0.76, 1]);
  const out = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, triangles.length, true);
  let o = 84;
  for (const t of triangles) {
    view.setFloat32(o, t.na.x, true);
    view.setFloat32(o + 4, t.na.y, true);
    view.setFloat32(o + 8, t.na.z, true);
    for (const [k, p] of [
      [12, t.a],
      [24, t.b],
      [36, t.c],
    ] as const) {
      view.setFloat32(o + k, p.x, true);
      view.setFloat32(o + k + 4, p.y, true);
      view.setFloat32(o + k + 8, p.z, true);
    }
    o += 50;
  }
  return out;
}
