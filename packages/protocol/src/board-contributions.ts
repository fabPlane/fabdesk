import { z } from "zod/v4";
import { SharedBoard } from "./project-sharing";
/** Explicit allowlist: no paths, scripts, credentials, chat or arbitrary attachments. */
export const EditableBoardFiles = z
  .object({
    pcb: z
      .string()
      .min(1)
      .max(10 * 1024 * 1024)
      .refine((s) => /^\s*\(kicad_pcb\s/.test(s), "Expected a KiCad PCB file"),
    schematic: z
      .string()
      .min(1)
      .max(5 * 1024 * 1024)
      .refine((s) => /^\s*\(kicad_sch\s/.test(s), "Expected a KiCad schematic file")
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(v)).length > 16 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Editable board files exceed 16 MiB" });
  });
export type EditableBoardFiles = z.infer<typeof EditableBoardFiles>;
export const PublishBoardRevision = z
  .object({
    expectedRevision: z.string().uuid().nullable(),
    files: EditableBoardFiles,
    board: SharedBoard,
  })
  .strict();
export type PublishBoardRevision = z.infer<typeof PublishBoardRevision>;

export const ContributionReceipt = z
  .object({
    apiOrigin: z.string().url(),
    projectId: z.string().uuid(),
    boardId: z.string().min(1).max(80),
    revision: z.string().uuid(),
  })
  .strict();
export type ContributionReceipt = z.infer<typeof ContributionReceipt>;
export const ContributionBoards = z.object({
  role: z.enum(["owner", "viewer", "contributor"]),
  boards: z.array(
    z.object({
      id: z.string().min(1).max(80),
      name: z.string().min(1),
      revision: z.string().uuid().nullable(),
      publishedAt: z.string().datetime().nullable(),
      publishedBy: z.string().nullable(),
    }),
  ),
});
export type ContributionBoards = z.infer<typeof ContributionBoards>;
export const TeamProjects = z.object({
  projects: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      role: z.enum(["owner", "viewer", "contributor"]),
      publishedAt: z.string().nullable(),
      localProjectId: z.string().nullable().optional(),
    }),
  ),
});
export type TeamProjects = z.infer<typeof TeamProjects>;
export const BoardSourceDownload = z
  .object({
    projectId: z.string().uuid(),
    boardId: z.string().min(1).max(80),
    name: z.string(),
    revision: z.string().uuid(),
    files: EditableBoardFiles,
  })
  .strict();
