import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from "circuit-to-svg";
import type { AnyCircuitElement } from "circuit-json";

export function schematicSvg(circuitJson: unknown[]): string {
  return convertCircuitJsonToSchematicSvg(circuitJson as AnyCircuitElement[]);
}

export function pcbSvg(circuitJson: unknown[]): string {
  return convertCircuitJsonToPcbSvg(circuitJson as AnyCircuitElement[]);
}
