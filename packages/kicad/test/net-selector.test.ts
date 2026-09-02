import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToKicad, findKicadCli, runDrc, type KicadCli } from "../src/index";

const cli = await findKicadCli();

type El = Record<string, unknown> & { type: string };

/** `(net N)` of every `segment` / `via` block in a .kicad_pcb, in file order. */
function copperNets(pcb: string, kind: "segment" | "via"): number[] {
  const re = new RegExp(`\\(${kind}\\b[\\s\\S]*?\\(net (\\d+)\\)`, "g");
  return [...pcb.matchAll(re)].map((m) => Number(m[1]));
}

async function convertFixture(circuitJson: unknown[]): Promise<{ dir: string; pcb: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-kicad-net-"));
  await convertToKicad({ circuitJson, projectDir: dir, projectName: "board" });
  return { dir, pcb: await Bun.file(join(dir, "board.kicad_pcb")).text() };
}

/**
 * Regression: a board whose rails are `<net name="GND" />` + `to="net.GND"` selectors, routed by
 * @fabdesk/router and merged by @fabdesk/tscircuit. Before mergeTraces stamped
 * subcircuit_connectivity_map_key on its output, circuit-json-to-kicad could not resolve the
 * source_net_id it found in source_trace_id and wrote every segment with `(net 0)`.
 */
describe("net-selector routes keep their KiCad net", () => {
  const fixture = () => Bun.file(join(import.meta.dir, "fixtures/net-selector.routed.circuit.json")).json() as Promise<unknown[]>;

  test("every segment is on a named net", async () => {
    const circuitJson = await fixture();
    const traces = circuitJson.filter((e) => (e as El).type === "pcb_trace") as El[];
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((t) => typeof t.source_trace_id === "string" && t.source_trace_id.startsWith("source_net_"))).toBe(true);
    const { pcb } = await convertFixture(circuitJson);
    const nets = new Map([...pcb.matchAll(/\(net (\d+) "([^"]*)"\)/g)].map((m) => [Number(m[1]), m[2]]));
    expect([...nets.values()].sort()).toEqual(["", "GND", "V5"]);
    const segmentNets = copperNets(pcb, "segment");
    expect(segmentNets.length).toBeGreaterThan(0);
    expect(segmentNets.every((n) => n > 0)).toBe(true);
    expect(new Set(segmentNets.map((n) => nets.get(n)))).toEqual(new Set(["GND", "V5"]));
  });

  test("vias inherit the net through pcb_trace_id and source_net_id", async () => {
    const circuitJson = await fixture();
    const gnd = circuitJson.find((e) => (e as El).type === "source_net" && (e as El).name === "GND") as El;
    // A synthetic net-selector route with a via, shaped exactly like mergeTraces output.
    const withVia: unknown[] = [
      ...circuitJson,
      {
        type: "pcb_trace",
        pcb_trace_id: "pcb_trace_via_test",
        subcircuit_id: gnd.subcircuit_id,
        source_trace_id: gnd.source_net_id,
        subcircuit_connectivity_map_key: gnd.subcircuit_connectivity_map_key,
        route_thickness_mode: "constant",
        route: [
          { route_type: "wire", x: 0, y: 6, width: 0.15, layer: "top" },
          { route_type: "via", x: 2, y: 6, from_layer: "top", to_layer: "bottom", outer_diameter: 0.6, hole_diameter: 0.3 },
          { route_type: "wire", x: 4, y: 6, width: 0.15, layer: "bottom" },
        ],
      },
      {
        type: "pcb_via",
        pcb_via_id: "pcb_via_test",
        subcircuit_id: gnd.subcircuit_id,
        x: 2,
        y: 6,
        outer_diameter: 0.6,
        hole_diameter: 0.3,
        layers: ["top", "bottom"],
        pcb_trace_id: "pcb_trace_via_test",
        source_trace_id: gnd.source_net_id,
        source_net_id: gnd.source_net_id,
        subcircuit_connectivity_map_key: gnd.subcircuit_connectivity_map_key,
      },
    ];
    const { pcb } = await convertFixture(withVia);
    const gndNet = Number(/\(net (\d+) "GND"\)/.exec(pcb)?.[1]);
    expect(gndNet).toBeGreaterThan(0);
    expect(copperNets(pcb, "via")).toEqual([gndNet]);
    expect(copperNets(pcb, "segment").every((n) => n > 0)).toBe(true);
  });

  test.skipIf(cli === null)("kicad-cli DRC is clean", async () => {
    const { dir } = await convertFixture(await fixture());
    const report = await runDrc(cli as KicadCli, { board: join(dir, "board.kicad_pcb"), outFile: join(dir, "drc.json"), severity: "error" });
    expect(report.counts.unconnected).toBe(0);
    expect(report.violations.filter((v) => v.severity === "error")).toEqual([]);
  }, 60_000);
});
