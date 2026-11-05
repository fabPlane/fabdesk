import type { MechanicalBox, MechanicalDesign, MechanicalFitReport } from "@fabdesk/protocol";
import { boardVolumes, type FitBoard } from "./mechanical-fit";

type Point = [number, number, number];
type Transform = NonNullable<MechanicalDesign["source"]>;
const MAX_TRIANGLES = 250_000;
const MAX_BYTES = 50 * 1024 * 1024;
const number = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1e9;

/** SAT: box axes, triangle normal, and the nine edge/box-axis cross products.
 * Derivation: Akenine-Möller, Fast 3D Triangle-Box Overlap Testing (2001).
 * https://fileadmin.cs.lth.se/cs/Personal/Tomas_Akenine-Moller/pubs/tribox.pdf
 * Independent implementation; part envelopes remain conservative, not exact component solids.
 */
export function triangleIntersectsBox(
  vertices: ArrayLike<number>,
  offset: number,
  box: MechanicalBox,
): boolean {
  const hx = box.width / 2,
    hy = box.depth / 2,
    hz = box.height / 2;
  const cx = box.x + hx,
    cy = box.y + hy,
    cz = box.z + hz;
  const points: Point[] = [0, 3, 6].map((n) => [
    vertices[offset + n]! - cx,
    vertices[offset + n + 1]! - cy,
    vertices[offset + n + 2]! - cz,
  ]);
  const separated = (ax: number, ay: number, az: number) => {
    const radius = hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az);
    const a = points[0]!,
      b = points[1]!,
      c = points[2]!;
    const p = a[0] * ax + a[1] * ay + a[2] * az;
    const q = b[0] * ax + b[1] * ay + b[2] * az;
    const r = c[0] * ax + c[1] * ay + c[2] * az;
    const tolerance = 1e-9 * (Math.abs(ax) + Math.abs(ay) + Math.abs(az));
    return Math.min(p, q, r) > radius + tolerance || Math.max(p, q, r) < -radius - tolerance;
  };
  if (separated(1, 0, 0) || separated(0, 1, 0) || separated(0, 0, 1)) return false;
  const edges: Point[] = points.map((p, i) => {
    const q = points[(i + 1) % 3]!;
    return [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  });
  for (const [x, y, z] of edges)
    if (separated(0, -z, y) || separated(z, 0, -x) || separated(-y, x, 0)) return false;
  const a = edges[0]!,
    b = edges[1]!;
  return !separated(
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  );
}

/** Bounded STL parser; a binary header beginning with "solid" is still treated as binary. */
export function readStlTriangles(bytes: Uint8Array): Float64Array {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
    throw new Error("Use an STL smaller than 50 MB for surface checks.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0;
  const values: number[] = [];
  function add(triangle: number[]) {
    if (values.length / 9 >= MAX_TRIANGLES)
      throw new Error("Simplify this STL to 250,000 triangles or fewer for surface checks.");
    if (triangle.length !== 9 || !triangle.every(number))
      throw new Error("The STL contains invalid coordinates.");
    values.push(...triangle);
  }
  if (count > 0 && 84 + count * 50 === bytes.byteLength) {
    if (count > MAX_TRIANGLES)
      throw new Error("Simplify this STL to 250,000 triangles or fewer for surface checks.");
    for (let i = 0; i < count; i++) {
      const triangle: number[] = [];
      for (let j = 0; j < 9; j++) triangle.push(view.getFloat32(84 + i * 50 + 12 + j * 4, true));
      add(triangle);
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    if (!/^\s*solid\b/i.test(text) || !/\bendsolid\b/i.test(text))
      throw new Error("The STL could not be read for surface checks.");
    let vertices = 0;
    for (const facet of text.matchAll(/\bfacet\s+normal\b[\s\S]*?\bendfacet\b/gi)) {
      const triangle: number[] = [];
      for (const vertex of facet[0].matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)) {
        triangle.push(Number(vertex[1]), Number(vertex[2]), Number(vertex[3]));
        vertices++;
      }
      add(triangle);
    }
    if (vertices !== (text.match(/\bvertex\b/gi)?.length ?? 0))
      throw new Error("The STL contains incomplete facets.");
  }
  if (!values.length) throw new Error("The STL has no triangles to check.");
  return Float64Array.from(values);
}

export class ShellSurface {
  readonly vertices: Float64Array;
  private readonly bounds: Float64Array;
  private readonly order: number[];
  readonly degenerateTriangles: number;
  constructor(raw: Float64Array, transform?: Transform) {
    if (!raw.length || raw.length % 9 || raw.length / 9 > MAX_TRIANGLES)
      throw new Error("Invalid STL triangle data.");
    this.vertices = new Float64Array(raw.length);
    const angles = (transform?.rotation ?? [0, 0, 0]).map((a) => (a * Math.PI) / 180);
    const [sx, sy, sz] = angles.map(Math.sin),
      [cx, cy, cz] = angles.map(Math.cos);
    const scale = transform?.scale ?? 1,
      position = transform?.position ?? [0, 0, 0];
    if (!Number.isFinite(scale) || scale <= 0 || !raw.every(number))
      throw new Error("Invalid enclosure transform or triangle coordinates.");
    for (let i = 0; i < raw.length; i += 3) {
      // Three.js XYZ Euler: apply Rz, then Ry, then Rx, matching importedShellScript.
      const x = raw[i]! * scale,
        y = raw[i + 1]! * scale,
        z = raw[i + 2]! * scale;
      const zx = cz! * x - sz! * y,
        zy = sz! * x + cz! * y;
      const yx = cy! * zx + sy! * z,
        yz = -sy! * zx + cy! * z;
      const next = [
        yx + position[0],
        cx! * zy - sx! * yz + position[1],
        sx! * zy + cx! * yz + position[2],
      ];
      if (!next.every(Number.isFinite)) throw new Error("Invalid enclosure transform.");
      this.vertices.set(next, i);
    }
    this.bounds = new Float64Array((raw.length / 9) * 6);
    this.order = [];
    let degenerate = 0;
    for (let i = 0; i < raw.length / 9; i++) {
      const at = i * 9,
        v = this.vertices;
      const ax = v[at + 3]! - v[at]!,
        ay = v[at + 4]! - v[at + 1]!,
        az = v[at + 5]! - v[at + 2]!;
      const bx = v[at + 6]! - v[at]!,
        by = v[at + 7]! - v[at + 1]!,
        bz = v[at + 8]! - v[at + 2]!;
      if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) < 1e-12) {
        degenerate++;
        continue;
      }
      for (let a = 0; a < 3; a++) {
        this.bounds[i * 6 + a] = Math.min(v[at + a]!, v[at + a + 3]!, v[at + a + 6]!);
        this.bounds[i * 6 + a + 3] = Math.max(v[at + a]!, v[at + a + 3]!, v[at + a + 6]!);
      }
      this.order.push(i);
    }
    if (!this.order.length) throw new Error("The STL has no usable surface triangles.");
    this.order.sort((a, b) => this.bounds[a * 6]! - this.bounds[b * 6]!);
    this.degenerateTriangles = degenerate;
  }
  intersects(box: MechanicalBox, budget = { remaining: 20_000_000 }): boolean {
    const min = [box.x, box.y, box.z],
      max = [box.x + box.width, box.y + box.depth, box.z + box.height];
    if (
      ![...min, ...max].every(Number.isFinite) ||
      box.width <= 0 ||
      box.depth <= 0 ||
      box.height <= 0
    )
      return false;
    for (const i of this.order) {
      if (--budget.remaining < 0)
        throw new Error(
          "Surface checks reached their complexity limit. Simplify the case or check fewer boards.",
        );
      const at = i * 6;
      if (this.bounds[at]! > max[0]!) break;
      if (
        this.bounds[at + 3]! < min[0]! ||
        this.bounds[at + 1]! > max[1]! ||
        this.bounds[at + 4]! < min[1]! ||
        this.bounds[at + 2]! > max[2]! ||
        this.bounds[at + 5]! < min[2]!
      )
        continue;
      if (triangleIntersectsBox(this.vertices, i * 9, box)) return true;
    }
    return false;
  }
}

/** Surface risks are review findings: bounding envelopes can include empty areas and PCB holes. */
export function withShellSurfaceReview(
  report: MechanicalFitReport,
  design: MechanicalDesign,
  boards: FitBoard[],
  surface: ShellSurface,
): MechanicalFitReport {
  const issues = report.issues.filter(
    (i) =>
      !["import-coverage", "shell-surface", "shell-clearance", "shell-coverage"].includes(i.code),
  );
  const budget = { remaining: 20_000_000 };
  try {
    for (const board of boards)
      for (const volume of boardVolumes(board)) {
        const gap = design.space.clearance;
        const expanded = {
          ...volume,
          x: volume.x - gap,
          y: volume.y - gap,
          z: volume.z - gap,
          width: volume.width + gap * 2,
          depth: volume.depth + gap * 2,
          height: volume.height + gap * 2,
        };
        if (!surface.intersects(expanded, budget)) continue;
        const hit = gap === 0 || surface.intersects(volume, budget);
        issues.push({
          code: hit ? "shell-surface" : "shell-clearance",
          severity: "review",
          message: `${board.placement.path}: ${volume.name} ${hit ? "touches or intersects the STL surface" : "has a clearance envelope that intersects the STL surface"}. Check the real part shape and any mounting holes.`,
          regions: [volume],
        });
      }
    issues.push({
      code: "shell-coverage",
      severity: "review",
      message: `STL surface intersections checked against estimated board/component boxes. This does not test enclosed-volume containment, holes within those boxes, or exact component solids.${surface.degenerateTriangles ? ` ${surface.degenerateTriangles} degenerate triangles were skipped.` : ""}`,
    });
  } catch (error) {
    issues.push({
      code: "import-coverage",
      severity: "review",
      message: error instanceof Error ? error.message : "STL surface checks did not finish.",
    });
  }
  return {
    ...report,
    issues,
    coverage: `${report.coverage} STL surface risks use conservative part envelopes; review is required.`,
  };
}
