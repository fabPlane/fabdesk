import { z } from "zod/v4";
import { SharedLibraryItem } from "./project-library";

export const ShareId = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
export const ProjectShareState = z.discriminatedUnion("visibility", [
  z.object({ visibility: z.literal("private") }).strict(),
  z.object({ visibility: z.literal("restricted"), projectId: z.string().uuid(), publishedAt: z.string().datetime(), revision: z.string().min(1).max(128) }).strict(),
  z
    .object({
      visibility: z.literal("unlisted"),
      shareId: ShareId,
      publishedAt: z.string().datetime(),
      revision: z.string().min(1).max(128),
    })
    .strict(),
]);
export type ProjectShareState = z.infer<typeof ProjectShareState>;

export const SharedBoard = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(120),
    sourceAvailable: z.boolean(),
    sourceState: z.enum(["pcb", "schematic-only", "missing", "unavailable"]).optional(),
    modelState: z.enum(["no-model", "unverified", "source-changed", "source-unchanged", "artifact-changed", "unavailable"]).optional(),
    checks: z
      .object({
        state: z.enum([
          "no-report",
          "unverified",
          "source-changed",
          "source-unchanged",
          "unavailable",
        ]),
        findingCount: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    model: z
      .object({
        contentType: z.literal("model/gltf-binary"),
        dataBase64: z
          .string()
          .max(14 * 1024 * 1024)
          .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)),
      })
      .strict()
      .nullable()
      .optional(),
    preview: z
      .object({
        contentType: z.literal("image/png"),
        dataBase64: z
          .string()
          .max(8 * 1024 * 1024)
          .refine(
            (value) =>
              value.startsWith("iVBORw0KGgo") &&
              value.length % 4 === 0 &&
              /^[A-Za-z0-9+/]*={0,2}$/.test(value),
            "Expected a base64 PNG preview",
          ),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SharedBoard = z.infer<typeof SharedBoard>;

/** Public allowlist: no local paths, source files, raw reports, notes or credentials. */
export const ProjectShareSnapshot = z
  .object({
    schema: z.literal("fabplane.project-share.v1"),
    name: z.string().min(1).max(120),
    capturedAt: z.string().datetime(),
    boards: z.array(SharedBoard).min(1).max(128),
    library: z.array(SharedLibraryItem).max(64).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.boards.map((board) => board.id)).size !== value.boards.length)
      ctx.addIssue({ code: "custom", message: "Shared board IDs must be unique" });
    const boardBytes = value.boards.reduce(
      (sum, board) =>
        sum + (board.preview?.dataBase64.length ?? 0) + (board.model?.dataBase64.length ?? 0),
      0,
    );
    const libraryBytes = (value.library ?? []).reduce(
      (sum, item) => sum + (item.preview?.dataBase64.length ?? 0) + item.textExcerpt.length,
      0,
    );
    if (boardBytes > 28 * 1024 * 1024)
      ctx.addIssue({
        code: "custom",
        message: "Shared project previews and models exceed the size limit",
      });
    if (libraryBytes > 4 * 1024 * 1024)
      ctx.addIssue({
        code: "custom",
        message: "Shared project files library exceeds the size limit",
      });
  });
export type ProjectShareSnapshot = z.infer<typeof ProjectShareSnapshot>;
export const SharedProject = z
  .object({
    shareId: ShareId,
    publishedAt: z.string().datetime(),
    revision: z.string().min(1).max(128),
    snapshot: ProjectShareSnapshot,
  })
  .strict();
export type SharedProject = z.infer<typeof SharedProject>;

export function sharedProjectUrl(shareId: string, appOrigin = "https://app.fabplane.com"): string {
  return `${new URL(appOrigin).origin}/share/${ShareId.parse(shareId)}`;
}
export function openSharedProjectHref(shareId: string): string {
  return `fabplane://share/${ShareId.parse(shareId)}`;
}
/** Accept only the app's origin and exact share path; never an arbitrary URL supplied by a link. */
export function parseSharedProjectHref(raw: string): { shareId: string } | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.port || url.search || url.hash) return null;
    const path =
      url.protocol === "fabplane:" && url.hostname === "share"
        ? url.pathname
        : url.protocol === "https:" && url.hostname === "app.fabplane.com"
          ? url.pathname.replace(/^\/share\//, "/")
          : "";
    // HTTPS links must include /share/, rather than matching an unrelated app page.
    if (url.protocol === "https:" && !url.pathname.startsWith("/share/")) return null;
    const match = /^\/([A-Za-z0-9_-]{16,80})\/?$/.exec(path);
    return match?.[1] ? { shareId: match[1] } : null;
  } catch {
    return null;
  }
}
export function sharedCheckLabel(checks: SharedBoard["checks"]): string {
  if (checks.state === "no-report") return "No saved PCB check";
  if (checks.state === "unavailable") return "Check source unavailable";
  if (checks.state === "unverified") return "Saved report · revision unverified";
  if (checks.state === "source-changed") return "PCB changed since check";
  return checks.findingCount
    ? `${checks.findingCount} PCB ${checks.findingCount === 1 ? "finding" : "findings"}`
    : "PCB-only report · no listed findings";
}

export function sharedSourceLabel(board: Pick<SharedBoard, "sourceAvailable" | "sourceState">): string {
  return board.sourceState === "schematic-only" ? "Schematic only"
    : board.sourceState === "unavailable" ? "Source unavailable"
    : board.sourceState === "pcb" || (!board.sourceState && board.sourceAvailable) ? "PCB available"
    : "PCB source missing";
}

export function sharedModelLabel(board: Pick<SharedBoard, "model" | "modelState">): string {
  if (board.modelState === "unavailable") return "Model status unavailable";
  if (board.modelState === "source-changed") return "PCB changed since export";
  if (board.modelState === "artifact-changed") return "Model changed · unverified";
  if (board.modelState === "source-unchanged") return "Saved · PCB unchanged";
  if (board.modelState === "unverified" || board.model) return "Saved · unverified";
  return "No saved model";
}

export const SharedProjectStatus = SharedProject.pick({
  shareId: true,
  publishedAt: true,
  revision: true,
});
export type SharedProjectStatus = z.infer<typeof SharedProjectStatus>;

/** Authenticated project intents contain only an ID, never tokens or a remote API origin. */
export const OpenSharedProjectIntent = z.union([z.object({shareId:ShareId}).strict(),z.object({projectId:z.string().uuid()}).strict()]);
export type OpenSharedProjectIntent = z.infer<typeof OpenSharedProjectIntent>;
export function parseContributionProjectHref(raw:string):{projectId:string}|null {
  try {const u=new URL(raw);
    if(u.username||u.password||u.port||u.search||u.hash)return null;
    const path=u.protocol==='fabplane:'&&u.hostname==='project'?u.pathname:u.protocol==='https:'&&u.hostname==='app.fabplane.com'&&u.pathname.startsWith('/projects/')?u.pathname.slice('/projects'.length):'';
    const m=/^\/([^/]+)\/?$/.exec(path);const id=z.string().uuid().safeParse(m?.[1]);return id.success?{projectId:id.data}:null;
  }catch{return null;}
}
