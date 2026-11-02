import { z } from "zod/v4";
import { AssemblyRelativePath } from "./assembly";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ReviewOutputTrash = z.object({ paths: z.array(AssemblyRelativePath).min(1).max(2000) }).strict();
export const MoveOutputsToTrash = z.object({ files: z.array(z.object({ path: AssemblyRelativePath, token: Hash }).strict()).min(1).max(2000) }).strict();
export const RestoreOutputTrash = z.object({ ids: z.array(z.string().uuid()).min(1).max(2000) }).strict();
export type OutputTrashCandidate = { path: string; eligible: boolean; reason: string; token?: string; size?: number };
export type OutputTrashReview = { files: OutputTrashCandidate[] };
export type OutputTrashEntry = { id: string; path: string; size: number; sha256: string; trashedAt: string };
export type OutputTrashResult = { path: string; ok: boolean; reason: string; id?: string };
export type OutputTrashBatchResult = { results: OutputTrashResult[] };

/** Shared qualification for deliverables; metadata, sources and private intermediates stay protected. */
export function savedOutputKind(path: string): "images" | "videos" | "models" | "manufacturing" | null {
  if (!/^(renders|exports)\//.test(path) || path.startsWith("renders/diff/") || /^exports\/\.product-video-frames\//.test(path)) return null;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "svg"].includes(extension)) return "images";
  if (["mp4", "webm", "gif"].includes(extension)) return "videos";
  if (["glb", "stl", "obj", "step", "stp"].includes(extension)) return "models";
  if (["zip", "csv", "gbr", "gbl", "gtl", "gba", "gta", "gbo", "gto", "gbs", "gts", "gbp", "gtp", "gm1", "gko", "drl", "pdf", "dxf", "lbrn2", "net", "pos"].includes(extension)) return "manufacturing";
  return null;
}
