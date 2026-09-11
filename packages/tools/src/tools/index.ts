import { ToolRegistry, type ToolDef } from "../registry";
import { appTools } from "./app";
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
import { verifyTools } from "./verify";

export const allTools: ReadonlyArray<ToolDef> = [
  ...coreTools,
  ...projectTools,
  ...circuitTools,
  ...inspectionTools,
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
] as unknown as ReadonlyArray<ToolDef>;

/** The v1 registry with every toolset. */
export function createRegistry(): ToolRegistry {
  return new ToolRegistry(allTools);
}

export * from "./core";
export * from "./project";
export * from "./circuit";
export * from "./schematic";
export * from "./pcb";
export * from "./route";
export * from "./kicad";
export * from "./inspection";
export * from "./native-edit";
export * from "./release";
export * from "./verify";
export * from "./render";
export * from "./export";
export * from "./sim";
export * from "./app";
