import { expandAabb, emptyAabb, vec3 } from "./math";
import type { ScenePart, SceneTriangle } from "./types";

const DEFAULT_COLOR: [number, number, number, number] = [0.72, 0.74, 0.78, 1];

function triangle(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number): SceneTriangle {
  const n = vec3(nx, ny, nz);
  return {
    a: vec3(ax, ay, az),
    b: vec3(bx, by, bz),
    c: vec3(cx, cy, cz),
    na: n,
    nb: n,
    nc: n,
    color: DEFAULT_COLOR,
  };
}

export function loadStl(bytes: Uint8Array, id: string, path: string, role: ScenePart["role"]): ScenePart {
  const asText = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, 80)));
  const triangles = asText.startsWith("solid") && !looksBinary(bytes) ? parseAscii(new TextDecoder().decode(bytes)) : parseBinary(bytes);
  return finish(triangles, id, path, role);
}

function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return 84 + count * 50 === bytes.byteLength;
}

function parseBinary(bytes: Uint8Array): SceneTriangle[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const out: SceneTriangle[] = [];
  let o = 84;
  for (let i = 0; i < count && o + 50 <= bytes.byteLength; i++, o += 50) {
    out.push(
      triangle(
        view.getFloat32(o + 12, true),
        view.getFloat32(o + 16, true),
        view.getFloat32(o + 20, true),
        view.getFloat32(o + 24, true),
        view.getFloat32(o + 28, true),
        view.getFloat32(o + 32, true),
        view.getFloat32(o + 36, true),
        view.getFloat32(o + 40, true),
        view.getFloat32(o + 44, true),
        view.getFloat32(o, true),
        view.getFloat32(o + 4, true),
        view.getFloat32(o + 8, true),
      ),
    );
  }
  return out;
}

function parseAscii(text: string): SceneTriangle[] {
  const out: SceneTriangle[] = [];
  const facet = /facet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)[\s\S]*?vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)[\s\S]*?vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)[\s\S]*?vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;
  for (const m of text.matchAll(facet)) {
    const n = m.slice(1, 13).map(Number);
    out.push(triangle(n[3]!, n[4]!, n[5]!, n[6]!, n[7]!, n[8]!, n[9]!, n[10]!, n[11]!, n[0]!, n[1]!, n[2]!));
  }
  return out;
}

export function loadObj(text: string, id: string, path: string, role: ScenePart["role"]): ScenePart {
  const verts: Array<[number, number, number]> = [];
  const triangles: SceneTriangle[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const p = line.slice(2).trim().split(/\s+/).map(Number);
      verts.push([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
    } else if (line.startsWith("f ")) {
      const idx = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((tok) => Number(tok.split("/")[0]) - 1);
      for (let i = 1; i + 1 < idx.length; i++) {
        const a = verts[idx[0]!] ?? [0, 0, 0];
        const b = verts[idx[i]!] ?? [0, 0, 0];
        const c = verts[idx[i + 1]!] ?? [0, 0, 0];
        triangles.push(triangle(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], 0, 1, 0));
      }
    }
  }
  return finish(triangles, id, path, role);
}

function finish(triangles: SceneTriangle[], id: string, path: string, role: ScenePart["role"]): ScenePart {
  const bounds = emptyAabb();
  for (const tri of triangles) {
    expandAabb(bounds, tri.a);
    expandAabb(bounds, tri.b);
    expandAabb(bounds, tri.c);
  }
  return {
    id,
    path,
    role,
    triangles,
    bounds,
    centroid: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    },
  };
}
