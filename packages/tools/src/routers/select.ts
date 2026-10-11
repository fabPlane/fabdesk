import type { RouterCatalogId } from "@fabdesk/protocol";

export type RouterInputId = RouterCatalogId | "capacity";

export type ResolvedRouterRequest = {
  /** Set when the user, project, or preferred-router setting named a router. */
  selected?: RouterInputId;
  /** Canonical catalog id when selected is set. */
  catalogId?: RouterCatalogId;
  /** True only when nothing pinned the router — today's Freerouting → fab_router path. */
  automatic: boolean;
};

/**
 * Resolve which router the caller asked for without changing the unpinned default.
 * `args` wins, then the project manifest, then Settings.preferredRouter.
 */
export function resolveRequestedRouter(opts: {
  requested?: RouterInputId;
  projectRouter?: RouterInputId;
  preferredRouter?: RouterCatalogId;
}): ResolvedRouterRequest {
  const selected = opts.requested ?? opts.projectRouter ?? opts.preferredRouter;
  if (selected === undefined) return { automatic: true };
  const catalogId: RouterCatalogId = selected === "capacity" ? "fab_router" : selected;
  return { selected, catalogId, automatic: false };
}

export function normalizeRouterId(id: RouterInputId): RouterCatalogId {
  return id === "capacity" ? "fab_router" : id;
}
