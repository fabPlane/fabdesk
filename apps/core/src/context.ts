import { bindNativeSource } from "./native-source-binding";
import type { WorkingDesigns } from "./working-design";
/** Builds ToolContexts for the MCP and HTTP adapters: resolves the project from args, token or default. */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ASSEMBLY_MANIFEST_PATH, BoardSourceSelection } from "@fabdesk/protocol";
import { resolveNativeBoardBinding, withNativeBoardBinding, withNativeRoutingSnapshot } from "./assembly-board-binding";
import { withNativeLayout, ToolError, makeContext, type ContextFactory, type CoreServices, type ProjectHandle, type ToolTelemetry, type ToolDef } from "@fabdesk/tools";
import type { TokenSet } from "./auth";
import type { ProjectStore } from "./projects";

// These project-scoped toolsets operate on one concrete board today. An assembly
// root is not an implicit member; unsupported member operations stay disabled.
const BOARD_TOOLSETS = new Set(["circuit", "route", "kicad", "verify", "render", "export", "sim", "cad"]);
const NATIVE_COMMENT_TOOLS = new Set(["comment_list", "comment_pin", "comment_answer", "comment_resolve"]);
const ROOT_BOARD_TOOLS = new Set(["circuit_build", "circuit_place", "route_run", "verify_drc", "render_board", "project_import_kicad"]);
function needsConcreteBoard(def: ToolDef): boolean {
  // Unqualified assembly discussion retains its legacy project scope.
  if (["comment_list", "comment_pin", "comment_answer", "comment_resolve", "export_bom"].includes(def.name)) return false;
  if (def.assemblyWide && !def.boardScoped) return false;
  return def.boardScoped === true || ((def.scope ?? "project") === "project" && (BOARD_TOOLSETS.has(def.toolset) || ROOT_BOARD_TOOLS.has(def.name)));
}

export type ContextDeps = {
  services: CoreServices;
  workingDesigns?: WorkingDesigns;
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
    const runProject = info?.kind === "run" && info.projectId ? await deps.projects.handle(info.projectId) : null;
    if (runProject?.manifest().ideaDraft && (req.def.name !== "request_project_creation" || req.projectRef && req.projectRef !== runProject.id))
      throw new ToolError("This is an idea draft. Use request_project_creation before generating or changing engineering files. Other project tools are unavailable during planning.", "precondition");
    if (req.projectRef) project = await deps.projects.resolve(req.projectRef);
    if (!project && !req.projectRef) {
      if (info?.projectId) project = await deps.projects.handle(info.projectId);
      if (!project && deps.defaultProject) project = await deps.defaultProject();
    }
    if (project && deps.projects.isPromoting(project.id)) throw new ToolError("Project setup is in progress. Try again once it finishes.", "precondition");
    if (project?.manifest().ideaDraft && req.def.name !== "request_project_creation") throw new ToolError("Create a project from this idea before using engineering tools.", "precondition");
    const rootProject = project;
    const workingThread = req.nativeSource?.threadId ?? info?.threadId;
    if (req.nativeSource && project?.id !== req.nativeSource.projectId) throw new ToolError("Native source belongs to another project", "precondition");
    if (info?.kind === "run" && req.nativeSource?.threadId && req.nativeSource.threadId !== info.threadId) throw new ToolError("Native operation belongs to another conversation", "precondition");
    const board = req.board ? Object.freeze(BoardSourceSelection.parse(req.board)) : undefined;
    let nativeContext = req.nativeSource;
    let runInScope: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
    let boardRoot: Readonly<{ id: string; dir: string }> | undefined;
    let runWithRoutingSnapshot: (<T>(directory: string, operation: () => Promise<T>) => Promise<T>) | undefined;
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
      if (req.def.name === "route_run") runWithRoutingSnapshot = (directory, operation) => withNativeRoutingSnapshot(binding, directory, operation);
    } else if (project && (needsConcreteBoard(req.def) || NATIVE_COMMENT_TOOLS.has(req.def.name))) {
      const selected = await deps.workingDesigns?.selection(project, req.nativeSource?.threadId ?? info?.threadId);
      const native = req.nativeSource ?? (selected ? { projectId: project.id, ...(info?.threadId ? { threadId: info.threadId } : {}), sourcePath: selected.sourcePath } : undefined);
      if (native && deps.workingDesigns) {
        const declared = await lstat(join(project.dir, ASSEMBLY_MANIFEST_PATH)).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
        if (declared) throw new ToolError("Use the declared assembly source selector for this repository", "precondition");
        if (info?.kind === "run" && native.threadId && native.threadId !== info.threadId) throw new ToolError("Native operation belongs to another conversation", "precondition");
        const layout = await bindNativeSource(project, native, deps.workingDesigns);
        project = layout.project;
        nativeContext = layout.context;
        runInScope = operation => withNativeLayout(layout, operation);
      }
      const declared = needsConcreteBoard(req.def) && !runInScope && await lstat(join(project.dir, ASSEMBLY_MANIFEST_PATH)).then(() => true, (error: NodeJS.ErrnoException) => {
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
      ...(info?.threadId ? { threadId: info.threadId } : req.nativeSource?.threadId ? { threadId: req.nativeSource.threadId } : {}),
      ...(runInScope && !board && nativeContext ? { nativeSource: nativeContext } : {}),
      ...(project && deps.workingDesigns ? { setWorkingDesign: (path: string) => deps.workingDesigns!.select(rootProject!, path, workingThread, info?.contextCapturedAt), getWorkingDesign: () => deps.workingDesigns!.describe(rootProject!, workingThread) } : {}),
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
      ...(runWithRoutingSnapshot ? { runWithRoutingSnapshot } : {}),
    });
  };
}
