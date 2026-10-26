import type { CadKernelChoice, CadKernelId, CadPartSpec } from "./types";

export type KernelPick = {
  requested: CadKernelChoice;
  preferred: CadKernelId;
  reason: string;
  /** Remaining kernels to try if the preferred one fails a feature. */
  fallbacks: CadKernelId[];
};

/**
 * Heuristic: G2 / consumer surfaces prefer SMLib (NURBS blends); machined / prismatic
 * parts stay on OpenCascade. `kernel: "auto"` (the default) uses this.
 */
export function selectCadKernel(spec: CadPartSpec, available: CadKernelId[]): KernelPick {
  const requested = spec.kernel ?? "auto";
  if (requested !== "auto") {
    return {
      requested,
      preferred: requested,
      reason: `explicit kernel=${requested}`,
      fallbacks: [],
    };
  }
  const wantsSmooth =
    spec.hints?.consumerSurface === true ||
    spec.features.some((f) => f.kind === "fillet" && f.continuity === "G2");
  const wantsMachine =
    spec.hints?.machined === true ||
    spec.features.every((f) => f.kind === "box" || f.kind === "cylinder" || f.kind === "cut_cylinder");

  if (wantsSmooth && available.includes("smlib")) {
    return {
      requested,
      preferred: "smlib",
      reason: "G2 / consumer-surface features prefer SMLib (NURBS, curvature-continuous blends)",
      fallbacks: available.filter((id) => id !== "smlib"),
    };
  }
  if (wantsMachine && available.includes("opencascade")) {
    return {
      requested,
      preferred: "opencascade",
      reason: "prismatic / machined features prefer OpenCascade (exact STEP for CAM)",
      fallbacks: available.filter((id) => id !== "opencascade"),
    };
  }
  const preferred = available[0] ?? "opencascade";
  return {
    requested,
    preferred,
    reason:
      preferred === "smlib"
        ? "SMLib is the only available kernel"
        : "OpenCascade is the default kernel",
    fallbacks: available.filter((id) => id !== preferred),
  };
}
