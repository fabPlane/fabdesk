import { z } from "zod/v4";

export const ShareId = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
export const ProjectShareState = z.discriminatedUnion("visibility", [
  z.object({ visibility: z.literal("private") }).strict(),
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
    preview: z
      .object({
        contentType: z.literal("image/png"),
        dataBase64: z
          .string()
          .max(8 * 1024 * 1024)
          .refine(
            (value) =>
              value.startsWith("iVBORw0KGgo") &&
              value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
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
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.boards.map((board) => board.id)).size !== value.boards.length)
      ctx.addIssue({ code: "custom", message: "Shared board IDs must be unique" });
    if (
      value.boards.reduce((sum, board) => sum + (board.preview?.dataBase64.length ?? 0), 0) >
      28 * 1024 * 1024
    )
      ctx.addIssue({ code: "custom", message: "Shared project previews exceed the size limit" });
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
