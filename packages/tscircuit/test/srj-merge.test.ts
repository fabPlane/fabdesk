import { describe, expect, test } from "bun:test";
import { SimpleRouteJson, type SimplifiedPcbTrace } from "@fabdesk/protocol";
import { extractSimpleRouteJson, mergeTraces, unrouteCircuit } from "../src/index";
import { loadFixtureCircuit } from "./helpers";

const countType = (cj: unknown[], type: string) => cj.filter((e) => (e as { type: string }).type === type).length;

describe("extractSimpleRouteJson", () => {
  test("yields protocol-valid SRJ with layer names on every point", async () => {
    const cj = await loadFixtureCircuit();
    const { srj, connectionMap } = extractSimpleRouteJson(cj, { minTraceWidth: 0.15 });
    expect(SimpleRouteJson.safeParse(srj).success).toBe(true);
    expect(srj.connections.length).toBeGreaterThanOrEqual(1);
    expect(srj.layerCount).toBe(2);
    expect(srj.minTraceWidth).toBe(0.15);
    for (const c of srj.connections) {
      expect(c.pointsToConnect.length).toBeGreaterThanOrEqual(2);
      for (const p of c.pointsToConnect) expect(["top", "bottom", "inner1", "inner2"]).toContain(p.layer);
      expect(connectionMap[c.name]).toMatch(/^source_trace_/);
    }
    expect(srj.obstacles.length).toBeGreaterThan(0);
  });
});

describe("mergeTraces / unrouteCircuit", () => {
  test("round-trips a synthetic trace with a via and replaces on re-merge", async () => {
    const cj = await loadFixtureCircuit();
    const { srj, connectionMap } = extractSimpleRouteJson(cj);
    const connection = srj.connections[0]!;
    const [a, b] = connection.pointsToConnect;
    const trace: SimplifiedPcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: "router_trace_0",
      connection_name: connection.name,
      route: [
        { route_type: "wire", x: a!.x, y: a!.y, width: 0.2, layer: "top" },
        { route_type: "wire", x: (a!.x + b!.x) / 2, y: a!.y, width: 0.2, layer: "top" },
        { route_type: "via", x: (a!.x + b!.x) / 2, y: a!.y, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: (a!.x + b!.x) / 2, y: b!.y, width: 0.2, layer: "bottom" },
        { route_type: "wire", x: b!.x, y: b!.y, width: 0.2, layer: "bottom" },
      ],
    };
    const merged = mergeTraces(cj, [trace], connectionMap);
    expect(merged.length).toBe(cj.length + 2);
    expect(countType(merged, "pcb_trace")).toBe(1);
    expect(countType(merged, "pcb_via")).toBe(1);
    const pcbTrace = merged.find((e) => (e as { type: string }).type === "pcb_trace") as Record<string, unknown>;
    expect(pcbTrace.source_trace_id).toBe(connectionMap[connection.name]);
    expect((pcbTrace.route as unknown[]).length).toBe(5);
    const via = merged.find((e) => (e as { type: string }).type === "pcb_via") as Record<string, unknown>;
    expect(via.pcb_trace_id).toBe(pcbTrace.pcb_trace_id);
    expect(via.layers).toEqual(["top", "bottom"]);
    expect(via.outer_diameter).toBeGreaterThan(via.hole_diameter as number);

    // Re-merging the same connection replaces rather than duplicates.
    const again = mergeTraces(merged, [trace], connectionMap);
    expect(countType(again, "pcb_trace")).toBe(1);
    expect(countType(again, "pcb_via")).toBe(1);

    // The SRJ of a routed board carries the trace back out.
    const routedSrj = extractSimpleRouteJson(again).srj;
    expect(SimpleRouteJson.safeParse(routedSrj).success).toBe(true);

    // Unrouting a single connection then everything.
    const partial = unrouteCircuit(again, [connection.name]);
    expect(countType(partial, "pcb_trace")).toBe(0);
    expect(countType(partial, "pcb_via")).toBe(0);
    const other = unrouteCircuit(again, ["not-a-connection"]);
    expect(countType(other, "pcb_trace")).toBe(1);
    expect(unrouteCircuit(again).length).toBe(cj.length);
  });
});
