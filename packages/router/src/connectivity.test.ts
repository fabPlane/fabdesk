import { describe, expect, test } from "bun:test";
import type { SimplifiedPcbTrace } from "@fabdesk/protocol";

import { NetGroups, classifyConnections } from "./connectivity";
import { MULTI_PAD_CONNECTIONS, fixtureSrj, multiPadNetSrj } from "./testing/fixture";

function wire(
  connection: string,
  points: readonly [number, number][],
  layer = "top",
  id = `trace_${connection}_${Math.random().toString(36).slice(2, 6)}`,
): SimplifiedPcbTrace {
  return {
    type: "pcb_trace",
    pcb_trace_id: id,
    connection_name: connection,
    route: points.map(([x, y]) => ({ route_type: "wire", x, y, width: 0.15, layer })),
  };
}

describe("NetGroups", () => {
  test("connections sharing a pad or port form one net, in request order", () => {
    const groups = new NetGroups(multiPadNetSrj());
    expect(groups.members("PWR_b")).toEqual(["PWR_a", "PWR_b"]);
    expect(groups.members("GND_c")).toEqual(["GND_a", "GND_b", "GND_c"]);
    expect(groups.members("SIG")).toEqual(["SIG"]);
    expect(groups.representative("gnd_3")).toBe("GND_a");
    expect(groups.representative("source_trace_PWR_b")).toBe("PWR_a");
    expect(groups.netId("PWR_a")).toBeDefined();
    expect(groups.netId("PWR_a")).not.toBe(groups.netId("GND_a"));
    expect(groups.netId("nope")).toBeUndefined();
    expect(groups.members("nope")).toEqual([]);
  });

  test("onlyConnections restricts members to the routed subset", () => {
    const groups = new NetGroups(multiPadNetSrj(), ["GND_b", "SIG"]);
    expect(groups.names).toEqual(["GND_b", "SIG"]);
    expect(groups.members("GND_a")).toEqual(["GND_b"]);
  });

  test("alias() attaches a router's internal name to the net of its points", () => {
    const groups = new NetGroups(multiPadNetSrj());
    groups.alias("PWR_a__PWR_b_mst1", [{ x: 0, y: 0, layer: "top", pcb_port_id: "pwr_2" }]);
    expect(groups.representative("PWR_a__PWR_b_mst1")).toBe("PWR_a");
  });
});

describe("classifyConnections", () => {
  test("a merged net's traces complete every member connection regardless of trace names", () => {
    const srj = multiPadNetSrj();
    const traces = [
      // The solver names both PWR traces after the first connection of the net.
      wire("PWR_a", [[0, 0], [-8, 0]]),
      wire("PWR_a", [[0, 0], [8, 0]]),
      // GND routed as a star from pad 2, again under one name.
      wire("GND_a", [[-3, -6], [-8, -6]]),
      wire("GND_a", [[-3, -6], [0, -7], [3, -6]]),
      wire("GND_a", [[3, -6], [8, -6]]),
      wire("SIG", [[-8, 6], [8, 6]]),
    ];
    const { complete, open } = classifyConnections(srj, traces);
    expect([...complete].sort()).toEqual(MULTI_PAD_CONNECTIONS);
    expect(open).toEqual([]);
  });

  test("a missing link leaves only the affected connections open, in request order", () => {
    const srj = multiPadNetSrj();
    const traces = [
      wire("PWR_a", [[0, 0], [-8, 0]]),
      wire("GND_a", [[-3, -6], [-8, -6]]),
      wire("GND_a", [[3, -6], [8, -6]]),
      wire("SIG", [[-8, 6], [8, 6]]),
    ];
    expect(classifyConnections(srj, traces)).toEqual({
      complete: ["PWR_a", "GND_a", "GND_c", "SIG"],
      open: ["PWR_b", "GND_b"],
    });
  });

  test("copper joins through vias and through pads a trace ends on", () => {
    const srj = fixtureSrj();
    const traces: SimplifiedPcbTrace[] = [
      // A: leaves the pad edge on top, drops to bottom and climbs back inside the far pad.
      {
        type: "pcb_trace",
        pcb_trace_id: "a",
        connection_name: "A",
        route: [
          { route_type: "wire", x: -7.6, y: -6, width: 0.15, layer: "top" },
          { route_type: "wire", x: -5, y: -6, width: 0.15, layer: "top" },
          { route_type: "via", x: -5, y: -6, from_layer: "top", to_layer: "bottom" },
          { route_type: "wire", x: -5, y: -6, width: 0.15, layer: "bottom" },
          { route_type: "wire", x: 7.7, y: -6.2, width: 0.15, layer: "bottom" },
          { route_type: "via", x: 7.7, y: -6.2, from_layer: "bottom", to_layer: "top" },
        ],
      },
      // B: two separate traces whose ends touch within half a trace width.
      wire("B", [[-8, 6], [0, 6]]),
      wire("B", [[0.05, 6.02], [8, 6]]),
      // C: two traces on different layers that meet in x/y but have no via between them.
      wire("C", [[-8, 0], [0, 0.5]], "top"),
      wire("C", [[0, 0.5], [8, 0]], "bottom"),
      // D: a bottom-layer trace that runs across A's top pad area, which must not count.
      wire("D", [[-6, -8], [-8, -6]], "bottom"),
    ];
    expect(classifyConnections(srj, traces)).toEqual({ complete: ["A", "B"], open: ["C", "D"] });
  });

  test("a trace crossing another net's pad does not complete that net", () => {
    const srj = multiPadNetSrj();
    // SIG's trace wanders straight through both PWR pads; PWR has no copper of its own.
    const traces = [wire("SIG", [[-8, 6], [-8, 0], [0, 0], [8, 0], [8, 6]])];
    const { complete, open } = classifyConnections(srj, traces);
    expect(complete).toEqual(["SIG"]);
    expect(open).toEqual(["PWR_a", "PWR_b", "GND_a", "GND_b", "GND_c"]);
  });

  test("a connection with fewer than two points has nothing to route and is complete", () => {
    const srj = multiPadNetSrj();
    srj.connections.push(
      { name: "LONE", pointsToConnect: [{ x: 5, y: 5, layer: "top" }] },
      { name: "EMPTY", pointsToConnect: [] },
    );
    const { complete, open } = classifyConnections(srj, [], ["LONE", "EMPTY", "SIG"]);
    expect(complete).toEqual(["LONE", "EMPTY"]);
    expect(open).toEqual(["SIG"]);
  });

  test("a via spans every layer between from_layer and to_layer on a four-layer board", () => {
    const srj = fixtureSrj();
    srj.layerCount = 4;
    const inner: SimplifiedPcbTrace[] = [
      wire("A", [[-8, -6], [0, -6]]),
      {
        type: "pcb_trace",
        pcb_trace_id: "a_via",
        connection_name: "A",
        route: [{ route_type: "via", x: 0, y: -6, from_layer: "top", to_layer: "bottom" }],
      },
      wire("A", [[0, -6], [4, -6]], "inner2"),
      {
        type: "pcb_trace",
        pcb_trace_id: "a_via2",
        connection_name: "A",
        route: [{ route_type: "via", x: 4, y: -6, from_layer: "inner2", to_layer: "top" }],
      },
      wire("A", [[4, -6], [8, -6]]),
    ];
    expect(classifyConnections(srj, inner, ["A"])).toEqual({ complete: ["A"], open: [] });
    // Without the through via the inner-layer run is stranded.
    expect(classifyConnections(srj, inner.filter((t) => t.pcb_trace_id !== "a_via"), ["A"])).toEqual({
      complete: [],
      open: ["A"],
    });
  });

  test("tolerance decides whether nearby trace ends touch", () => {
    const srj = fixtureSrj();
    const traces = [wire("A", [[-8, -6], [0, -6]]), wire("A", [[0.2, -6], [8, -6]])];
    expect(classifyConnections(srj, traces, ["A"]).open).toEqual(["A"]);
    expect(classifyConnections(srj, traces, ["A"], { tolerance: 0.25 }).complete).toEqual(["A"]);
  });

  test("traces with an unknown or missing connection name count for any net", () => {
    const srj = fixtureSrj();
    const anonymous: SimplifiedPcbTrace = { ...wire("A", [[-8, -6], [8, -6]]), connection_name: undefined };
    expect(classifyConnections(srj, [anonymous], ["A"]).complete).toEqual(["A"]);
    expect(classifyConnections(srj, [wire("freerouting_net_7", [[-8, 6], [8, 6]])], ["B"]).complete).toEqual(["B"]);
  });

  test("copper of a different known net never joins, even when it lands on the pad", () => {
    const srj = fixtureSrj();
    // A trace attributed to B runs exactly between A's pads.
    expect(classifyConnections(srj, [wire("B", [[-8, -6], [8, -6]])], ["A", "B"])).toEqual({
      complete: [],
      open: ["A", "B"],
    });
  });

  test("names limits the verdict to the requested connections", () => {
    const srj = multiPadNetSrj();
    expect(classifyConnections(srj, [wire("SIG", [[-8, 6], [8, 6]])], ["SIG", "PWR_b"])).toEqual({
      complete: ["SIG"],
      open: ["PWR_b"],
    });
  });
});
