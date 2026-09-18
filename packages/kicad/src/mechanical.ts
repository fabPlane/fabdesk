/**
 * Project-scale mechanical truth: per-footprint 3D model coverage and board-space bounds.
 *
 * Source of geometry: the packaged `kicad-cli pcb export glb` (OCCT tessellation). Feasibility was
 * proven on disposable fixtures (see test/mechanical.test.ts) before this collector was written:
 *
 * - Identity: every loaded model becomes one child of the scene root named with the footprint's
 *   reference designator; a footprint with N loaded models emits N same-named siblings in declared
 *   model order. The board body is the one root child whose name is not a reference.
 * - Transform: node TRS/matrix chains already include footprint placement, rotation, bottom-side
 *   flip and the model's offset/rotate/scale. Nothing here re-derives KiCad's placement convention.
 * - Units and axes: glTF metres, Y-up. With `--user-origin 0x0mm` the conversion to KiCad board
 *   millimetres is `X = 1000·x`, `Y = 1000·z` (KiCad Y grows downwards), `Z(up) = 1000·y`.
 * - Bounds are the exact min/max of the emitted tessellation vertices after the full node transform.
 *   Vertices lie on the model surface, so curved faces can under-reach the B-rep envelope by at most
 *   the tessellation chord deviation.
 * - A model file that exists but cannot be loaded (garbage, unknown content) is dropped without any
 *   diagnostic; only a missing file is reported on stderr. Loadability is therefore measured by the
 *   presence of the model's node, never inferred from its file extension (KiCad sniffs content).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runKicadCli, type KicadCli } from "./cli";

export const MECHANICAL_COLLECTOR = { name: "fabdesk.mechanical-glb", version: "1.0.0" } as const;
export const MECHANICAL_CONTRACT = { name: "fabdesk.mechanical", version: "1.0.0" } as const;

/** Extensions the packaged runtime is known to read (content is still sniffed by KiCad). */
const RECOGNIZED_MODEL_EXTENSIONS = [
  ".step",
  ".stp",
  ".stpz",
  ".step.gz",
  ".stp.gz",
  ".iges",
  ".igs",
  ".wrl",
  ".wrz",
  ".x_t",
  ".x_b",
];
const VRML_EXTENSIONS = [".wrl", ".wrz"];
/** `--subst-models` replaces a VRML model with a same-named STEP when one exists. */
const SUBSTITUTE_EXTENSIONS = [".step", ".stp", ".STEP", ".STP"];

// ---------------------------------------------------------------------------------------------
// Saved-native board model references
// ---------------------------------------------------------------------------------------------

type Sexpr = string | Sexpr[];

function parseSexpr(text: string): Sexpr[] {
  const stack: Sexpr[][] = [[]];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "(") {
      const list: Sexpr[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i++;
    } else if (ch === ")") {
      if (stack.length === 1) throw new Error("unbalanced parentheses in board file");
      stack.pop();
      i++;
    } else if (ch === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        value += text[i];
        i++;
      }
      i++;
      stack[stack.length - 1]!.push(value);
    } else if (/\s/.test(ch)) i++;
    else {
      let end = i;
      while (end < text.length && !/[\s()"]/.test(text[end]!)) end++;
      stack[stack.length - 1]!.push(text.slice(i, end));
      i = end;
    }
  }
  if (stack.length !== 1) throw new Error("unbalanced parentheses in board file");
  return stack[0]!;
}

const head = (node: Sexpr): string | null =>
  Array.isArray(node) && typeof node[0] === "string" ? node[0] : null;
const child = (node: Sexpr[], name: string): Sexpr[] | undefined =>
  node.find((n): n is Sexpr[] => head(n) === name);
const children = (node: Sexpr[], name: string): Sexpr[][] =>
  node.filter((n): n is Sexpr[] => head(n) === name);
const numberAt = (node: Sexpr[] | undefined, index: number): number | null => {
  const value = node?.[index];
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export type Vec3 = { x: number; y: number; z: number };

export type SavedModelReference = {
  index: number;
  declared: string;
  hidden: boolean;
  /** mm; legacy `(at (xyz …))` offsets in inches are converted. */
  offset: Vec3 | null;
  scale: Vec3 | null;
  rotate: Vec3 | null;
  issues: string[];
};

export type SavedFootprint = {
  ref: string | null;
  uuid: string | null;
  footprint: string;
  layer: string | null;
  side: "top" | "bottom" | "unknown";
  placement: { x: number; y: number; rotationDeg: number; format: "transform" | "at" } | null;
  dnp: boolean;
  models: SavedModelReference[];
};

function xyz(node: Sexpr[] | undefined, factor = 1): Vec3 | null {
  const inner = node ? child(node, "xyz") : undefined;
  if (!inner) return null;
  const [x, y, z] = [numberAt(inner, 1), numberAt(inner, 2), numberAt(inner, 3)];
  return x === null || y === null || z === null
    ? null
    : { x: x * factor, y: y * factor, z: z * factor };
}

/** Footprints and their `(model …)` references exactly as saved in `board.kicad_pcb`. */
export function readSavedBoardModels(boardText: string): SavedFootprint[] {
  const root = parseSexpr(boardText).find((n): n is Sexpr[] => head(n) === "kicad_pcb");
  if (!root) throw new Error("not a kicad_pcb file");
  return children(root, "footprint").map((fp) => {
    const reference =
      children(fp, "property").find((p) => p[1] === "Reference")?.[2] ??
      children(fp, "fp_text").find((t) => t[1] === "reference")?.[2];
    const layerNode = child(fp, "layer");
    const layer = typeof layerNode?.[1] === "string" ? layerNode[1] : null;
    const transform = child(fp, "transform");
    const at = child(fp, "at");
    let placement: SavedFootprint["placement"] = null;
    if (transform) {
      const translate = child(transform, "translate");
      const x = numberAt(translate, 1);
      const y = numberAt(translate, 2);
      if (x !== null && y !== null)
        placement = {
          x,
          y,
          rotationDeg: numberAt(child(transform, "rotate"), 1) ?? 0,
          format: "transform",
        };
    } else if (at) {
      const x = numberAt(at, 1);
      const y = numberAt(at, 2);
      if (x !== null && y !== null)
        placement = { x, y, rotationDeg: numberAt(at, 3) ?? 0, format: "at" };
    }
    const attr = child(fp, "attr");
    const dnpNode = child(fp, "dnp");
    const dnp = (attr?.includes("dnp") ?? false) || (dnpNode !== undefined && dnpNode[1] !== "no");
    const models = children(fp, "model").map((model, index): SavedModelReference => {
      const issues: string[] = [];
      const hideNode = child(model, "hide");
      const hidden = model.includes("hide") || (hideNode !== undefined && hideNode[1] !== "no");
      const legacyAt = child(model, "at");
      const offset = child(model, "offset")
        ? xyz(child(model, "offset"))
        : legacyAt
          ? xyz(legacyAt, 25.4)
          : { x: 0, y: 0, z: 0 };
      const scale = child(model, "scale") ? xyz(child(model, "scale")) : { x: 1, y: 1, z: 1 };
      const rotate = child(model, "rotate") ? xyz(child(model, "rotate")) : { x: 0, y: 0, z: 0 };
      if (!offset || !scale || !rotate) issues.push("invalid-model-transform");
      return {
        index,
        declared: typeof model[1] === "string" ? model[1] : "",
        hidden,
        offset,
        scale,
        rotate,
        issues,
      };
    });
    return {
      ref: typeof reference === "string" ? reference : null,
      uuid: typeof child(fp, "uuid")?.[1] === "string" ? (child(fp, "uuid")![1] as string) : null,
      footprint: typeof fp[1] === "string" ? fp[1] : "",
      layer,
      side: layer === "F.Cu" ? "top" : layer === "B.Cu" ? "bottom" : "unknown",
      placement,
      dnp,
      models,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Model path resolution (mirrors KiCad's ${VAR} / $(VAR) expansion and project-relative paths)
// ---------------------------------------------------------------------------------------------

export type ModelResolution = {
  status: "resolved" | "file-not-found" | "unresolved-variable" | "empty-path";
  path: string | null;
  unresolvedVariables: string[];
  substitutionCandidates: string[];
};

export function resolveModelPath(
  declared: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelResolution {
  if (!declared.trim())
    return {
      status: "empty-path",
      path: null,
      unresolvedVariables: [],
      substitutionCandidates: [],
    };
  const unresolved: string[] = [];
  const expanded = declared.replace(
    /\$\{([^}]+)\}|\$\(([^)]+)\)/g,
    (whole, a?: string, b?: string) => {
      const name = (a ?? b)!;
      if (name === "KIPRJMOD") return projectDir;
      const value = env[name];
      if (value === undefined || value === "") {
        unresolved.push(name);
        return whole;
      }
      return value;
    },
  );
  if (unresolved.length)
    return {
      status: "unresolved-variable",
      path: null,
      unresolvedVariables: unresolved,
      substitutionCandidates: [],
    };
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(projectDir, expanded);
  const lower = path.toLowerCase();
  const stem = VRML_EXTENSIONS.find((ext) => lower.endsWith(ext)) ? path.slice(0, -4) : null;
  const substitutionCandidates = stem
    ? SUBSTITUTE_EXTENSIONS.map((ext) => stem + ext).filter((p) => existsSync(p))
    : [];
  return {
    status: existsSync(path) ? "resolved" : "file-not-found",
    path,
    unresolvedVariables: [],
    substitutionCandidates,
  };
}

export const recognizedModelFormat = (path: string): boolean => {
  const lower = path.toLowerCase();
  return RECOGNIZED_MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

// ---------------------------------------------------------------------------------------------
// GLB measurement
// ---------------------------------------------------------------------------------------------

export type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

export type GlbRootNode = {
  name: string;
  /** Model origin after the full transform chain, KiCad board mm (Z up). */
  origin: Vec3;
  /** Exact vertex bounds, KiCad board mm; null when the node carries no triangles. */
  bounds: Bounds | null;
  vertices: number;
};

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix) {
    if (node.matrix.length !== 16 || !node.matrix.every(Number.isFinite))
      throw new Error("invalid node matrix");
    return node.matrix;
  }
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const values = [x, y, z, w, sx, sy, sz, tx, ty, tz];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v)))
    throw new Error("invalid node transform");
  const [qx, qy, qz, qw, ax, ay, az, bx, by, bz] = values as number[];
  return [
    (1 - 2 * (qy! * qy! + qz! * qz!)) * ax!,
    2 * (qx! * qy! + qz! * qw!) * ax!,
    2 * (qx! * qz! - qy! * qw!) * ax!,
    0,
    2 * (qx! * qy! - qz! * qw!) * ay!,
    (1 - 2 * (qx! * qx! + qz! * qz!)) * ay!,
    2 * (qy! * qz! + qx! * qw!) * ay!,
    0,
    2 * (qx! * qz! + qy! * qw!) * az!,
    2 * (qy! * qz! - qx! * qw!) * az!,
    (1 - 2 * (qx! * qx! + qy! * qy!)) * az!,
    0,
    bx!,
    by!,
    bz!,
    1,
  ];
}

type GltfNode = {
  name?: string;
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};
type Gltf = {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    sparse?: unknown;
  }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  asset?: { generator?: string; extras?: Record<string, unknown> };
};

/** glTF (metres, Y-up) → KiCad board frame (mm, Y down the page, Z up from the board). */
const toBoard = (x: number, y: number, z: number): Vec3 => ({
  x: x * 1000,
  y: z * 1000,
  z: y * 1000,
});

/** Parses a binary glTF and returns every scene-root child with its exact transformed vertex bounds. */
export function measureGlb(bytes: Uint8Array): { generator: string | null; roots: GlbRootNode[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error("not a binary glTF file");
  if (view.getUint32(4, true) !== 2) throw new Error("unsupported glTF version");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error("glTF JSON chunk missing");
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf;
  let binOffset = -1;
  const binHeader = 20 + jsonLength;
  if (binHeader + 8 <= bytes.byteLength && view.getUint32(binHeader + 4, true) === 0x004e4942)
    binOffset = binHeader + 8;
  const nodes = gltf.nodes ?? [];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  if (!scene) throw new Error("glTF has no scene");

  const accumulate = (
    index: number,
    parent: Mat4,
    bounds: Bounds,
    counter: { vertices: number },
    seen: Set<number>,
  ) => {
    if (seen.has(index)) throw new Error("cyclic glTF node graph");
    seen.add(index);
    const node = nodes[index];
    if (!node) throw new Error(`glTF node ${index} missing`);
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = gltf.meshes?.[node.mesh];
      if (!mesh) throw new Error(`glTF mesh ${node.mesh} missing`);
      for (const primitive of mesh.primitives) {
        const accessor = gltf.accessors?.[primitive.attributes["POSITION"] ?? -1];
        if (!accessor) continue;
        if (
          accessor.sparse ||
          accessor.componentType !== 5126 ||
          accessor.type !== "VEC3" ||
          accessor.bufferView === undefined
        )
          throw new Error("unsupported glTF POSITION accessor");
        const bufferView = gltf.bufferViews?.[accessor.bufferView];
        if (!bufferView || bufferView.buffer !== 0 || binOffset < 0)
          throw new Error("glTF POSITION data outside the GLB binary chunk");
        const stride = bufferView.byteStride ?? 12;
        const start = binOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        if (start + stride * (accessor.count - 1) + 12 > bytes.byteLength)
          throw new Error("glTF accessor exceeds buffer");
        const m = world;
        for (let v = 0; v < accessor.count; v++) {
          const o = start + v * stride;
          const x = view.getFloat32(o, true);
          const y = view.getFloat32(o + 4, true);
          const z = view.getFloat32(o + 8, true);
          const p = toBoard(
            m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
            m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
            m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
          );
          if (p.x < bounds.minX) bounds.minX = p.x;
          if (p.y < bounds.minY) bounds.minY = p.y;
          if (p.z < bounds.minZ) bounds.minZ = p.z;
          if (p.x > bounds.maxX) bounds.maxX = p.x;
          if (p.y > bounds.maxY) bounds.maxY = p.y;
          if (p.z > bounds.maxZ) bounds.maxZ = p.z;
        }
        counter.vertices += accessor.count;
      }
    }
    for (const c of node.children ?? []) accumulate(c, world, bounds, counter, seen);
  };

  // KiCad writes one unnamed assembly root whose children are the board body and the models.
  const top = scene.nodes ?? [];
  const container =
    top.length === 1 && nodes[top[0]!] && nodes[top[0]!]!.mesh === undefined ? top[0]! : null;
  const rootMatrix = container === null ? IDENTITY : localMatrix(nodes[container]!);
  const rootChildren = container === null ? top : (nodes[container]!.children ?? []);
  const roots = rootChildren.map((index): GlbRootNode => {
    const node = nodes[index]!;
    const world = multiply(rootMatrix, localMatrix(node));
    const bounds: Bounds = {
      minX: Infinity,
      minY: Infinity,
      minZ: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      maxZ: -Infinity,
    };
    const counter = { vertices: 0 };
    accumulate(index, rootMatrix, bounds, counter, new Set());
    return {
      name: node.name ?? "",
      origin: toBoard(world[12]!, world[13]!, world[14]!),
      bounds: counter.vertices ? bounds : null,
      vertices: counter.vertices,
    };
  });
  return { generator: gltf.asset?.generator ?? null, roots };
}

// ---------------------------------------------------------------------------------------------
// Packaged-runtime export
// ---------------------------------------------------------------------------------------------

export const MECHANICAL_GLB_ARGS = [
  "pcb",
  "export",
  "glb",
  "--force",
  "--subst-models",
  "--user-origin",
  "0x0mm",
] as const;

export type RuntimeModelDiagnostic = { ref: string; message: string };

/**
 * Exports components and board body only (no copper, silkscreen or mask, no fusing) with the
 * absolute board origin, so node coordinates are board coordinates.
 */
export async function exportMechanicalGlb(
  cli: KicadCli,
  options: { board: string; output: string; signal?: AbortSignal },
): Promise<{ exitCode: number; diagnostics: RuntimeModelDiagnostic[]; outputLines: string[] }> {
  const result = await runKicadCli(
    cli,
    [...MECHANICAL_GLB_ARGS, "-o", options.output, options.board],
    {
      tolerateExit: true,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!existsSync(options.output))
    throw new Error(
      `pcb export glb wrote no file (${result.exitCode}): ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`,
    );
  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const diagnostics: RuntimeModelDiagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^Could not add 3D model for (.+?)\.$/.exec(lines[i]!);
    if (match) diagnostics.push({ ref: match[1]!, message: lines[i + 1] ?? "" });
  }
  return {
    exitCode: result.exitCode,
    diagnostics,
    outputLines: lines
      .filter((l) => !/schema file .* not found|^Binary GLTF file|^Export time/.test(l))
      .slice(0, 50),
  };
}

// ---------------------------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------------------------

export type Provenance = "saved-native" | "packaged-runtime-measured" | "computed";
export type MechanicalStatus = "present" | "partial" | "missing" | "inapplicable" | "not-requested";

const mm = (n: number) => Math.round(n * 1e4) / 1e4;
const roundBounds = (b: Bounds): Bounds => ({
  minX: mm(b.minX),
  minY: mm(b.minY),
  minZ: mm(b.minZ),
  maxX: mm(b.maxX),
  maxY: mm(b.maxY),
  maxZ: mm(b.maxZ),
});
const union = (a: Bounds | null, b: Bounds): Bounds =>
  a
    ? {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        minZ: Math.min(a.minZ, b.minZ),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
        maxZ: Math.max(a.maxZ, b.maxZ),
      }
    : { ...b };

export type MechanicalIssue = {
  code:
    | "missing-model-file"
    | "unresolved-model-path"
    | "unsupported-model-format"
    | "unloadable-model"
    | "model-attribution-indeterminate"
    | "invalid-model-transform"
    | "invalid-footprint-placement"
    | "ambiguous-reference"
    | "unattributed-geometry"
    | "runtime-resolution-disagreement"
    | "inconsistent-mount-plane"
    | "no-model-declared";
  severity: "error" | "warning" | "info";
  ref?: string;
  model?: number;
  message: string;
};

type ModelLoadStatus =
  | "loaded"
  | "hidden"
  | "missing-file"
  | "unresolved-path"
  | "unloadable"
  | "indeterminate";

type FootprintReport = {
  ref: string | null;
  uuid: string | null;
  footprint: string;
  side: SavedFootprint["side"];
  dnp: boolean;
  placement:
    | (NonNullable<SavedFootprint["placement"]> & { provenance: "saved-native" })
    | { status: "missing"; provenance: "saved-native" };
  status:
    | "measured"
    | "partial"
    | "no-model"
    | "hidden-models-only"
    | "no-geometry"
    | "ambiguous-reference";
  models: Array<{
    index: number;
    declared: string;
    hidden: boolean;
    offset: Vec3 | null;
    scale: Vec3 | null;
    rotate: Vec3 | null;
    resolution: {
      status: ModelResolution["status"];
      path: string | null;
      sha256?: string;
      substitutedBy?: string[];
    };
    load: { status: ModelLoadStatus; formatRecognized: boolean; origin?: Vec3; vertices?: number };
  }>;
  bounds:
    | (Bounds & { units: "mm"; provenance: "packaged-runtime-measured" })
    | { status: "missing"; reason: string };
  height:
    | {
        aboveTopMm: number | null;
        belowBottomMm: number | null;
        references: { top: string | null; bottom: string | null };
        provenance: "computed";
      }
    | { status: "missing"; reason: string };
};

export type MechanicalSection = {
  contract: typeof MECHANICAL_CONTRACT;
  status: MechanicalStatus;
  source: {
    pcbRevision: string;
    collector: typeof MECHANICAL_COLLECTOR;
    toolchain: {
      kicadCli: { path: string; version: string };
      command: string;
      glbGenerator: string | null;
      exitCode: number;
    };
    geometry: string;
    coordinateFrame: Record<string, string>;
    provenance: Record<Provenance, string>;
    cache: { status: "hit" | "miss" | "disabled"; key: string | null; reason?: string };
  };
  coverage: Record<string, number>;
  board: {
    body:
      | (Bounds & { units: "mm"; provenance: "packaged-runtime-measured" })
      | { status: "missing"; reason: string };
    mountPlanes: Record<
      "top" | "bottom",
      | { zMm: number; provenance: "computed"; derivedFrom: string; samples: number }
      | { status: "missing" | "inconsistent"; reason: string }
    >;
  };
  footprints: FootprintReport[];
  assembly:
    | {
        bounds: Bounds & { units: "mm"; provenance: "computed" };
        maxHeightAboveTopMm:
          | { value: number; ref: string | null }
          | { status: "missing"; reason: string };
        maxDepthBelowBottomMm:
          | { value: number; ref: string | null }
          | { status: "missing"; reason: string };
        footprintsIncluded: number;
      }
    | { status: "missing"; reason: string };
  interference: {
    excluded: string[];
    broadPhaseOverlapCandidates: {
      method: "axis-aligned board-space bounds intersection (not a collision proof)";
      toleranceMm: number;
      count: number;
      truncated: boolean;
      pairs: Array<{ a: string; b: string; overlapMm: Vec3; provenance: "computed" }>;
    };
    collision: { status: "unsupported"; reason: string };
  };
  issues: MechanicalIssue[];
  runtimeDiagnostics: string[];
};

const OVERLAP_TOLERANCE_MM = 1e-3;
const PLANE_TOLERANCE_MM = 1e-3;

export type MechanicalInputs = {
  projectDir: string;
  boardText: string;
  pcbRevision: string;
  cli: { path: string; version: string };
  glb: { generator: string | null; roots: GlbRootNode[] };
  exitCode: number;
  diagnostics: RuntimeModelDiagnostic[];
  outputLines: string[];
  env?: NodeJS.ProcessEnv;
  cache: MechanicalSection["source"]["cache"];
  modelHashes?: Map<string, string>;
};

const projectRelativeOrAbsolute = (projectDir: string, path: string | null) => {
  if (!path) return null;
  const rel = relative(projectDir, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
};

/** Pure assembly of the mechanical section from saved-native references and the measured GLB. */
export function assembleMechanicalSection(input: MechanicalInputs): MechanicalSection {
  const saved = readSavedBoardModels(input.boardText);
  const issues: MechanicalIssue[] = [];
  const refCounts = new Map<string, number>();
  for (const fp of saved)
    if (fp.ref !== null) refCounts.set(fp.ref, (refCounts.get(fp.ref) ?? 0) + 1);
  const nodesByRef = new Map<string, GlbRootNode[]>();
  const unattributed: GlbRootNode[] = [];
  for (const node of input.glb.roots) {
    if (refCounts.has(node.name)) {
      const list = nodesByRef.get(node.name) ?? [];
      list.push(node);
      nodesByRef.set(node.name, list);
    } else unattributed.push(node);
  }
  // The board body is the one unnamed/unreferenced root with geometry; anything else is reported.
  const bodyCandidates = unattributed.filter((n) => n.bounds);
  const body = bodyCandidates.length === 1 ? bodyCandidates[0]! : null;
  for (const node of bodyCandidates.length === 1 ? [] : bodyCandidates)
    issues.push({
      code: "unattributed-geometry",
      severity: "warning",
      message: `GLB node "${node.name}" matches no footprint reference and could not be identified as the single board body.`,
    });
  const runtimeMissing = new Map<string, string[]>();
  for (const d of input.diagnostics)
    runtimeMissing.set(d.ref, [...(runtimeMissing.get(d.ref) ?? []), d.message]);

  const topSamples: number[] = [];
  const bottomSamples: number[] = [];
  const footprints: FootprintReport[] = saved.map((fp) => {
    const ref = fp.ref;
    const ambiguous = ref === null || (refCounts.get(ref) ?? 0) > 1;
    const nodes = ref !== null && !ambiguous ? (nodesByRef.get(ref) ?? []) : [];
    if (!fp.placement)
      issues.push({
        code: "invalid-footprint-placement",
        severity: "error",
        ...(ref ? { ref } : {}),
        message: `${ref ?? fp.footprint} has no readable saved placement.`,
      });
    const models = fp.models.map((model) => {
      const resolution = resolveModelPath(model.declared, input.projectDir, input.env);
      for (const issue of model.issues)
        issues.push({
          code: "invalid-model-transform",
          severity: "error",
          ...(ref ? { ref } : {}),
          model: model.index,
          message: `${ref} model ${model.index} has an unreadable offset/scale/rotate.`,
        });
      const sha = resolution.path ? input.modelHashes?.get(resolution.path) : undefined;
      return {
        index: model.index,
        declared: model.declared,
        hidden: model.hidden,
        offset: model.offset,
        scale: model.scale,
        rotate: model.rotate,
        resolution: {
          status: resolution.status,
          path: projectRelativeOrAbsolute(input.projectDir, resolution.path),
          ...(sha ? { sha256: sha } : {}),
          ...(resolution.substitutionCandidates.length
            ? {
                substitutedBy: resolution.substitutionCandidates.map(
                  (p) => projectRelativeOrAbsolute(input.projectDir, p)!,
                ),
              }
            : {}),
        },
        load: <FootprintReport["models"][number]["load"]>{
          status: (model.hidden
            ? "hidden"
            : resolution.status === "file-not-found" || resolution.status === "empty-path"
              ? "missing-file"
              : "indeterminate") as ModelLoadStatus,
          formatRecognized: recognizedModelFormat(resolution.path ?? model.declared),
        },
        _resolution: resolution,
      };
    });
    // Candidates are visible models that KiCad could have loaded, in declared order.
    const candidates = models.filter((m) => m.load.status === "indeterminate");
    if (ref !== null && !ambiguous) {
      const reported = runtimeMissing.get(ref) ?? [];
      if (reported.length && !models.some((m) => m.load.status === "missing-file"))
        issues.push({
          code: "runtime-resolution-disagreement",
          severity: "warning",
          ref,
          message: `kicad-cli reported ${reported.join("; ")} for ${ref} although the collector resolved every declared file.`,
        });
      if (nodes.length === candidates.length)
        candidates.forEach(
          (m, i) =>
            (m.load = {
              ...m.load,
              status: "loaded",
              origin: roundVec(nodes[i]!.origin),
              vertices: nodes[i]!.vertices,
            }),
        );
      else if (nodes.length === 0)
        candidates.forEach(
          (m) =>
            (m.load = {
              ...m.load,
              // KiCad's own "File not found" outranks the collector's resolution.
              status:
                m._resolution.status === "unresolved-variable"
                  ? "unresolved-path"
                  : reported.length && candidates.length === 1
                    ? "missing-file"
                    : "unloadable",
            }),
        );
      else if (candidates.length === 1 && nodes.length > 1) {
        issues.push({
          code: "unattributed-geometry",
          severity: "warning",
          ref,
          message: `${ref} emitted ${nodes.length} model nodes for one loadable model reference.`,
        });
      } else {
        issues.push({
          code: "model-attribution-indeterminate",
          severity: "warning",
          ref,
          message: `${ref}: ${nodes.length} of ${candidates.length} candidate models loaded; which ones cannot be attributed from the export. Footprint bounds remain exact.`,
        });
      }
    }
    for (const m of models) {
      const where = { ...(ref ? { ref } : {}), model: m.index };
      if (m.load.status === "missing-file")
        issues.push({
          code: "missing-model-file",
          severity: "warning",
          ...where,
          message: `${ref} declares ${m.declared}, which does not exist.`,
        });
      else if (m.load.status === "unresolved-path")
        issues.push({
          code: "unresolved-model-path",
          severity: "warning",
          ...where,
          message: `${ref} model path ${m.declared} uses undefined variable(s) ${m._resolution.unresolvedVariables.join(", ")} and produced no geometry.`,
        });
      else if (m.load.status === "unloadable")
        issues.push(
          m.load.formatRecognized
            ? {
                code: "unloadable-model",
                severity: "warning",
                ...where,
                message: `${ref} model ${m.declared} exists but the packaged runtime produced no geometry for it.`,
              }
            : {
                code: "unsupported-model-format",
                severity: "warning",
                ...where,
                message: `${ref} model ${m.declared} has an unrecognised format and the packaged runtime produced no geometry for it.`,
              },
        );
    }
    if (!fp.models.length)
      issues.push({
        code: "no-model-declared",
        severity: "info",
        ...(ref ? { ref } : {}),
        message: `${ref ?? fp.footprint} declares no 3D model.`,
      });
    if (ambiguous && fp.models.length)
      issues.push({
        code: "ambiguous-reference",
        severity: "error",
        ...(ref ? { ref } : {}),
        message: `${ref ?? "<no reference>"} is not a unique reference, so exported geometry cannot be attributed to this footprint.`,
      });

    let bounds: Bounds | null = null;
    for (const node of nodes) if (node.bounds) bounds = union(bounds, node.bounds);
    // Mount plane samples: model origin minus its saved offset (bottom-side models are mirrored).
    for (const m of models) {
      if (m.load.status !== "loaded" || !m.load.origin || !m.offset) continue;
      if (fp.side === "top") topSamples.push(m.load.origin.z - m.offset.z);
      if (fp.side === "bottom") bottomSamples.push(m.load.origin.z + m.offset.z);
    }
    const visible = models.filter((m) => !m.hidden);
    const loaded = models.filter((m) => m.load.status === "loaded").length;
    const status: FootprintReport["status"] =
      ambiguous && fp.models.length
        ? "ambiguous-reference"
        : !fp.models.length
          ? "no-model"
          : !visible.length
            ? "hidden-models-only"
            : !bounds
              ? "no-geometry"
              : loaded === visible.length
                ? "measured"
                : "partial";
    return {
      ref,
      uuid: fp.uuid,
      footprint: fp.footprint,
      side: fp.side,
      dnp: fp.dnp,
      placement: fp.placement
        ? { ...fp.placement, provenance: "saved-native" as const }
        : { status: "missing" as const, provenance: "saved-native" as const },
      status,
      models: models.map(({ _resolution, ...rest }) => rest),
      bounds: bounds
        ? {
            ...roundBounds(bounds),
            units: "mm" as const,
            provenance: "packaged-runtime-measured" as const,
          }
        : {
            status: "missing" as const,
            reason:
              status === "ambiguous-reference"
                ? "reference is not unique"
                : status === "no-model"
                  ? "no 3D model declared"
                  : status === "hidden-models-only"
                    ? "every declared model is hidden"
                    : "no declared model produced geometry",
          },
      height: { status: "missing" as const, reason: "pending" },
      _bounds: bounds,
    } as FootprintReport & { _bounds: Bounds | null };
  });

  const plane = (samples: number[], side: "top" | "bottom") => {
    if (!samples.length)
      return {
        status: "missing" as const,
        reason: `no loaded ${side}-side model origin to measure the ${side} mount plane`,
      };
    const lo = Math.min(...samples);
    const hi = Math.max(...samples);
    if (hi - lo > PLANE_TOLERANCE_MM) {
      issues.push({
        code: "inconsistent-mount-plane",
        severity: "warning",
        message: `${side}-side model origins disagree on the mount plane (${mm(lo)}..${mm(hi)} mm).`,
      });
      return {
        status: "inconsistent" as const,
        reason: `${side}-side model origins span ${mm(lo)}..${mm(hi)} mm`,
      };
    }
    return {
      zMm: mm((lo + hi) / 2),
      provenance: "computed" as const,
      derivedFrom:
        "packaged-runtime model origin Z minus saved-native model offset Z (mirrored on the bottom side)",
      samples: samples.length,
    };
  };
  const mountPlanes = { top: plane(topSamples, "top"), bottom: plane(bottomSamples, "bottom") };
  const bodyBounds = body?.bounds ?? null;
  const topRef =
    "zMm" in mountPlanes.top
      ? { z: mountPlanes.top.zMm, label: "top mount plane" }
      : bodyBounds
        ? { z: bodyBounds.maxZ, label: "board body top face" }
        : null;
  const bottomRef =
    "zMm" in mountPlanes.bottom
      ? { z: mountPlanes.bottom.zMm, label: "bottom mount plane" }
      : bodyBounds
        ? { z: bodyBounds.minZ, label: "board body bottom face" }
        : null;

  let assembly: Bounds | null = null;
  let tallest: { value: number; ref: string | null } | null = null;
  let deepest: { value: number; ref: string | null } | null = null;
  let included = 0;
  for (const fp of footprints as Array<FootprintReport & { _bounds: Bounds | null }>) {
    const b = fp._bounds;
    delete (fp as { _bounds?: unknown })._bounds;
    if (!b) {
      fp.height = { status: "missing", reason: "no measured bounds" };
      continue;
    }
    included++;
    assembly = union(assembly, b);
    if (!topRef && !bottomRef) {
      fp.height = {
        status: "missing",
        reason: "neither a mount plane nor the board body was measured",
      };
      continue;
    }
    const above = topRef ? mm(Math.max(0, b.maxZ - topRef.z)) : null;
    const below = bottomRef ? mm(Math.max(0, bottomRef.z - b.minZ)) : null;
    fp.height = {
      aboveTopMm: above,
      belowBottomMm: below,
      references: { top: topRef?.label ?? null, bottom: bottomRef?.label ?? null },
      provenance: "computed",
    };
    if (above !== null && (!tallest || above > tallest.value))
      tallest = { value: above, ref: above > 0 ? fp.ref : null };
    if (below !== null && (!deepest || below > deepest.value))
      deepest = { value: below, ref: below > 0 ? fp.ref : null };
  }

  // Broad phase only: sort-and-sweep over X of per-footprint AABBs.
  const boxes = footprints
    .filter((fp) => fp.ref && "units" in fp.bounds)
    .map((fp) => ({ ref: fp.ref!, b: fp.bounds as Bounds }))
    .sort((a, b) => a.b.minX - b.b.minX);
  const pairs: Array<{
    a: string;
    b: string;
    overlapMm: Vec3;
    provenance: "computed";
    volume: number;
  }> = [];
  for (let i = 0; i < boxes.length; i++)
    for (
      let j = i + 1;
      j < boxes.length && boxes[j]!.b.minX < boxes[i]!.b.maxX - OVERLAP_TOLERANCE_MM;
      j++
    ) {
      const a = boxes[i]!.b;
      const b = boxes[j]!.b;
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ox > OVERLAP_TOLERANCE_MM && oy > OVERLAP_TOLERANCE_MM && oz > OVERLAP_TOLERANCE_MM) {
        const [first, second] = [boxes[i]!.ref, boxes[j]!.ref].sort();
        pairs.push({
          a: first!,
          b: second!,
          overlapMm: { x: mm(ox), y: mm(oy), z: mm(oz) },
          provenance: "computed",
          volume: ox * oy * oz,
        });
      }
    }
  pairs.sort((l, r) => r.volume - l.volume || l.a.localeCompare(r.a) || l.b.localeCompare(r.b));
  const pairLimit = Math.max(64, 2 * saved.length);

  const count = (predicate: (m: FootprintReport["models"][number]) => boolean) =>
    footprints.reduce((n, fp) => n + fp.models.filter(predicate).length, 0);
  const coverage = {
    placedFootprints: footprints.length,
    footprintsDeclaringModels: footprints.filter((fp) => fp.models.length).length,
    footprintsWithoutModels: footprints.filter((fp) => !fp.models.length).length,
    declaredModels: count(() => true),
    hiddenModels: count((m) => m.hidden),
    resolvedModels: count((m) => m.resolution.status === "resolved"),
    loadedModels: count((m) => m.load.status === "loaded"),
    missingModels: count((m) => m.load.status === "missing-file"),
    unresolvedModels: count((m) => m.load.status === "unresolved-path"),
    unloadableModels: count((m) => m.load.status === "unloadable" && m.load.formatRecognized),
    unsupportedModels: count((m) => m.load.status === "unloadable" && !m.load.formatRecognized),
    indeterminateModels: count((m) => m.load.status === "indeterminate"),
    footprintsWithBounds: included,
    footprintsWithHeight: footprints.filter((fp) => "provenance" in fp.height).length,
  };
  const status: MechanicalStatus =
    footprints.length === 0
      ? "inapplicable"
      : included === 0
        ? "missing"
        : included === footprints.length && footprints.every((fp) => fp.status === "measured")
          ? "present"
          : "partial";

  return {
    contract: MECHANICAL_CONTRACT,
    status,
    source: {
      pcbRevision: input.pcbRevision,
      collector: MECHANICAL_COLLECTOR,
      toolchain: {
        kicadCli: input.cli,
        command: `kicad-cli ${MECHANICAL_GLB_ARGS.join(" ")} -o <temporary.glb> board.kicad_pcb`,
        glbGenerator: input.glb.generator,
        exitCode: input.exitCode,
      },
      geometry:
        "Exact min/max of packaged-runtime tessellation vertices after each model node's full transform. Curved faces may under-reach the exact B-rep envelope by at most the tessellation chord deviation. No mesh bytes are stored.",
      coordinateFrame: {
        units: "mm",
        x: "KiCad board X",
        y: "KiCad board Y (grows downwards, as in the PCB editor)",
        z: "up, normal to the board; top-side parts have Z above the top mount plane",
        origin: "KiCad absolute board origin",
      },
      provenance: {
        "saved-native": "read from the exact saved board.kicad_pcb bytes at source.pcbRevision",
        "packaged-runtime-measured":
          "measured from the packaged kicad-cli GLB export of those bytes",
        computed: "derived by this collector from saved-native and measured values",
      },
      cache: input.cache,
    },
    coverage,
    board: {
      body: bodyBounds
        ? { ...roundBounds(bodyBounds), units: "mm", provenance: "packaged-runtime-measured" }
        : {
            status: "missing",
            reason:
              bodyCandidates.length > 1
                ? "several unattributed nodes; board body not identifiable"
                : "the export produced no board body (check the board outline)",
          },
      mountPlanes,
    },
    footprints,
    assembly: assembly
      ? {
          bounds: { ...roundBounds(assembly), units: "mm", provenance: "computed" },
          maxHeightAboveTopMm: tallest ?? {
            status: "missing",
            reason: "no footprint height above the top reference was measurable",
          },
          maxDepthBelowBottomMm: deepest ?? {
            status: "missing",
            reason: "no footprint depth below the bottom reference was measurable",
          },
          footprintsIncluded: included,
        }
      : { status: "missing", reason: "no footprint has measured bounds" },
    interference: {
      excluded: [
        "board body",
        "model pairs within one footprint",
        "footprints without measured bounds",
      ],
      broadPhaseOverlapCandidates: {
        method: "axis-aligned board-space bounds intersection (not a collision proof)",
        toleranceMm: OVERLAP_TOLERANCE_MM,
        count: pairs.length,
        truncated: pairs.length > pairLimit,
        pairs: pairs.slice(0, pairLimit).map(({ volume, ...pair }) => pair),
      },
      collision: {
        status: "unsupported",
        reason:
          "No geometry-level intersection test is performed; broad-phase candidates may be separated bodies whose boxes overlap.",
      },
    },
    issues,
    runtimeDiagnostics: input.outputLines,
  };
}

const roundVec = (v: Vec3): Vec3 => ({ x: mm(v.x), y: mm(v.y), z: mm(v.z) });

// ---------------------------------------------------------------------------------------------
// Collection with a process-local, content-keyed cache
// ---------------------------------------------------------------------------------------------

/** Most recent measurements kept per process; a 245-footprint section is ~250 KB as JSON. */
export const MECHANICAL_CACHE_LIMIT = 8;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Bounded LRU of sections this process measured itself. Nothing is read from or written to disk:
 * project files are writable by anything that can edit the project, so a stored result there could
 * be fabricated wholesale (bounds, counts, contract, collector, toolchain and key alike). Entries
 * are deep-frozen private copies and every hit is a fresh clone, so callers cannot alter later
 * hits. A process restart always starts cold.
 */
export class MechanicalMemo {
  readonly #entries = new Map<string, MechanicalSection>();
  constructor(readonly limit: number) {}

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): MechanicalSection | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return structuredClone(entry);
  }

  set(key: string, section: MechanicalSection): void {
    this.#entries.delete(key);
    this.#entries.set(key, deepFreeze(structuredClone(section)));
    while (this.#entries.size > this.limit)
      this.#entries.delete(this.#entries.keys().next().value!);
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** The collector's cache; exported so tests can observe and reset it. */
export const mechanicalMemo = new MechanicalMemo(MECHANICAL_CACHE_LIMIT);

const PROCESS_CACHE_HIT =
  "copy of a measurement this process computed for identical content; kept in memory only";
const PROCESS_CACHE_MISS =
  "measured now; kept in this process's memory only (a restart measures again)";

async function sha256File(path: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return null;
  }
}

const MODEL_ABSENT = "absent";

/** Path → content sha256, or {@link MODEL_ABSENT} when the file is missing. */
async function snapshotModelFiles(
  saved: SavedFootprint[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ identity: Map<string, string>; cacheable: boolean }> {
  const identity = new Map<string, string>();
  let cacheable = true;
  for (const fp of saved)
    for (const model of fp.models) {
      const resolution = resolveModelPath(model.declared, projectDir, env);
      if (resolution.status === "unresolved-variable") cacheable = false;
      for (const path of [resolution.path, ...resolution.substitutionCandidates]) {
        if (!path || identity.has(path)) continue;
        identity.set(path, (await sha256File(path)) ?? MODEL_ABSENT);
      }
    }
  return { identity, cacheable };
}

async function rehashModelFiles(
  before: Map<string, string>,
  saved: SavedFootprint[],
  projectDir: string,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  const { identity } = await snapshotModelFiles(saved, projectDir, env);
  for (const path of before.keys()) {
    if (!identity.has(path)) identity.set(path, (await sha256File(path)) ?? MODEL_ABSENT);
  }
  return identity;
}

function modelFilesChanged(before: Map<string, string>, after: Map<string, string>): boolean {
  if (before.size !== after.size) return true;
  for (const [path, digest] of before) if (after.get(path) !== digest) return true;
  return false;
}

function modelHashesFromIdentity(identity: Map<string, string>): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const [path, digest] of identity) if (digest !== MODEL_ABSENT) hashes.set(path, digest);
  return hashes;
}

/**
 * Measures the saved board. `scratchDir` must already be jailed to the project by the caller; it
 * only holds the temporary GLB, which is deleted before returning or throwing. Results are cached
 * in {@link mechanicalMemo} only. The key binds the exact PCB bytes, every resolved model file (and
 * VRML substitution candidate) by content, the project, the runtime identity and this collector's
 * version; any unresolved path disables caching. After the GLB export the PCB bytes and that same
 * model path set are re-hashed, including files that appeared or disappeared; any difference throws
 * before the GLB is parsed or a cache entry is stored.
 */
export async function collectMechanical(
  cli: KicadCli,
  options: {
    projectDir: string;
    board: string;
    scratchDir: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<MechanicalSection> {
  const env = options.env ?? process.env;
  const boardBytes = await readFile(options.board);
  const boardText = boardBytes.toString("utf8");
  const pcbRevision = createHash("sha256").update(boardBytes).digest("hex");
  const saved = readSavedBoardModels(boardText);
  const { identity, cacheable } = await snapshotModelFiles(saved, options.projectDir, env);
  const modelHashes = modelHashesFromIdentity(identity);
  const keyParts = [...identity].map(([path, digest]) => `${path}\0${digest}`);
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        MECHANICAL_COLLECTOR,
        cli.path,
        cli.version,
        pcbRevision,
        options.projectDir,
        [...new Set(keyParts)].sort(),
      ]),
    )
    .digest("hex");
  const cached = cacheable ? mechanicalMemo.get(key) : undefined;
  if (cached) {
    cached.source.cache = { status: "hit", key, reason: PROCESS_CACHE_HIT };
    return cached;
  }
  await mkdir(options.scratchDir, { recursive: true });
  const glbPath = join(options.scratchDir, `mechanical-${randomUUID()}.glb`);
  try {
    const exported = await exportMechanicalGlb(cli, {
      board: options.board,
      output: glbPath,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const after = await readFile(options.board);
    if (createHash("sha256").update(after).digest("hex") !== pcbRevision)
      throw new Error(
        "board.kicad_pcb changed during mechanical measurement; re-run design_inspect",
      );
    const afterModels = await rehashModelFiles(identity, saved, options.projectDir, env);
    if (modelFilesChanged(identity, afterModels))
      throw new Error("model files changed during mechanical measurement; re-run design_inspect");
    const glb = measureGlb(await readFile(glbPath));
    const section = assembleMechanicalSection({
      projectDir: options.projectDir,
      boardText,
      pcbRevision,
      cli: { path: cli.path, version: cli.version },
      glb,
      exitCode: exported.exitCode,
      diagnostics: exported.diagnostics,
      outputLines: exported.outputLines,
      env,
      modelHashes,
      cache: cacheable
        ? { status: "miss", key, reason: PROCESS_CACHE_MISS }
        : { status: "disabled", key: null, reason: "a model path uses an undefined variable" },
    });
    if (cacheable) mechanicalMemo.set(key, section);
    return section;
  } finally {
    await rm(glbPath, { force: true });
  }
}
