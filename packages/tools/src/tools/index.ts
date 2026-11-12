import { ToolRegistry, type ToolDef } from "../registry";
import { bom_read } from "./bom";
import { appTools } from "./app";
import { cadTools } from "./cad";
import { circuitTools } from "./circuit";
import { commentTools } from "./comments";
import { coreTools } from "./core";
import { exportTools } from "./export";
import { boardDiffTools } from "./board-diff";
import { boardWorkspaceTools } from "./board-workspace";
import { kicadTools } from "./kicad";
import { inspectionTools } from "./inspection";
import { nativeEditTools } from "./native-edit";
import { releaseTools } from "./release";
import { pcbTools } from "./pcb";
import { projectTools } from "./project";
import { renderTools } from "./render";
import { routeTools } from "./route";
import { schematicTools } from "./schematic";
import { simTools } from "./sim";
import { shoppingTools } from "./shopping";
import { spatialTools } from "./spatial";
import { verifyTools } from "./verify";
import { boardTools } from "./board";
import { withBoardHandoff } from "./board-handoff";

export const allTools: ReadonlyArray<ToolDef> = [
  ...coreTools,
  ...projectTools,
  bom_read,
  ...commentTools,
  ...boardWorkspaceTools,
  ...circuitTools,
  ...inspectionTools,
  ...spatialTools,
  ...nativeEditTools,
  ...schematicTools,
  ...pcbTools,
  ...routeTools,
  ...kicadTools,
  ...boardDiffTools,
  ...verifyTools,
  ...releaseTools,
  ...renderTools,
  ...exportTools,
  ...simTools,
  ...appTools,
  ...shoppingTools,
  ...cadTools,
  ...boardTools,
].map((tool) => withBoardHandoff(tool as unknown as ToolDef)) as unknown as ReadonlyArray<ToolDef>;

/** The v1 registry exposes both routers on every channel. */
export function createRegistry(opts: { channel?: "public" | "internal" } = {}): ToolRegistry {
  void opts;
  return new ToolRegistry(allTools);
}

export * from "./core";
export * from "./project";
export * from "./comments";
export * from "./parts";
export * from "./circuit";
export * from "./schematic";
export * from "./pcb";
export * from "./route";
export { savedHierarchyRevision, type SavedSheetRef } from "./project-status-evidence";
export * from "./kicad";
export * from "./board-diff";
export * from "./board-workspace";
export * from "./inspection";
export * from "./native-edit";
export * from "./release";
export * from "./verify";
export * from "./render";
export * from "./export";
export * from "./silk-art";
export * from "./sim";
export * from "./app";
export * from "./shopping";
export * from "./cad";
export * from "./spatial";

export * from "./task-checkpoint";
