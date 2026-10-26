import { readFile, writeFile } from "node:fs/promises";
import type { CadService } from "../services";
import { createOpenCascadeKernel } from "./opencascade";
import { selectCadKernel } from "./select";
import { createSmlibKernel, experimentalCadKernelsEnabled } from "./smlib";
import {
  CAD_ASSEMBLY_STEP,
  assemblyStepAbs,
  loadCadKernelStore,
  partStepAbs,
  partStepRel,
  saveAssembly,
  upsertPart,
} from "./store";
import { combineStepTexts, isStepText } from "./step-combine";
import {
  CadFeatureError,
  CadKernelUnavailableError,
  CadPartSpec,
  isCadFeatureError,
  isCadKernelUnavailableError,
  type CadAssemblyRecord,
  type CadKernel,
  type CadKernelHealth,
  type CadKernelId,
  type CadKernelStore,
  type CadKernelSwitch,
  type CadPartRecord,
} from "./types";

export type CadKernelHost = {
  kernels(): CadKernel[];
  list(): Promise<CadKernelHealth[]>;
  store(projectDir: string): Promise<CadKernelStore>;
  buildPart(
    projectDir: string,
    spec: CadPartSpec,
  ): Promise<{ part: CadPartRecord; store: CadKernelStore }>;
  combine(projectDir: string): Promise<{ assembly: CadAssemblyRecord; store: CadKernelStore }>;
};

export function createCadKernelHost(
  opts: {
    cad?: CadService | undefined;
    experimental?: boolean;
    kernels?: CadKernel[];
    extraKernels?: CadKernel[];
    env?: Record<string, string | undefined>;
  } = {},
): CadKernelHost {
  const experimental = opts.experimental ?? experimentalCadKernelsEnabled(opts.env);
  const kernels: CadKernel[] = opts.kernels ?? [
    createOpenCascadeKernel({ cad: opts.cad }),
    createSmlibKernel({ experimental, ...(opts.env ? { env: opts.env } : {}) }),
    ...(opts.extraKernels ?? []),
  ];

  async function availableIds(): Promise<CadKernelId[]> {
    const ids: CadKernelId[] = [];
    for (const k of kernels) {
      const h = await k.health();
      if (h.available) ids.push(k.id);
    }
    return ids;
  }

  function byId(id: CadKernelId): CadKernel | undefined {
    return kernels.find((k) => k.id === id);
  }

  return {
    kernels: () => kernels,
    async list() {
      return Promise.all(kernels.map((k) => k.health()));
    },
    store: (dir) => loadCadKernelStore(dir),
    async buildPart(projectDir, raw) {
      const spec = CadPartSpec.parse(raw);
      const available = await availableIds();
      const pick = selectCadKernel(spec, available);
      const order: CadKernelId[] =
        pick.requested === "auto"
          ? [...new Set([pick.preferred, ...pick.fallbacks])]
          : [pick.preferred];
      const unique = order.filter((id) => byId(id));
      if (unique.length === 0 || (pick.requested !== "auto" && !available.includes(pick.preferred))) {
        const detail =
          pick.requested !== "auto"
            ? `kernel "${pick.preferred}" is not available`
            : "no CAD kernel is available: start FreeCAD (`bun run dev:cad`) or enable SMLib (FABDESK_EXPERIMENTAL_CAD_KERNELS=1)";
        throw new CadKernelUnavailableError(detail, pick.preferred);
      }

      const dest = await partStepAbs(projectDir, spec.id);
      const fallbacks: CadKernelSwitch[] = [];
      let lastError: CadFeatureError | CadKernelUnavailableError | Error | null = null;
      const tryIds = pick.requested === "auto" ? unique : [pick.preferred];
      for (let i = 0; i < tryIds.length; i++) {
        const id = tryIds[i]!;
        const kernel = byId(id)!;
        try {
          const built = await kernel.buildPart(spec, dest, projectDir);
          const part: CadPartRecord = {
            id: spec.id,
            name: spec.name ?? spec.id,
            kernel: built.kernel,
            requested: pick.requested,
            reason:
              i === 0
                ? pick.reason
                : `fell back to ${built.kernel} after ${fallbacks.map((f) => f.from).join(" → ")}`,
            fallbacks,
            step: partStepRel(spec.id),
            features: spec.features,
            ...(spec.placement ? { placement: spec.placement } : {}),
            ...(built.volumeMm3 !== undefined ? { volumeMm3: built.volumeMm3 } : {}),
            ...(built.faces !== undefined ? { faces: built.faces } : {}),
            builtAt: new Date().toISOString(),
          };
          const store = await upsertPart(projectDir, part);
          return { part, store };
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (isCadKernelUnavailableError(e)) throw e;
          const next = tryIds[i + 1];
          if (pick.requested !== "auto" || !next || !isCadFeatureError(e)) throw lastError;
          fallbacks.push({
            from: id,
            to: next,
            featureKind: e.featureKind,
            error: e.message,
          });
        }
      }
      throw lastError ?? new Error("CAD build failed");
    },
    async combine(projectDir) {
      const store = await loadCadKernelStore(projectDir);
      if (store.parts.length === 0)
        throw new CadFeatureError("no parts to combine — cad_build_part first", "opencascade", "combine");
      const dest = await assemblyStepAbs(projectDir);
      const placed = [];
      let cursorX = 0;
      for (const part of store.parts) {
        const abs = `${projectDir}/${part.step}`;
        const xMm = part.placement?.xMm ?? cursorX;
        const yMm = part.placement?.yMm ?? 0;
        const zMm = part.placement?.zMm ?? 0;
        placed.push({ id: part.id, step: abs, xMm, yMm, zMm });
        if (!part.placement) cursorX += 80;
      }

      const notes: string[] = [];
      let usedKernel = false;
      for (const id of ["smlib", "opencascade"] as const) {
        const k = byId(id);
        if (!k?.combineSteps) continue;
        const h = await k.health();
        if (!h.available) continue;
        try {
          const out = await k.combineSteps(placed, dest, projectDir);
          notes.push(...out.notes);
          usedKernel = true;
          break;
        } catch (e) {
          if (isCadKernelUnavailableError(e)) {
            notes.push(`${id} combine unavailable: ${e.message}`);
            continue;
          }
          notes.push(`${id} combine failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!usedKernel) {
        const texts = [];
        for (const part of placed) {
          const text = await readFile(part.step, "utf8");
          if (!isStepText(text))
            throw new Error(`${part.step} is not a STEP file; cannot merge without a live kernel`);
          texts.push({
            id: part.id,
            text,
            xMm: part.xMm,
            yMm: part.yMm,
            zMm: part.zMm,
          });
        }
        await writeFile(dest, combineStepTexts(texts, { name: "assembly" }), "utf8");
        notes.push("merged STEP DATA sections (entity-id remap); no live kernel fuse available");
      }

      const assembly: CadAssemblyRecord = {
        step: CAD_ASSEMBLY_STEP,
        partIds: store.parts.map((p) => p.id),
        combinedAt: new Date().toISOString(),
        notes,
      };
      const next = await saveAssembly(projectDir, assembly);
      return { assembly, store: next };
    },
  };
}
