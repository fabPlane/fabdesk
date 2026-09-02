import { ToolRegistry, type ToolDef } from "../registry";
import { circuitTools } from "./circuit";
import { coreTools } from "./core";
import { exportTools } from "./export";
import { kicadTools } from "./kicad";
import { projectTools } from "./project";
import { renderTools } from "./render";
import { routeTools } from "./route";
import { simTools } from "./sim";
import { verifyTools } from "./verify";

export const allTools: ReadonlyArray<ToolDef> = [
  ...coreTools,
  ...projectTools,
  ...circuitTools,
  ...routeTools,
  ...kicadTools,
  ...verifyTools,
  ...renderTools,
  ...exportTools,
  ...simTools,
] as unknown as ReadonlyArray<ToolDef>;

/** The v1 registry with every toolset. */
export function createRegistry(): ToolRegistry {
  return new ToolRegistry(allTools);
}

export * from "./core";
export * from "./project";
export * from "./circuit";
export * from "./route";
export * from "./kicad";
export * from "./verify";
export * from "./render";
export * from "./export";
export * from "./sim";
