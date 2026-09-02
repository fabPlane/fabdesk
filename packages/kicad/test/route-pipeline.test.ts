import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimplifiedPcbTrace } from "@fabdesk/protocol";
import { extractSimpleRouteJson, mergeTraces } from "@fabdesk/tscircuit";
import { convertToKicad } from "../src/index";

type El = Record<string, unknown> & { type: string };

/** Straight top-layer run between a connection's first two points, plus a via in the middle. */
function syntheticTrace(connection: { name: string; pointsToConnect: Array<{ x: number; y: number }> }): SimplifiedPcbTrace {
  const [a, b] = connection.pointsToConnect as [{ x: number; y: number }, { x: number; y: number }];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return {
    type: "pcb_trace",
    pcb_trace_id: `${connection.name}_mst0_0`,
    connection_name: connection.name,
    route: [
      { route_type: "wire", x: a.x, y: a.y, width: 0.15, layer: "top" },
      { route_type: "wire", x: mid.x, y: mid.y, width: 0.15, layer: "top" },
      { route_type: "via", x: mid.x, y: mid.y, from_layer: "top", to_layer: "bottom" },
      { route_type: "wire", x: b.x, y: b.y, width: 0.15, layer: "bottom" },
    ],
  };
}

async function routeAndConvert(fixture: string): Promise<{ merged: unknown[]; pcb: string }> {
  const circuitJson = (await Bun.file(join(import.meta.dir, "fixtures", fixture)).json()) as unknown[];
  const { srj, connectionMap } = extractSimpleRouteJson(circuitJson);
  const merged = mergeTraces(circuitJson, srj.connections.map(syntheticTrace), connectionMap);
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-kicad-pipeline-"));
  await convertToKicad({ circuitJson: merged, projectDir: dir, projectName: "board" });
  return { merged, pcb: await Bun.file(join(dir, "board.kicad_pcb")).text() };
}

function netNamesOf(pcb: string, kind: "segment" | "via"): string[] {
  const names = new Map([...pcb.matchAll(/\(net (\d+) "([^"]*)"\)/g)].map((m) => [m[1], m[2]]));
  const re = new RegExp(`\\(${kind}\\b[\\s\\S]*?\\(net (\\d+)\\)`, "g");
  return [...pcb.matchAll(re)].map((m) => names.get(m[1]!) ?? "<missing>");
}

/**
 * The real contract: whatever @fabdesk/tscircuit's SRJ extraction + mergeTraces produce for a
 * board, circuit-json-to-kicad must put every segment and via on a named net. Covers both the
 * pin-to-pin (led-usb) and the net-selector (net-selector) connection styles.
 */
describe("SRJ -> mergeTraces -> convertToKicad keeps nets", () => {
  for (const fixture of ["led-usb.circuit.json", "net-selector.routed.circuit.json"]) {
    test(fixture, async () => {
      const { merged, pcb } = await routeAndConvert(fixture);
      const connections = new Set(
        (merged.filter((e) => (e as El).type === "pcb_trace") as El[]).map((t) => t.source_trace_id),
      );
      expect(connections.size).toBeGreaterThan(0);
      const segments = netNamesOf(pcb, "segment");
      const vias = netNamesOf(pcb, "via");
      expect(segments.length).toBeGreaterThan(0);
      expect(vias.length).toBe(connections.size);
      expect(segments.every((n) => n !== "" && n !== "<missing>")).toBe(true);
      expect(vias.every((n) => n !== "" && n !== "<missing>")).toBe(true);
    });
  }
});
