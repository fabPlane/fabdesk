import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { aabbValid, emptyAabb, expandAabb, mergeAabb, transformDir, transformPoint, vec3, type Mat4 } from "./math";
import { loadGlb } from "./glb";
import { loadObj, loadStl } from "./stl";
import type { ProductScene, ScenePart } from "./types";

const MESH_EXT = new Set([".glb", ".stl", ".obj"]);
const SEARCH_DIRS = ["renders", "exports", "cad", "mechanical", "enclosure"];
const SKIP_NAME = /product-video/i;

export type DiscoverOptions = {
  projectDir: string;
};

export async function discoverMeshFiles(projectDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ["enclosure.glb", "enclosure.stl", "enclosure.obj"]) {
    const abs = join(projectDir, name);
    if (await isFile(abs)) found.push(abs);
  }
  for (const dir of SEARCH_DIRS) {
    await walk(join(projectDir, dir), found);
  }
  found.sort((a, b) => a.localeCompare(b));
  const seen = new Set<string>();
  return found.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!MESH_EXT.has(ext)) continue;
    if (SKIP_NAME.test(entry.name)) continue;
    out.push(abs);
  }
}

async function isFile(path: string): Promise<boolean> {
  const st = await stat(path).catch(() => null);
  return Boolean(st?.isFile());
}

function roleFor(path: string, projectDir: string): ScenePart["role"] {
  const rel = relative(projectDir, path).split(sep).join("/");
  if (rel === "renders/board.glb" || basename(path) === "board.glb") return "board";
  return "mechanical";
}

export async function loadPart(abs: string, projectDir: string): Promise<ScenePart> {
  const rel = relative(projectDir, abs).split(sep).join("/");
  const ext = extname(abs).toLowerCase();
  const id = rel.replace(/[^\w.-]+/g, "_");
  const role = roleFor(abs, projectDir);
  if (ext === ".glb") return loadGlb(new Uint8Array(await readFile(abs)), id, rel, role);
  if (ext === ".stl") return loadStl(new Uint8Array(await readFile(abs)), id, rel, role);
  return loadObj(await readFile(abs, "utf8"), id, rel, role);
}

/**
 * Build the product scene from board GLB plus enclosure / mechanical meshes when present.
 * Parts are sorted so the same inputs always produce the same explode order.
 */
export async function assembleScene(projectDir: string): Promise<ProductScene> {
  const files = await discoverMeshFiles(projectDir);
  const parts: ScenePart[] = [];
  for (const file of files) {
    try {
      const part = await loadPart(file, projectDir);
      if (part.triangles.length) parts.push(orientPart(part));
    } catch {
      // Skip unreadable meshes; the tool reports what loaded.
    }
  }
  parts.sort((a, b) => (a.role === b.role ? a.path.localeCompare(b.path) : a.role === "board" ? -1 : 1));
  let bounds = emptyAabb();
  for (const part of parts) bounds = aabbValid(part.bounds) ? mergeAabb(bounds, part.bounds) : bounds;
  if (!aabbValid(bounds)) {
    expandAabb(bounds, vec3(-1, -0.1, -1));
    expandAabb(bounds, vec3(1, 0.1, 1));
  }
  return { parts, bounds, sourceFiles: parts.map((p) => p.path) };
}

/**
 * Rotate a part so its thinnest AABB axis becomes +Y (camera up). KiCad boards sit in XY
 * (thin in Z); FreeCAD enclosures vary.
 */
function orientPart(part: ScenePart): ScenePart {
  const size = {
    x: part.bounds.max.x - part.bounds.min.x,
    y: part.bounds.max.y - part.bounds.min.y,
    z: part.bounds.max.z - part.bounds.min.z,
  };
  const thin = size.z <= size.x && size.z <= size.y ? "z" : size.x <= size.y ? "x" : "y";
  if (thin === "y") return part;
  // Rotate -90° about X (Z-up → Y-up) or +90° about Z (X-thin → Y-up).
  const m: Mat4 =
    thin === "z"
      ? new Float64Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1])
      : new Float64Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const triangles = part.triangles.map((tri) => ({
    a: transformPoint(m, tri.a),
    b: transformPoint(m, tri.b),
    c: transformPoint(m, tri.c),
    na: transformDir(m, tri.na),
    nb: transformDir(m, tri.nb),
    nc: transformDir(m, tri.nc),
    color: tri.color,
  }));
  const bounds = emptyAabb();
  for (const tri of triangles) {
    expandAabb(bounds, tri.a);
    expandAabb(bounds, tri.b);
    expandAabb(bounds, tri.c);
  }
  return {
    ...part,
    triangles,
    bounds,
    centroid: {
      x: (bounds.min.x + bounds.max.x) / 2,
      y: (bounds.min.y + bounds.max.y) / 2,
      z: (bounds.min.z + bounds.max.z) / 2,
    },
  };
}
