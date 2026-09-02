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
    // Every netted pad names its connection(s) first so routers see it as the net's own copper.
    const names = new Set(srj.connections.map((c) => c.name));
    const owned = srj.obstacles.filter((o) => (o.connectedTo?.length ?? 0) > 0);
    expect(owned.length).toBeGreaterThan(0);
    for (const o of owned) expect(names.has(o.connectedTo![0]!)).toBe(true);
  });

  test("an imported net (source_trace with all ports + source_net) yields one connection, not a twin", () => {
    const pad = (id: string, port: string, x: number) => [
      { type: "pcb_port", pcb_port_id: port, pcb_component_id: "c1", source_port_id: `sp_${port}`, x, y: 0, layers: ["top"] },
      { type: "pcb_smtpad", pcb_smtpad_id: id, pcb_component_id: "c1", pcb_port_id: port, x, y: 0, width: 1, height: 1, layer: "top", shape: "rect", port_hints: ["1"] },
    ];
    const cj = [
      { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 10, num_layers: 2 },
      { type: "source_component", source_component_id: "sc1", name: "U1", ftype: "simple_chip" },
      { type: "pcb_component", pcb_component_id: "c1", source_component_id: "sc1", center: { x: 0, y: 0 }, layer: "top", rotation: 0, width: 10, height: 2 },
      { type: "source_port", source_port_id: "sp_p1", source_component_id: "sc1", name: "1" },
      { type: "source_port", source_port_id: "sp_p2", source_component_id: "sc1", name: "2" },
      { type: "source_port", source_port_id: "sp_p3", source_component_id: "sc1", name: "3" },
      ...pad("s1", "p1", -5),
      ...pad("s2", "p2", 0),
      ...pad("s3", "p3", 5),
      { type: "source_net", source_net_id: "source_net_0", name: "SIG", member_source_group_ids: [] },
      { type: "source_trace", source_trace_id: "source_trace_0", connected_source_port_ids: ["sp_p1", "sp_p2", "sp_p3"], connected_source_net_ids: ["source_net_0"], display_name: "SIG" },
    ];
    const { srj, connectionMap } = extractSimpleRouteJson(cj);
    expect(srj.connections.map((c) => c.name)).toEqual(["source_trace_0"]);
    expect(srj.connections[0]!.pointsToConnect).toHaveLength(3);
    expect(connectionMap).toEqual({ source_trace_0: "source_trace_0" });
    for (const o of srj.obstacles.filter((o) => (o.connectedTo?.length ?? 0) > 0)) {
      expect(o.connectedTo![0]).toBe("source_trace_0");
      expect(o.connectedTo).not.toContain("source_net_0");
    }
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
