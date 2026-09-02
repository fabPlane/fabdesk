import type { SimpleRouteJson } from "@fabdesk/protocol";

type Layer = "top" | "bottom";

function pad(
  name: string,
  x: number,
  y: number,
  layer: Layer,
): SimpleRouteJson["obstacles"][number] {
  return {
    type: "rect",
    layers: [layer],
    center: { x, y },
    width: 1,
    height: 1,
    connectedTo: [name],
  };
}

function connection(
  name: string,
  a: [number, number, Layer],
  b: [number, number, Layer],
): SimpleRouteJson["connections"][number] {
  return {
    name,
    source_trace_id: `source_trace_${name}`,
    pointsToConnect: [
      { x: a[0], y: a[1], layer: a[2], pcb_port_id: `${name}_1` },
      { x: b[0], y: b[1], layer: b[2], pcb_port_id: `${name}_2` },
    ],
  };
}

/**
 * A 20 x 20 mm two-layer board: three horizontal top-layer nets, one vertical bottom-layer net
 * crossing them, and a keepout bar in the middle that the centre net must route around.
 */
export function fixtureSrj(): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.15,
    minViaHoleDiameter: 0.3,
    minViaPadDiameter: 0.6,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    obstacles: [
      pad("A", -8, -6, "top"),
      pad("A", 8, -6, "top"),
      pad("B", -8, 6, "top"),
      pad("B", 8, 6, "top"),
      pad("C", -8, 0, "top"),
      pad("C", 8, 0, "top"),
      pad("D", -6, -8, "bottom"),
      pad("D", -6, 8, "bottom"),
      {
        type: "rect",
        layers: ["top", "bottom"],
        center: { x: 0, y: 0 },
        width: 2,
        height: 6,
        connectedTo: [],
      },
    ],
    connections: [
      connection("A", [-8, -6, "top"], [8, -6, "top"]),
      connection("B", [-8, 6, "top"], [8, 6, "top"]),
      connection("C", [-8, 0, "top"], [8, 0, "top"]),
      connection("D", [-6, -8, "bottom"], [-6, 8, "bottom"]),
    ],
  };
}

export const FIXTURE_CONNECTIONS = ["A", "B", "C", "D"];

function padOf(names: string[], x: number, y: number): SimpleRouteJson["obstacles"][number] {
  return {
    type: "rect",
    layers: ["top"],
    center: { x, y },
    width: 1,
    height: 1,
    connectedTo: names,
  };
}

function point(x: number, y: number, port: string): SimpleRouteJson["connections"][number]["pointsToConnect"][number] {
  return { x, y, layer: "top", pcb_port_id: port };
}

/**
 * A 20 x 20 mm board with two multi-pad nets, expressed the way tscircuit emits them: one SRJ
 * connection per pad pair, sharing `pcb_port_id`s (and pads whose `connectedTo` lists both
 * connections), plus one ordinary two-pad net. The capacity autorouter merges each chain into a
 * single net and names every trace after its first connection, so completion must be judged by
 * the copper rather than by trace names.
 *
 *   PWR: three pads, connections PWR_a (pad 1 → 2) and PWR_b (pad 2 → 3)
 *   GND: four pads, connections GND_a (1 → 2), GND_b (2 → 3), GND_c (3 → 4)
 *   SIG: two pads, connection SIG
 */
export function multiPadNetSrj(): SimpleRouteJson {
  return {
    layerCount: 2,
    minTraceWidth: 0.15,
    minViaHoleDiameter: 0.3,
    minViaPadDiameter: 0.6,
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 },
    obstacles: [
      padOf(["PWR_a"], -8, 0),
      padOf(["PWR_a", "PWR_b"], 0, 0),
      padOf(["PWR_b"], 8, 0),
      padOf(["GND_a"], -8, -6),
      padOf(["GND_a", "GND_b"], -3, -6),
      padOf(["GND_b", "GND_c"], 3, -6),
      padOf(["GND_c"], 8, -6),
      padOf(["SIG"], -8, 6),
      padOf(["SIG"], 8, 6),
    ],
    connections: [
      { name: "PWR_a", source_trace_id: "source_trace_PWR_a", pointsToConnect: [point(-8, 0, "pwr_1"), point(0, 0, "pwr_2")] },
      { name: "PWR_b", source_trace_id: "source_trace_PWR_b", pointsToConnect: [point(0, 0, "pwr_2"), point(8, 0, "pwr_3")] },
      { name: "GND_a", source_trace_id: "source_trace_GND_a", pointsToConnect: [point(-8, -6, "gnd_1"), point(-3, -6, "gnd_2")] },
      { name: "GND_b", source_trace_id: "source_trace_GND_b", pointsToConnect: [point(-3, -6, "gnd_2"), point(3, -6, "gnd_3")] },
      { name: "GND_c", source_trace_id: "source_trace_GND_c", pointsToConnect: [point(3, -6, "gnd_3"), point(8, -6, "gnd_4")] },
      { name: "SIG", source_trace_id: "source_trace_SIG", pointsToConnect: [point(-8, 6, "sig_1"), point(8, 6, "sig_2")] },
    ],
  };
}

export const MULTI_PAD_CONNECTIONS = ["GND_a", "GND_b", "GND_c", "PWR_a", "PWR_b", "SIG"];
