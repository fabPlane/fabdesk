/**
 * Experimental SMLib backend: NVIDIA's open-sourced NURBS kernel (USD BRep),
 * reached through `smlibpy` (preferred) or `@classcad/smlibwasm`.
 *
 * Not bundled with the default desktop. Enable with FABDESK_EXPERIMENTAL_CAD_KERNELS=1
 * and `pip install smlibpy` or `bun add @classcad/smlibwasm`.
 */
import { spawn } from "node:child_process";
import {
  CadFeatureError,
  CadKernelUnavailableError,
  type CadKernel,
  type CadKernelBuildResult,
  type CadKernelCapabilities,
  type CadKernelHealth,
  type CadPartSpec,
} from "./types";
import { resolveSmlibDriverPath } from "./driver-path";

const CAPABILITIES: CadKernelCapabilities = {
  solids: true,
  fillets: true,
  g2Fillets: true,
  chamfers: true,
  lofts: true,
  step: true,
  brep: true,
};

export type SmlibRuntimeKind = "smlibpy" | "smlibwasm" | null;

export type SmlibProbe = {
  kind: SmlibRuntimeKind;
  detail: string;
  version?: string;
};

const PROBE_CACHE_MS = 30_000;
let probeCache: { at: number; value: SmlibProbe } | null = null;

export function experimentalCadKernelsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env["FABDESK_EXPERIMENTAL_CAD_KERNELS"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "smlib" || v === "on";
}

function pythonBin(env: Record<string, string | undefined> = process.env): string {
  return env["FABDESK_SMLIB_PYTHON"] || env["PYTHON"] || "python3";
}

/** Optional peer. The specifier is built at runtime so typecheck does not require the package. */
async function importSmlibWasm(): Promise<Record<string, unknown>> {
  const spec = ["@classcad", "smlibwasm"].join("/");
  return (await import(spec)) as Record<string, unknown>;
}

class SmlibDriverSpawnError extends Error {
  constructor(
    message: string,
    override readonly cause?: Error,
  ) {
    super(message);
    this.name = "SmlibDriverSpawnError";
  }
}

async function runDriver(
  req: Record<string, unknown>,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const env = opts.env ?? process.env;
  const bin = pythonBin(env);
  const driver = await resolveSmlibDriverPath();
  const child = spawn(bin, [driver], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (d: Buffer) => chunks.push(d));
  child.stderr.on("data", (d: Buffer) => err.push(d));
  const timeout = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      const missing =
        e.code === "ENOENT"
          ? `Python interpreter not found (${bin}); install python3 or set FABDESK_SMLIB_PYTHON`
          : e.message;
      reject(new SmlibDriverSpawnError(missing, e));
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  child.stdin.end(JSON.stringify(req));
  let code: number;
  try {
    code = await done;
  } finally {
    clearTimeout(timeout);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    const stderr = Buffer.concat(err).toString("utf8").slice(0, 400);
    throw new SmlibDriverSpawnError(
      `smlib driver produced no JSON (exit ${code})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function probeSmlib(
  env: Record<string, string | undefined> = process.env,
  opts: { force?: boolean } = {},
): Promise<SmlibProbe> {
  const now = Date.now();
  if (!opts.force && probeCache && now - probeCache.at < PROBE_CACHE_MS) {
    return probeCache.value;
  }
  const record = (value: SmlibProbe) => {
    probeCache = { at: Date.now(), value };
    return value;
  };
  try {
    const out = await runDriver({ op: "health" }, { env, timeoutMs: 15_000 });
    if (out["available"] === true) {
      return record({
        kind: "smlibpy",
        detail: String(out["detail"] ?? "smlibpy"),
        ...(typeof out["version"] === "string" ? { version: out["version"] } : {}),
      });
    }
  } catch (e) {
    const py = e instanceof Error ? e.message : String(e);
    if (e instanceof SmlibDriverSpawnError) {
      return record({ kind: null, detail: py });
    }
    try {
      await importSmlibWasm();
      return record({ kind: "smlibwasm", detail: `@classcad/smlibwasm (${py})` });
    } catch {
      return record({ kind: null, detail: py });
    }
  }
  try {
    await importSmlibWasm();
    return record({ kind: "smlibwasm", detail: "@classcad/smlibwasm" });
  } catch {
    return record({
      kind: null,
      detail: "smlibpy is not installed and @classcad/smlibwasm is not importable",
    });
  }
}

async function buildWithWasm(spec: CadPartSpec, destStep: string): Promise<CadKernelBuildResult> {
  const m = (await importSmlibWasm()) as {
    Box: (l: number, w: number, h: number) => SmlibPart;
    Cylinder: (r: number, h: number) => SmlibPart;
    Sphere: (r: number) => SmlibPart;
    exportStep: (p: SmlibPart, path: string, opts?: { name?: string }) => void;
  };
  type SmlibPart = {
    volume: number;
    faces: () => { length?: number } | Iterable<unknown>;
    edges: () => unknown;
    fillet: (edges: unknown, r: number, opts?: { continuity?: string }) => SmlibPart;
    chamfer: (edges: unknown, d: number) => SmlibPart;
    cut: (other: SmlibPart) => SmlibPart;
    translate: (x: number, y: number, z: number) => SmlibPart;
    named?: (n: string) => SmlibPart;
  };
  let part: SmlibPart | null = null;
  for (const feat of spec.features) {
    try {
      if (feat.kind === "box") part = m.Box(feat.lengthMm, feat.widthMm, feat.heightMm);
      else if (feat.kind === "cylinder") part = m.Cylinder(feat.radiusMm, feat.heightMm);
      else if (feat.kind === "sphere") part = m.Sphere(feat.radiusMm);
      else if (!part) throw new CadFeatureError("first feature must be a solid", "smlib", feat.kind);
      else if (feat.kind === "fillet") {
        part = part.fillet(part.edges(), feat.radiusMm, feat.continuity ? { continuity: feat.continuity } : {});
      } else if (feat.kind === "chamfer") part = part.chamfer(part.edges(), feat.distanceMm);
      else if (feat.kind === "cut_cylinder") {
        const tool = m.Cylinder(feat.radiusMm, feat.heightMm).translate(feat.xMm, feat.yMm, feat.zMm);
        part = part.cut(tool);
      }
    } catch (e) {
      if (e instanceof CadFeatureError) throw e;
      throw new CadFeatureError(e instanceof Error ? e.message : String(e), "smlib", feat.kind);
    }
  }
  if (!part) throw new CadFeatureError("no features", "smlib", "solid");
  const named = spec.name ?? spec.id;
  if (part.named) part = part.named(named);
  m.exportStep(part, destStep, { name: named });
  const faces = part.faces();
  const faceCount = typeof (faces as { length?: number }).length === "number"
    ? (faces as { length: number }).length
    : [...(faces as Iterable<unknown>)].length;
  return {
    kernel: "smlib",
    step: destStep,
    format: "step",
    volumeMm3: part.volume,
    faces: faceCount,
    notes: ["built with @classcad/smlibwasm (NVIDIA SMLib)"],
  };
}

export function createSmlibKernel(
  opts: {
    experimental?: boolean;
    env?: Record<string, string | undefined>;
    probe?: () => Promise<SmlibProbe>;
  } = {},
): CadKernel {
  const env = opts.env ?? process.env;
  const experimental = opts.experimental ?? experimentalCadKernelsEnabled(env);
  const probe = opts.probe ?? (() => probeSmlib(env));

  return {
    id: "smlib",
    label: "SMLib (NVIDIA USD BRep)",
    experimental: true,
    capabilities: () => CAPABILITIES,
    async health(): Promise<CadKernelHealth> {
      if (!experimental) {
        return {
          id: "smlib",
          label: this.label,
          experimental: true,
          available: false,
          detail:
            "experimental: set FABDESK_EXPERIMENTAL_CAD_KERNELS=1 and install smlibpy or @classcad/smlibwasm",
          capabilities: CAPABILITIES,
        };
      }
      const p = await probe();
      return {
        id: "smlib",
        label: this.label,
        experimental: true,
        available: p.kind !== null,
        detail: p.kind
          ? p.detail
          : `${p.detail}. pip install smlibpy, or bun add @classcad/smlibwasm`,
        capabilities: CAPABILITIES,
      };
    },
    async buildPart(spec, destStep, _projectDir): Promise<CadKernelBuildResult> {
      const h = await this.health();
      if (!h.available) {
        throw new CadKernelUnavailableError(h.detail, "smlib");
      }
      const p = await probe();
      if (p.kind === "smlibwasm") return buildWithWasm(spec, destStep);
      const out = await runDriver(
        {
          op: "build",
          id: spec.id,
          name: spec.name ?? spec.id,
          export: destStep,
          features: spec.features,
        },
        { env },
      );
      if (out["ok"] !== true) {
        throw new CadFeatureError(
          String(out["error"] ?? "SMLib build failed"),
          "smlib",
          String(out["featureKind"] ?? spec.features[0]?.kind ?? "solid"),
        );
      }
      return {
        kernel: "smlib",
        step: destStep,
        format: "step",
        ...(typeof out["volumeMm3"] === "number" ? { volumeMm3: out["volumeMm3"] } : {}),
        ...(typeof out["faces"] === "number" ? { faces: out["faces"] } : {}),
        notes: ["built with smlibpy (NVIDIA SMLib / USD BRep)"],
      };
    },
    async combineSteps(parts, destStep, _projectDir) {
      const h = await this.health();
      if (!h.available) throw new CadKernelUnavailableError(h.detail, "smlib");
      const p = await probe();
      if (p.kind === "smlibwasm") {
        const m = (await importSmlibWasm()) as {
          importStep: (path: string) => {
            translate: (x: number, y: number, z: number) => unknown;
            fuse: (...o: unknown[]) => { volume?: number };
          };
          exportStep: (part: unknown, path: string, opts?: { name?: string }) => void;
        };
        const bodies = parts.map((part) =>
          m.importStep(part.step).translate(part.xMm, part.yMm, part.zMm),
        );
        const first = bodies[0];
        if (!first) throw new Error("no parts");
        let assembly: { volume?: number } = first as { fuse: (...o: unknown[]) => { volume?: number }; volume?: number };
        for (const extra of bodies.slice(1))
          assembly = (assembly as { fuse: (...o: unknown[]) => { volume?: number } }).fuse(extra);
        m.exportStep(assembly, destStep, { name: "assembly" });
        return { step: destStep, notes: ["fused with @classcad/smlibwasm"] };
      }
      const out = await runDriver({ op: "combine", export: destStep, parts }, { env });
      if (out["ok"] !== true) throw new Error(String(out["error"] ?? "SMLib combine failed"));
      return { step: destStep, notes: ["fused with smlibpy (exact NURBS B-rep)"] };
    },
  };
}
