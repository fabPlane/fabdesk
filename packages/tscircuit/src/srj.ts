import { SimpleRouteJson as SimpleRouteJsonSchema, type SimpleRouteJson } from "@fabdesk/protocol";
import { getSimpleRouteJsonFromCircuitJson } from "@tscircuit/core";
import type { AnyCircuitElement } from "circuit-json";
import type { ExtractedSrj } from "./types";

/**
 * Builds the router input from circuit-json via @tscircuit/core. The result is validated against
 * the protocol schema but returned unstripped so routers keep the extra hints core emits
 * (zLayers, port selectors, clearances).
 */
export function extractSimpleRouteJson(circuitJson: unknown[], opts: { minTraceWidth?: number } = {}): ExtractedSrj {
  const { simpleRouteJson } = getSimpleRouteJsonFromCircuitJson({
    circuitJson: circuitJson as AnyCircuitElement[],
    ...(opts.minTraceWidth !== undefined ? { minTraceWidth: opts.minTraceWidth } : {}),
  });
  const parsed = SimpleRouteJsonSchema.safeParse(simpleRouteJson);
  if (!parsed.success) {
    throw new Error(`SimpleRouteJson from @tscircuit/core does not satisfy the protocol schema: ${parsed.error.message}`);
  }
  const connectionMap: Record<string, string> = {};
  for (const connection of simpleRouteJson.connections) {
    connectionMap[connection.name] = connection.source_trace_id ?? connection.name;
  }
  return { srj: simpleRouteJson as unknown as SimpleRouteJson, connectionMap };
}
