import { describe, expect, test } from "bun:test";
import type { SimplifiedPcbTrace } from "@fabdesk/protocol";
import { mergeTraces, unrouteCircuit } from "../src/index";

/** Two pads on one net plus a Viagrid-style factory via (`net_is_assignable`) between them. */
function circuit(): unknown[] {
  const pad = (id: string, port: string, x: number, layer: string) => [
    { type: "pcb_port", pcb_port_id: port, pcb_component_id: "c1", source_port_id: `sp_${port}`, x, y: 0, layers: [layer] },
    { type: "pcb_smtpad", pcb_smtpad_id: id, pcb_component_id: "c1", pcb_port_id: port, x, y: 0, width: 1, height: 1, layer, shape: "rect", port_hints: ["1"] },
  ];
  return [
    { type: "pcb_board", pcb_board_id: "b", center: { x: 0, y: 0 }, width: 20, height: 10, num_layers: 2 },
    { type: "source_component", source_component_id: "sc1", name: "U1", ftype: "simple_chip" },
    { type: "pcb_component", pcb_component_id: "c1", source_component_id: "sc1", center: { x: 0, y: 0 }, layer: "top", rotation: 0, width: 10, height: 2 },
    { type: "source_port", source_port_id: "sp_p1", source_component_id: "sc1", name: "1" },
    { type: "source_port", source_port_id: "sp_p2", source_component_id: "sc1", name: "2" },
    ...pad("s1", "p1", -5, "top"),
    ...pad("s2", "p2", 5, "bottom"),
    { type: "source_net", source_net_id: "source_net_0", name: "SIG", member_source_group_ids: [], subcircuit_connectivity_map_key: "k0" },
    { type: "source_trace", source_trace_id: "source_trace_0", connected_source_port_ids: ["sp_p1", "sp_p2"], connected_source_net_ids: ["source_net_0"], display_name: "SIG", subcircuit_connectivity_map_key: "k0" },
    // The blank's via: present before routing, no net.
    { type: "pcb_via", pcb_via_id: "pcb_via_0", x: 0, y: 0, outer_diameter: 1, hole_diameter: 0.2, from_layer: "top", to_layer: "bottom", layers: ["top", "bottom"], net_is_assignable: true },
  ];
}

const trace = (viaX: number): SimplifiedPcbTrace => ({
  type: "pcb_trace",
  pcb_trace_id: "t",
  connection_name: "source_trace_0",
  route: [
    { route_type: "wire", x: -5, y: 0, width: 0.2, layer: "top" },
    { route_type: "wire", x: viaX, y: 0, width: 0.2, layer: "top" },
    { route_type: "via", x: viaX, y: 0, from_layer: "top", to_layer: "bottom" },
    { route_type: "wire", x: viaX, y: 0, width: 0.2, layer: "bottom" },
    { route_type: "wire", x: 5, y: 0, width: 0.2, layer: "bottom" },
  ],
});

const vias = (cj: unknown[]) => cj.filter((e) => (e as { type: string }).type === "pcb_via") as Array<Record<string, unknown>>;

describe("mergeTraces with assignable (factory) vias", () => {
  test("a router via on a factory via claims it instead of adding a second via", () => {
    const merged = mergeTraces(circuit(), [trace(0.02)], { source_trace_0: "source_trace_0" });
    const vs = vias(merged);
    expect(vs).toHaveLength(1);
    const via = vs[0]!;
    expect(via.pcb_via_id).toBe("pcb_via_0");
    expect(via.net_is_assignable).toBe(true);
    expect(via.net_assigned).toBe(true);
    expect(via.source_trace_id).toBe("source_trace_0");
    expect(via.source_net_id).toBe("source_net_0");
    expect(via.subcircuit_connectivity_map_key).toBe("k0");
    expect(via.pcb_trace_id).toBe(merged.find((e) => (e as { type: string }).type === "pcb_trace" && (e as { source_trace_id?: string }).source_trace_id === "source_trace_0")!.pcb_trace_id);
    // The trace's via point snaps to the factory via and carries its drill/pad sizes.
    const pcbTrace = merged.find((e) => (e as { type: string }).type === "pcb_trace") as { route: Array<Record<string, unknown>> };
    const viaPoint = pcbTrace.route.find((p) => p.route_type === "via")!;
    expect(viaPoint.x).toBe(0);
    expect(viaPoint.outer_diameter).toBe(1);
    expect(viaPoint.hole_diameter).toBe(0.2);
    expect(viaPoint.pcb_via_id).toBe("pcb_via_0");
  });

  test("a router via elsewhere still becomes a new via and leaves an untouched factory via unclaimed", () => {
    // Move the factory via off the wire's path (y = 0) so nothing runs across it.
    const cj = circuit().map((e) => ((e as { type: string }).type === "pcb_via" ? { ...(e as object), y: 3 } : e));
    const merged = mergeTraces(cj, [trace(2)], { source_trace_0: "source_trace_0" });
    const vs = vias(merged);
    expect(vs).toHaveLength(2);
    const factory = vs.find((v) => v.pcb_via_id === "pcb_via_0")!;
    expect(factory.net_assigned).toBeUndefined();
    expect(factory.pcb_trace_id).toBeUndefined();
    const added = vs.find((v) => v.pcb_via_id !== "pcb_via_0")!;
    expect(added.x).toBe(2);
    expect(added.net_is_assignable).toBeUndefined();
  });

  test("a wire running across an unclaimed factory via claims it for that net too", () => {
    const cj = circuit();
    // A second factory via 0.3 mm beside the wire's path (pad radius 0.5 + half width 0.1 reaches it).
    cj.push({ type: "pcb_via", pcb_via_id: "pcb_via_1", x: -2, y: 0.3, outer_diameter: 1, hole_diameter: 0.2, from_layer: "top", to_layer: "bottom", layers: ["top", "bottom"], net_is_assignable: true });
    const merged = mergeTraces(cj, [trace(0)], { source_trace_0: "source_trace_0" });
    const vs = vias(merged);
    expect(vs).toHaveLength(2);
    for (const v of vs) {
      expect(v.net_assigned).toBe(true);
      expect(v.source_trace_id).toBe("source_trace_0");
    }
  });

  test("unrouting and re-routing releases and re-claims the factory via; it is never deleted", () => {
    const first = mergeTraces(circuit(), [trace(0)], { source_trace_0: "source_trace_0" });
    const unrouted = unrouteCircuit(first);
    const afterUnroute = vias(unrouted);
    expect(afterUnroute).toHaveLength(1);
    expect(afterUnroute[0]!.net_assigned).toBeUndefined();
    expect(afterUnroute[0]!.pcb_trace_id).toBeUndefined();
    expect(afterUnroute[0]!.source_trace_id).toBeUndefined();
    expect(unrouted.some((e) => (e as { type: string }).type === "pcb_trace")).toBe(false);

    const second = mergeTraces(unrouted, [trace(0)], { source_trace_0: "source_trace_0" });
    const vs = vias(second);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.net_assigned).toBe(true);
    expect(second.filter((e) => (e as { type: string }).type === "pcb_trace")).toHaveLength(1);
  });
});
