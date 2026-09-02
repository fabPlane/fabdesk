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
