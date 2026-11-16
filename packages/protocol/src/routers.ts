/** Install-on-demand autorouter catalog shared by the daemon, tools, and Settings UI. */
import { z } from "zod/v4";

/**
 * Catalog entries. `capacity` is a legacy input alias for `fab_router`, not a catalog entry. `krt`
 * (KiCadRoutingTools) is an engine the board workflow runs, not a `route_run` router (`kind: "engine"`).
 */
export const RouterCatalogId = z.enum(["fab_router", "freerouting", "tracemaker", "krt", "atlc"]);
export type RouterCatalogId = z.infer<typeof RouterCatalogId>;

export const RouterInstallState = z.enum([
  "bundled",
  "not_installed",
  "installing",
  "installed",
  "failed",
]);
export type RouterInstallState = z.infer<typeof RouterInstallState>;

/** Install phases the registry reports while a job is running. */
export const RouterInstallPhase = z.enum(["resolving", "downloading", "verifying", "extracting", "setup"]);
export type RouterInstallPhase = z.infer<typeof RouterInstallPhase>;

export const RouterProgress = z.object({
  received: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  phase: RouterInstallPhase.optional(),
});
export type RouterProgress = z.infer<typeof RouterProgress>;

export const RouterSnapshot = z.object({
  id: RouterCatalogId,
  displayName: z.string(),
  description: z.string(),
  strengths: z.array(z.string()),
  license: z.string(),
  version: z.string(),
  homepage: z.string(),
  install: z.enum(["bundled", "download"]),
  /** `engine`: run by the board workflow, never a `route_run` router (no picker entry, no Set default). Omitted means router. */
  kind: z.enum(["router", "engine"]).optional(),
  state: RouterInstallState,
  ready: z.boolean(),
  /** Runtime health is separate from package installation; an installed engine can be unavailable. */
  runtime: z.object({ ready: z.boolean(), reason: z.string().optional() }).optional(),
  installHint: z.string(),
  versionInstalled: z.string().optional(),
  progress: RouterProgress.optional(),
  /** The real failure text (offline, checksum mismatch, 404 manifest, ...). */
  error: z.string().optional(),
  /** Non-fatal context, e.g. "only the source package was downloaded because ...". */
  notice: z.string().optional(),
  path: z.string().optional(),
  /** Installed package is source only: there is no runnable binary until it is built. */
  sourceOnly: z.boolean().optional(),
  /** Env var (TRACEMAKER_BIN / FREEROUTING_JAR / FABDESK_KRT_DIR) or setting that supplies this router; Uninstall cannot remove it. */
  overriddenBy: z.string().optional(),
  /**
   * TraceMaker only: its placer (`tracemaker-place`, which board_route's floorplan path runs), found beside the binary,
   * in a source build's tree, or from TRACEMAKER_PLACE_BIN (`overriddenBy`). `why` says what is missing when not ready.
   */
  placer: z
    .object({ ready: z.boolean(), path: z.string().optional(), overriddenBy: z.string().optional(), why: z.string().optional() })
    .optional(),
});
export type RouterSnapshot = z.infer<typeof RouterSnapshot>;

export const RouterList = z.object({
  routers: z.array(RouterSnapshot),
  /** User-chosen default; omitted keeps the built-in Freerouting → fab_router path. */
  preferredRouter: RouterCatalogId.optional(),
});
export type RouterList = z.infer<typeof RouterList>;
