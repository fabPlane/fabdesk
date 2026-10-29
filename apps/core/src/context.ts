/** Builds ToolContexts for the MCP and HTTP adapters: resolves the project from args, token or default. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ASSEMBLY_MANIFEST_PATH, BoardSourceSelection } from "@fabdesk/protocol";
import { resolveNativeBoardBinding, withNativeBoardBinding } from "./assembly-board-binding";
import { ToolError, makeContext, type ContextFactory, type CoreServices, type ProjectHandle, type ToolTelemetry, type ToolDef } from "@fabdesk/tools";
import type { TokenSet } from "./auth";
import type { ProjectStore } from "./projects";

// These project-scoped toolsets operate on one concrete board today. An assembly
// root is not an implicit member; unsupported member operations stay disabled.
const BOARD_TOOLSETS = new Set(["circuit", "route", "kicad", "verify", "render", "export", "sim", "cad"]);
const ROOT_BOARD_TOOLS = new Set(["circuit_build", "circuit_place", "route_run", "verify_drc", "render_board", "project_import_kicad"]);
function needsConcreteBoard(def: ToolDef): boolean {
  // Unqualified comments remain legacy project-root discussion. An explicit board selector
  // binds the same tools to that source's comments.json; no native board is inferred.
  if (["comment_list", "comment_pin", "comment_answer", "comment_resolve", "export_bom"].includes(def.name)) return false;
  return def.boardScoped === true || ((def.scope ?? "project") === "project" && (BOARD_TOOLSETS.has(def.toolset) || ROOT_BOARD_TOOLS.has(def.name)));
}

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
    const board = req.board ? Object.freeze(BoardSourceSelection.parse(req.board)) : undefined;
    let runInScope: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
    let boardRoot: Readonly<{ id: string; dir: string }> | undefined;
    if (board) {
      if (!project || !req.def.boardScoped) throw new ToolError("This operation does not support the requested assembly board source.", "precondition");
      const rootProject = project, binding = await resolveNativeBoardBinding(rootProject, board);
      boardRoot = Object.freeze({ id: rootProject.id, dir: binding.rootDir });
      // IDs stay project-owned for leases, telemetry and jobs; native sessions use the captured leaf directory.
      project = Object.freeze({
        id: rootProject.id, name: `${rootProject.name} / ${board.sourceId}`, dir: binding.boardDir,
        manifest: () => { throw new ToolError("Parent project defaults are not board-specific metadata.", "precondition"); },
        updateManifest: async () => { throw new ToolError("This board-scoped operation cannot change parent project metadata.", "precondition"); },
      });
      runInScope = operation => withNativeBoardBinding(binding, operation);
    } else if (project && needsConcreteBoard(req.def)) {
      const declared = await lstat(join(project.dir, ASSEMBLY_MANIFEST_PATH)).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw new ToolError("Assembly ownership could not be checked. Inspect the project declaration before choosing a board.", "precondition");
      });
      if (declared) throw new ToolError(req.def.boardScoped
        ? "Select an explicit assembly board source and captured manifest SHA for this operation; the project root is not an inferred member board."
        : "This operation is not yet board-scoped for assembly projects. Project-root execution is disabled; use a supported member-source operation.", "precondition");
    }
    const telemetry = info?.runId ? deps.telemetry?.forToolCall(info.runId) : undefined;
    let lastRecordedProgress = -Infinity;
    let lastRecordedNote: string | undefined;
    let lastRecordedAt = 0;
    const progress = telemetry
      ? (value: number, note?: string) => {
          req.progress(value, note);
          const now = Date.now();
          if (
            value <= 0 ||
            value >= 1 ||
            value - lastRecordedProgress >= 0.05 ||
            note !== lastRecordedNote ||
            now - lastRecordedAt >= 250
          ) {
            telemetry.recordToolEvent?.("mcp.progress", {
              progress: value,
              ...(note ? { note } : {}),
            });
            lastRecordedProgress = value;
            lastRecordedNote = note;
            lastRecordedAt = now;
          }
        }
      : req.progress;
    return makeContext({
      services: deps.services,
      project,
      signal: req.signal,
      progress,
      principal: deps.services.principal(),
      ...(req.session ? { session: req.session } : {}),
      ...(telemetry ? { telemetry } : {}),
      ...(board ? { board } : {}),
      ...(runInScope ? { runInScope } : {}),
      ...(boardRoot ? { boardRoot } : {}),
    });
  };
}
