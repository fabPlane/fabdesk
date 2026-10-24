/**
 * Kernel-agnostic mechanical CAD: one interface, several geometry kernels.
 * The default is FreeCAD / OpenCascade; SMLib (NVIDIA USD BRep) is experimental.
 */
import { z } from "zod/v4";

export const CadKernelId = z.enum(["opencascade", "smlib"]);
export type CadKernelId = z.infer<typeof CadKernelId>;

export const CadKernelChoice = z.enum(["auto", "opencascade", "smlib"]);
export type CadKernelChoice = z.infer<typeof CadKernelChoice>;

export const CadSolidKind = z.enum(["box", "cylinder", "sphere"]);
export const CadSolidFeature = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("box"),
    lengthMm: z.number().positive(),
    widthMm: z.number().positive(),
    heightMm: z.number().positive(),
  }),
  z.object({
    kind: z.literal("cylinder"),
    radiusMm: z.number().positive(),
    heightMm: z.number().positive(),
  }),
  z.object({
    kind: z.literal("sphere"),
    radiusMm: z.number().positive(),
  }),
]);
export type CadSolidFeature = z.infer<typeof CadSolidFeature>;

export const CadModifyFeature = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fillet"),
    radiusMm: z.number().positive(),
    continuity: z.enum(["G1", "G2"]).optional(),
  }),
  z.object({
    kind: z.literal("chamfer"),
    distanceMm: z.number().positive(),
  }),
  z.object({
    kind: z.literal("cut_cylinder"),
    radiusMm: z.number().positive(),
    heightMm: z.number().positive(),
    xMm: z.number().default(0),
    yMm: z.number().default(0),
    zMm: z.number().default(0),
  }),
]);
export type CadModifyFeature = z.infer<typeof CadModifyFeature>;

export const CadFeature = z.union([CadSolidFeature, CadModifyFeature]);
export type CadFeature = z.infer<typeof CadFeature>;

export const CadPartHints = z.object({
  /** Consumer / hand-held surfaces that want curvature-continuous blends. */
  consumerSurface: z.boolean().optional(),
  /** Prismatic / CAM-oriented parts. */
  machined: z.boolean().optional(),
});
export type CadPartHints = z.infer<typeof CadPartHints>;

export const CadPartPlacement = z.object({
  xMm: z.number().default(0),
  yMm: z.number().default(0),
  zMm: z.number().default(0),
});
export type CadPartPlacement = z.infer<typeof CadPartPlacement>;

export const CadPartSpec = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/, "part id must be a short identifier"),
  name: z.string().min(1).max(80).optional(),
  features: z.array(CadFeature).min(1),
  kernel: CadKernelChoice.optional(),
  hints: CadPartHints.optional(),
  placement: CadPartPlacement.optional(),
});
export type CadPartSpec = z.infer<typeof CadPartSpec>;

export type CadKernelCapabilities = {
  solids: boolean;
  fillets: boolean;
  g2Fillets: boolean;
  chamfers: boolean;
  lofts: boolean;
  step: boolean;
  brep: boolean;
};

export type CadKernelHealth = {
  id: CadKernelId;
  label: string;
  experimental: boolean;
  available: boolean;
  detail: string;
  capabilities: CadKernelCapabilities;
};

export type CadKernelBuildResult = {
  kernel: CadKernelId;
  step: string;
  format: "step" | "brep";
  volumeMm3?: number;
  faces?: number;
  notes: string[];
};

/** A feature the chosen kernel could not build (fillet too large, missing G2, …). */
export class CadFeatureError extends Error {
  readonly code = "cad_feature" as const;
  constructor(
    message: string,
    readonly kernel: CadKernelId,
    readonly featureKind: string,
  ) {
    super(message);
    this.name = "CadFeatureError";
  }
}

export function isCadFeatureError(e: unknown): e is CadFeatureError {
  return e instanceof CadFeatureError || (e instanceof Error && e.name === "CadFeatureError");
}

/** Kernel is configured but not reachable (FreeCAD down, Python missing, experimental off). */
export class CadKernelUnavailableError extends Error {
  readonly code = "cad_kernel_unavailable" as const;
  constructor(
    message: string,
    readonly kernel: CadKernelId,
  ) {
    super(message);
    this.name = "CadKernelUnavailableError";
  }
}

export function isCadKernelUnavailableError(e: unknown): e is CadKernelUnavailableError {
  return (
    e instanceof CadKernelUnavailableError ||
    (e instanceof Error && e.name === "CadKernelUnavailableError")
  );
}

export interface CadKernel {
  readonly id: CadKernelId;
  readonly label: string;
  readonly experimental: boolean;
  capabilities(): CadKernelCapabilities;
  health(): Promise<CadKernelHealth>;
  buildPart(spec: CadPartSpec, destStep: string, projectDir: string): Promise<CadKernelBuildResult>;
  /** Import several STEP files into one assembly STEP (exact B-rep when the kernel can). */
  combineSteps?(
    parts: Array<{ id: string; step: string; xMm: number; yMm: number; zMm: number }>,
    destStep: string,
    projectDir: string,
  ): Promise<{ step: string; notes: string[] }>;
}

export type CadKernelSwitch = {
  from: CadKernelId;
  to: CadKernelId;
  featureKind: string;
  error: string;
};

export type CadPartRecord = {
  id: string;
  name: string;
  kernel: CadKernelId;
  requested: CadKernelChoice;
  reason: string;
  fallbacks: CadKernelSwitch[];
  step: string;
  features: CadFeature[];
  placement?: CadPartPlacement | undefined;
  volumeMm3?: number | undefined;
  faces?: number | undefined;
  builtAt: string;
};

export type CadAssemblyRecord = {
  step: string;
  partIds: string[];
  combinedAt: string;
  notes: string[];
};

export type CadKernelStore = {
  schema: 1;
  parts: CadPartRecord[];
  assembly: CadAssemblyRecord | null;
};

export type CadKernelInfo = CadKernelHealth;
