/** Install-on-demand autorouter catalog shared by the daemon, tools, and Settings UI. */
import { z } from "zod/v4";

/** Catalog routers. `capacity` is a legacy input alias for `fab_router`, not a catalog entry. */
export const RouterCatalogId = z.enum(["fab_router", "freerouting", "tracemaker"]);
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
export const RouterInstallPhase = z.enum(["resolving", "downloading", "verifying", "extracting"]);
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
  state: RouterInstallState,
  ready: z.boolean(),
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
  /** Env var (TRACEMAKER_BIN / FREEROUTING_JAR) that supplies this router; Uninstall cannot remove it. */
  overriddenBy: z.string().optional(),
});
export type RouterSnapshot = z.infer<typeof RouterSnapshot>;

export const RouterList = z.object({
  routers: z.array(RouterSnapshot),
  /** User-chosen default; omitted keeps the built-in Freerouting → fab_router path. */
  preferredRouter: RouterCatalogId.optional(),
});
export type RouterList = z.infer<typeof RouterList>;
