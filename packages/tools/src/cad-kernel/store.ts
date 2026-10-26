import { join } from "node:path";
import { z } from "zod/v4";
import { ensureDir, readJsonOrNull, writeJson } from "../fs";
import {
  CadFeature,
  CadKernelId,
  CadKernelChoice,
  CadPartPlacement,
  type CadAssemblyRecord,
  type CadKernelStore,
  type CadPartRecord,
} from "./types";

export const CAD_KERNEL_STORE = "cad/kernels.json" as const;
export const CAD_PARTS_DIR = "cad/parts" as const;
export const CAD_ASSEMBLY_STEP = "cad/assembly.step" as const;

const CadKernelSwitchZ = z.object({
  from: CadKernelId,
  to: CadKernelId,
  featureKind: z.string(),
  error: z.string(),
});

const CadPartRecordZ = z.object({
  id: z.string(),
  name: z.string(),
  kernel: CadKernelId,
  requested: CadKernelChoice,
  reason: z.string(),
  fallbacks: z.array(CadKernelSwitchZ),
  step: z.string(),
  features: z.array(CadFeature),
  placement: CadPartPlacement.optional(),
  volumeMm3: z.number().optional(),
  faces: z.number().optional(),
  builtAt: z.string(),
});

const CadAssemblyRecordZ = z.object({
  step: z.string(),
  partIds: z.array(z.string()),
  combinedAt: z.string(),
  notes: z.array(z.string()),
});

const CadKernelStoreZ = z.object({
  schema: z.literal(1),
  parts: z.array(CadPartRecordZ),
  assembly: CadAssemblyRecordZ.nullable(),
});

export function emptyCadKernelStore(): CadKernelStore {
  return { schema: 1, parts: [], assembly: null };
}

export function storePath(projectDir: string): string {
  return join(projectDir, CAD_KERNEL_STORE);
}

export function partStepRel(partId: string): string {
  return `${CAD_PARTS_DIR}/${partId}.step`;
}

export async function loadCadKernelStore(projectDir: string): Promise<CadKernelStore> {
  const raw = await readJsonOrNull<unknown>(storePath(projectDir));
  if (raw === null) return emptyCadKernelStore();
  const parsed = CadKernelStoreZ.safeParse(raw);
  return parsed.success ? parsed.data : emptyCadKernelStore();
}

export async function saveCadKernelStore(projectDir: string, store: CadKernelStore): Promise<void> {
  await ensureDir(join(projectDir, "cad"));
  await writeJson(storePath(projectDir), store);
}

export async function upsertPart(projectDir: string, part: CadPartRecord): Promise<CadKernelStore> {
  const store = await loadCadKernelStore(projectDir);
  const parts = store.parts.filter((p) => p.id !== part.id);
  parts.push(part);
  parts.sort((a, b) => a.id.localeCompare(b.id));
  const next = { ...store, parts };
  await saveCadKernelStore(projectDir, next);
  return next;
}

export async function saveAssembly(
  projectDir: string,
  assembly: CadAssemblyRecord,
): Promise<CadKernelStore> {
  const store = await loadCadKernelStore(projectDir);
  const next = { ...store, assembly };
  await saveCadKernelStore(projectDir, next);
  return next;
}

export async function partStepAbs(projectDir: string, partId: string): Promise<string> {
  await ensureDir(join(projectDir, CAD_PARTS_DIR));
  return join(projectDir, partStepRel(partId));
}

export async function assemblyStepAbs(projectDir: string): Promise<string> {
  await ensureDir(join(projectDir, "cad"));
  return join(projectDir, CAD_ASSEMBLY_STEP);
}
