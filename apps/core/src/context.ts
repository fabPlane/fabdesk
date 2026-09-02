/** Builds ToolContexts for the MCP and HTTP adapters: resolves the project from args, token or default. */
import { makeContext, type ContextFactory, type CoreServices, type ProjectHandle } from "@fabdesk/tools";
import type { TokenSet } from "./auth";
import type { ProjectStore } from "./projects";

export type ContextDeps = {
  services: CoreServices;
  projects: ProjectStore;
  tokens: TokenSet | null;
  /** Fallback when neither args nor token name a project (e.g. `mcp --project <dir>`). */
  defaultProject?: () => Promise<ProjectHandle | null>;
};

export function createContextFactory(deps: ContextDeps): ContextFactory {
  return async (req) => {
    let project: ProjectHandle | null = null;
    if (req.projectRef) project = await deps.projects.resolve(req.projectRef);
    if (!project && !req.projectRef) {
      const info = deps.tokens?.lookup(req.token) ?? null;
      if (info?.projectId) project = await deps.projects.handle(info.projectId);
      if (!project && deps.defaultProject) project = await deps.defaultProject();
    }
    return makeContext({
      services: deps.services,
      project,
      signal: req.signal,
      progress: req.progress,
      principal: deps.services.principal(),
      ...(req.session ? { session: req.session } : {}),
    });
  };
}
