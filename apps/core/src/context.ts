/** Builds ToolContexts for the MCP and HTTP adapters: resolves the project from args, token or default. */
import { makeContext, type ContextFactory, type CoreServices, type ProjectHandle, type ToolTelemetry } from "@fabdesk/tools";
import type { TokenSet } from "./auth";
import type { ProjectStore } from "./projects";

export type ContextDeps = {
  services: CoreServices;
  projects: ProjectStore;
  tokens: TokenSet | null;
  /** Fallback when neither args nor token name a project (e.g. `mcp --project <dir>`). */
  defaultProject?: () => Promise<ProjectHandle | null>;
  telemetry?: { forToolCall(runId: string): ToolTelemetry | undefined };
};

export function createContextFactory(deps: ContextDeps): ContextFactory {
  return async (req) => {
    let project: ProjectHandle | null = null;
    const info = deps.tokens?.lookup(req.token) ?? null;
    if (req.projectRef) project = await deps.projects.resolve(req.projectRef);
    if (!project && !req.projectRef) {
      if (info?.projectId) project = await deps.projects.handle(info.projectId);
      if (!project && deps.defaultProject) project = await deps.defaultProject();
    }
    const telemetry = info?.runId ? deps.telemetry?.forToolCall(info.runId) : undefined;
    return makeContext({
      services: deps.services,
      project,
      signal: req.signal,
      progress: (progress, note) => {
        req.progress(progress, note);
        telemetry?.recordToolEvent?.("mcp.progress", { progress, ...(note ? { note } : {}) });
      },
      principal: deps.services.principal(),
      ...(req.session ? { session: req.session } : {}),
      ...(telemetry ? { telemetry } : {}),
    });
  };
}
