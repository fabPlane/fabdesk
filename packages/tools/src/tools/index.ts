import { ToolRegistry, type ToolDef } from "../registry";
import { appTools } from "./app";
import { cadTools } from "./cad";
import { circuitTools } from "./circuit";
import { coreTools } from "./core";
import { exportTools } from "./export";
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

export const allTools: ReadonlyArray<ToolDef> = [
  ...coreTools,
  ...projectTools,
  ...circuitTools,
  ...inspectionTools,
  ...spatialTools,
  ...nativeEditTools,
  ...schematicTools,
  ...pcbTools,
  ...routeTools,
  ...kicadTools,
  ...verifyTools,
  ...releaseTools,
  ...renderTools,
  ...exportTools,
  ...simTools,
  ...appTools,
  ...shoppingTools,
  ...cadTools,
] as unknown as ReadonlyArray<ToolDef>;

/** The v1 registry exposes both routers on every channel. */
export function createRegistry(opts: { channel?: "public" | "internal" } = {}): ToolRegistry {
  void opts;
  return new ToolRegistry(allTools);
}

export * from "./core";
export * from "./project";
export * from "./circuit";
export * from "./schematic";
export * from "./pcb";
export * from "./route";
export { savedHierarchyRevision, type SavedSheetRef } from "./project-status-evidence";
export * from "./kicad";
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
