import { describe, expect, test } from "bun:test";
import type { SimplifiedPcbTrace } from "@fabdesk/protocol";
import { join } from "node:path";
import { buildCircuit, extractSimpleRouteJson, mergeTraces, queryCircuit, unrouteCircuit } from "../src/index";
import { loadFixtureCircuit, tempProject } from "./helpers";

type El = Record<string, unknown> & { type: string };
const ofType = (cj: unknown[], type: string) => cj.filter((e) => (e as El).type === type) as El[];

/**
 * Rails declared with `<net name="GND" />` and `to="net.GND"` selectors: @tscircuit/core emits one
 * SRJ connection per net, named by the source_net_id, with no source_trace_id. The merged routing
 * must still identify its net, or circuit-json-to-kicad writes every segment with `(net 0)`.
 */
describe("net-selector connections", () => {
  test("SRJ connections are named by source_net_id and map to themselves", async () => {
    const cj = await loadFixtureCircuit("net-selector");
    const nets = ofType(cj, "source_net");
    expect(nets.map((n) => n.name).sort()).toEqual(["GND", "V5"]);
    const { srj, connectionMap } = extractSimpleRouteJson(cj);
    expect(srj.connections.map((c) => c.name).sort()).toEqual(nets.map((n) => n.source_net_id).sort());
    for (const c of srj.connections) {
      expect(c.source_trace_id).toBeUndefined();
      expect(connectionMap[c.name]).toBe(c.name);
      expect(c.pointsToConnect.length).toBe(3);
    }
  });

  test("mergeTraces stamps the net's connectivity key on traces and vias", async () => {
    const cj = await loadFixtureCircuit("net-selector");
    const { srj, connectionMap } = extractSimpleRouteJson(cj);
    const gnd = ofType(cj, "source_net").find((n) => n.name === "GND")!;
    const connection = srj.connections.find((c) => c.name === gnd.source_net_id)!;
    const [a, b] = connection.pointsToConnect;
    const trace: SimplifiedPcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: `${connection.name}_mst0_0`,
      connection_name: connection.name,
      route: [
        { route_type: "wire", x: a!.x, y: a!.y, width: 0.15, layer: "top" },
        { route_type: "via", x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2, from_layer: "top", to_layer: "bottom" },
        { route_type: "wire", x: b!.x, y: b!.y, width: 0.15, layer: "bottom" },
      ],
    };
    const merged = mergeTraces(cj, [trace], connectionMap);
    const [pcbTrace] = ofType(merged, "pcb_trace");
    const [via] = ofType(merged, "pcb_via");
    expect(pcbTrace).toBeDefined();
    expect(via).toBeDefined();
    // Same convention as @tscircuit/core: source_trace_id holds the source_net_id for net routes.
    expect(pcbTrace!.source_trace_id).toBe(gnd.source_net_id);
    expect(pcbTrace!.subcircuit_connectivity_map_key).toBe(gnd.subcircuit_connectivity_map_key);
    expect(pcbTrace!.subcircuit_id).toBe(gnd.subcircuit_id);
    expect(via!.source_trace_id).toBe(gnd.source_net_id);
    expect(via!.source_net_id).toBe(gnd.source_net_id);
    expect(via!.subcircuit_connectivity_map_key).toBe(gnd.subcircuit_connectivity_map_key);
    expect(via!.pcb_trace_id).toBe(pcbTrace!.pcb_trace_id);

    // Every source_trace on GND now reports as routed; V5 traces do not.
    const rows = queryCircuit(merged, "traces");
    for (const row of rows) {
      expect(row.routed).toBe((row.nets as string[]).includes("GND"));
    }

    // Re-route replaces, unroute by the connection name removes.
    expect(ofType(mergeTraces(merged, [trace], connectionMap), "pcb_trace").length).toBe(1);
    const unrouted = unrouteCircuit(merged, [connection.name]);
    expect(ofType(unrouted, "pcb_trace").length).toBe(0);
    expect(ofType(unrouted, "pcb_via").length).toBe(0);
  });

  test("pin-to-pin traces get the key of their source_trace", async () => {
    const cj = await loadFixtureCircuit();
    const { srj, connectionMap } = extractSimpleRouteJson(cj);
    const connection = srj.connections[0]!;
    const [a, b] = connection.pointsToConnect;
    const trace: SimplifiedPcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: "t0",
      connection_name: connection.name,
      route: [
        { route_type: "wire", x: a!.x, y: a!.y, width: 0.15, layer: "top" },
        { route_type: "wire", x: b!.x, y: b!.y, width: 0.15, layer: "top" },
      ],
    };
    const [pcbTrace] = ofType(mergeTraces(cj, [trace], connectionMap), "pcb_trace");
    const sourceTrace = ofType(cj, "source_trace").find((t) => t.source_trace_id === connectionMap[connection.name])!;
    expect(typeof sourceTrace.subcircuit_connectivity_map_key).toBe("string");
    expect(pcbTrace!.source_trace_id).toBe(sourceTrace.source_trace_id);
    expect(pcbTrace!.subcircuit_connectivity_map_key).toBe(sourceTrace.subcircuit_connectivity_map_key);
  });

  test("unknown connections are emitted without a source", async () => {
    const cj = await loadFixtureCircuit("net-selector");
    const trace: SimplifiedPcbTrace = {
      type: "pcb_trace",
      pcb_trace_id: "t0",
      connection_name: "not_a_source",
      route: [
        { route_type: "wire", x: 0, y: 0, width: 0.15, layer: "top" },
        { route_type: "wire", x: 1, y: 0, width: 0.15, layer: "top" },
      ],
    };
    const [pcbTrace] = ofType(mergeTraces(cj, [trace], {}), "pcb_trace");
    expect(pcbTrace!.source_trace_id).toBeUndefined();
    expect(pcbTrace!.subcircuit_connectivity_map_key).toBeUndefined();
  });
});

describe("net-selector fixture build", () => {
  test("core emits per-net connectivity keys that the merge relies on", async () => {
    const dir = await tempProject("net-selector");
    const result = await buildCircuit({ projectDir: dir, cacheDir: join(dir, ".cache") });
    expect(result.errors).toEqual([]);
    expect(result.elementCounts.source_net).toBe(2);
    expect(result.elementCounts.source_trace).toBe(6);
    expect(result.elementCounts.pcb_trace).toBeUndefined();
    const nets = ofType(result.circuitJson, "source_net");
    const keys = new Set(nets.map((n) => n.subcircuit_connectivity_map_key));
    expect(keys.size).toBe(2);
    for (const trace of ofType(result.circuitJson, "source_trace")) {
      expect((trace.connected_source_net_ids as string[]).length).toBe(1);
      expect(keys.has(trace.subcircuit_connectivity_map_key)).toBe(true);
    }
    // The checked-in fixture is what the build produces today.
    const checkedIn = await loadFixtureCircuit("net-selector");
    expect(ofType(checkedIn, "source_net").map((n) => n.subcircuit_connectivity_map_key)).toEqual(nets.map((n) => n.subcircuit_connectivity_map_key));
  }, 60_000);
});
