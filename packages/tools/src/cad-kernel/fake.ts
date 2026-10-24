import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { structuralStep } from "./opencascade";
import {
  CadFeatureError,
  type CadKernel,
  type CadKernelBuildResult,
  type CadKernelCapabilities,
  type CadKernelId,
  type CadPartSpec,
} from "./types";

const CAPABILITIES: CadKernelCapabilities = {
  solids: true,
  fillets: true,
  g2Fillets: false,
  chamfers: true,
  lofts: false,
  step: true,
  brep: true,
};

/** In-memory kernel for contract tests. Optionally fail a feature kind. */
export function createFakeKernel(
  opts: {
    id?: CadKernelId;
    label?: string;
    experimental?: boolean;
    available?: boolean;
    failFeature?: string;
    volumeMm3?: number;
  } = {},
): CadKernel & { builds: CadPartSpec[] } {
  const id = opts.id ?? "opencascade";
  const builds: CadPartSpec[] = [];
  const kernel: CadKernel & { builds: CadPartSpec[] } = {
    id,
    label: opts.label ?? `fake ${id}`,
    experimental: opts.experimental ?? false,
    builds,
    capabilities: () => CAPABILITIES,
    async health() {
      return {
        id,
        label: kernel.label,
        experimental: kernel.experimental,
        available: opts.available ?? true,
        detail: opts.available === false ? "fake kernel disabled" : "fake kernel",
        capabilities: CAPABILITIES,
      };
    },
    async buildPart(spec, destStep, _projectDir): Promise<CadKernelBuildResult> {
      builds.push(spec);
      const fail = opts.failFeature;
      if (fail && spec.features.some((f) => f.kind === fail)) {
        throw new CadFeatureError(`fake ${id} cannot ${fail}`, id, fail);
      }
      await mkdir(dirname(destStep), { recursive: true });
      await writeFile(destStep, structuralStep(spec.id, `fake ${id}`), "utf8");
      return {
        kernel: id,
        step: destStep,
        format: "step",
        ...(opts.volumeMm3 !== undefined ? { volumeMm3: opts.volumeMm3 } : {}),
        notes: [`fake ${id}`],
      };
    },
    async combineSteps(parts, destStep, _projectDir) {
      await mkdir(dirname(destStep), { recursive: true });
      const texts = parts.map((p) => ({
        id: p.id,
        text: structuralStep(p.id, `fake ${id} combine`),
        xMm: p.xMm,
        yMm: p.yMm,
        zMm: p.zMm,
      }));
      const { combineStepTexts } = await import("./step-combine");
      await writeFile(destStep, combineStepTexts(texts, { name: "assembly" }), "utf8");
      return { step: destStep, notes: [`fake ${id} combine`] };
    },
  };
  return kernel;
}
