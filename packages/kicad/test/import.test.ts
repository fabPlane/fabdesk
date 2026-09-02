import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildNetNameMap, canonicalNetName, importKicadPcb, KicadImportError } from "../src/index";

const FIXTURE = join(import.meta.dir, "fixtures", "mini-two-layer.kicad_pcb");
type El = Record<string, unknown> & { type: string };
const ofType = (cj: unknown[], type: string) => cj.filter((e) => (e as El).type === type) as El[];

describe("canonical net names", () => {
  test("strips sheet paths and punctuation deterministically", () => {
    expect(canonicalNetName("/CM5/DPHY0_P.D0_N")).toBe("CM5_DPHY0_P_D0_N");
    expect(canonicalNetName("+3V3")).toBe("P3V3");
    expect(canonicalNetName("-12V")).toBe("N12V");
    expect(canonicalNetName("Net-(R1-Pad1)")).toBe("Net_R1_Pad1");
    expect(canonicalNetName("GND")).toBe("GND");
  });
  test("accepts sheet-path aliases and flags real collisions", () => {
    const ok = buildNetNameMap(["/CM5/DPHY0_P.D0_N", "DPHY0_P.D0_N", "GND"]);
    expect(ok.collisions).toEqual([]);
    expect(ok.canonical["CM5_DPHY0_P_D0_N"]?.aliases).toEqual(["/CM5/DPHY0_P.D0_N"]);
    expect(ok.byOriginal["DPHY0_P.D0_N"]).toBe("DPHY0_P_D0_N");
    const bad = buildNetNameMap(["A.B", "A-B", "A_B"]);
    expect(bad.collisions).toEqual([{ canonical: "A_B", originals: ["A.B", "A-B", "A_B"] }]);
    expect(bad.canonical["A_B"]?.aliases).toEqual(["A.B", "A-B", "A_B"]);
  });
});

describe("importKicadPcb (stable format, net table)", () => {
  test("imports geometry, links every pad/track/via/pour to a canonical net and reports the rest", async () => {
    const { circuitJson, report } = await importKicadPcb({ pcbPath: FIXTURE });
    expect(report.failures).toEqual([]);
    expect(report.source.netEncoding).toBe("net-table");
    expect(report.source.footprintPlacement).toBe("at");
    expect(report.layers.copperCount).toBe(2);
    expect(report.layers.mapping.map((m) => `${m.kicad}>${m.circuitJson}`)).toEqual([
      "F.Cu>top",
      "B.Cu>bottom",
    ]);
    expect(report.counts).toMatchObject({
      footprints: 3,
      pads: 6,
      segments: 4,
      vias: 1,
      zones: 2,
      filledPolygons: 1,
      ruleAreas: 1,
      nets: 3,
      netsRoutable: 3,
    });
    expect(report.dropped.map((d) => d.kind)).toEqual(["rule-area"]);
    expect(report.unsupported).toEqual([]);
    expect(report.copper).toMatchObject({
      tracesUnlinked: 0,
      viasLinked: 1,
      viasUnlinked: 0,
      poursLinked: 1,
      poursUnlinked: 0,
      padsLinked: 6,
      padsUnlinked: 0,
    });
    expect(report.copper.tracesLinked).toBeGreaterThanOrEqual(2);
    expect(Object.keys(report.nets.canonical).sort()).toEqual(["GND", "P3V3", "sig_SDA"]);
    expect(report.nets.canonical["sig_SDA"]?.original).toBe("/sig/SDA");
    expect(report.designRules).toMatchObject({
      netclass: "Default",
      traceWidthMm: 0.25,
      clearanceMm: 0.2,
      viaDiameterMm: 0.6,
      viaDrillMm: 0.3,
      minCopperEdgeClearanceMm: 0.5,
    });
    expect(report.board.widthMm).toBeCloseTo(15, 3);
    expect(report.board.heightMm).toBeCloseTo(15, 3);

    const board = ofType(circuitJson, "pcb_board")[0]!;
    expect(board["num_layers"]).toBe(2);
    const nets = ofType(circuitJson, "source_net");
    expect(nets.map((n) => n["name"]).sort()).toEqual(["GND", "P3V3", "sig_SDA"]);
    const traces = ofType(circuitJson, "source_trace");
    expect(traces).toHaveLength(3);
    for (const t of traces) expect((t["connected_source_port_ids"] as string[]).length).toBe(2);
    const ports = ofType(circuitJson, "source_port");
    expect(ports).toHaveLength(6);
    for (const p of ports) expect(String(p["source_component_id"])).toMatch(/^source_component_/);
    // Every pcb_port's source_port exists (what @tscircuit/core needs for connection endpoints).
    const portIds = new Set(ports.map((p) => p["source_port_id"]));
    for (const pp of ofType(circuitJson, "pcb_port"))
      expect(portIds.has(pp["source_port_id"])).toBe(true);
    // Copper carries the net.
    for (const el of [...ofType(circuitJson, "pcb_trace"), ...ofType(circuitJson, "pcb_via")]) {
      expect(String(el["source_trace_id"])).toMatch(/^source_trace_/);
      expect(String(el["source_net_id"])).toMatch(/^source_net_/);
    }
    const pour = ofType(circuitJson, "pcb_copper_pour")[0]!;
    expect(pour["net_name"]).toBe("GND");
    expect(pour["layer"]).toBe("bottom");
    // The diagonal segment survives as a route point (core would have refused it; srj.ts handles it).
    const sda = ofType(circuitJson, "pcb_trace").find(
      (t) =>
        t["source_trace_id"] ===
        traces.find((s) => s["display_name"] === "sig_SDA")?.["source_trace_id"],
    );
    expect(sda).toBeDefined();
  });

  test("strict mode fails closed on a net-name collision and still hands back the report", async () => {
    const text = await Bun.file(FIXTURE).text();
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-kicad-import-"));
    const path = join(dir, "collide.kicad_pcb");
    // "/sig/SDA" and "sig.SDA" both canonicalize to sig_SDA but are different nets.
    await writeFile(
      path,
      text
        .replace('(net 3 "+3V3")', '(net 3 "sig.SDA")')
        .replaceAll('(net 3 "+3V3")', '(net 3 "sig.SDA")'),
    );
    let caught: unknown;
    try {
      await importKicadPcb({ pcbPath: path });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(KicadImportError);
    const err = caught as KicadImportError;
    expect(err.report.nets.collisions).toEqual([
      { canonical: "sig_SDA", originals: ["/sig/SDA", "sig.SDA"] },
    ]);
    expect(err.report.failures[0]).toContain("collision");
    const lenient = await importKicadPcb({ pcbPath: path, strict: false });
    expect(lenient.report.failures.length).toBe(1);
  });
});

describe("importKicadPcb (nightly format: transform placement, nets by name)", () => {
  /** Rewrites the stable fixture the way KiCad 10.99 serializes it: no net table, `(net "name")` everywhere, `(transform ...)` placement. */
  async function nightlyFixture(): Promise<string> {
    const text = await Bun.file(FIXTURE).text();
    const table = new Map<string, string>();
    for (const m of text.matchAll(/^\t\(net (\d+) "([^"]*)"\)\n/gm)) table.set(m[1]!, m[2]!);
    let out = text.replace(/^\t\(net \d+ "[^"]*"\)\n/gm, "");
    out = out.replace(
      /\(net (\d+)(?: "[^"]*")?\)/g,
      (_m, n: string) => `(net "${table.get(n) ?? ""}")`,
    );
    out = out.replace(/\(net_name "[^"]*"\)\n\s*/g, "");
    out = out
      .replace(/\(version 20241229\)/, "(version 20260728)")
      .replace('(generator_version "9.0")', '(generator_version "10.99")');
    // Footprint placement only: the `(at ...)` at indentation 2 between `(footprint` and its first `(property`.
    const lines = out.split("\n");
    let header = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.startsWith("\t(footprint")) header = true;
      else if (line.startsWith("\t\t(property")) header = false;
      const m = header ? /^\t\t\(at (-?[\d.]+) (-?[\d.]+)(?: (-?[\d.]+))?\)$/.exec(line) : null;
      if (m)
        lines[i] =
          `\t\t(transform\n\t\t\t(translate ${m[1]} ${m[2]})\n\t\t\t(rotate ${m[3] ?? 0})\n\t\t\t(scale 1 1)\n\t\t)`;
    }
    out = lines.join("\n");
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-kicad-nightly-"));
    const path = join(dir, "mini-nightly.kicad_pcb");
    await writeFile(path, out);
    return path;
  }

  test("recovers nets the converter drops and places footprints from (transform)", async () => {
    const path = await nightlyFixture();
    const { circuitJson, report } = await importKicadPcb({ pcbPath: path });
    expect(report.failures).toEqual([]);
    expect(report.source.netEncoding).toBe("net-by-name");
    expect(report.source.footprintPlacement).toBe("transform");
    expect(report.source.kicadVersion).toBe(20260728);
    expect(Object.keys(report.nets.canonical).sort()).toEqual(["GND", "P3V3", "sig_SDA"]);
    expect(report.copper).toMatchObject({
      tracesUnlinked: 0,
      viasLinked: 1,
      poursLinked: 1,
      padsLinked: 6,
      padsUnlinked: 0,
    });
    expect(report.designRules).toBeNull();
    // Same pad positions as the stable file: R1 pad 1 sits 0.51 mm left of the footprint origin.
    const r1 = ofType(circuitJson, "source_component").find((c) => c["name"] === "R1")!;
    const comp = ofType(circuitJson, "pcb_component").find(
      (c) => c["source_component_id"] === r1["source_component_id"],
    )!;
    const pads = ofType(circuitJson, "pcb_smtpad").filter(
      (p) => p["pcb_component_id"] === comp["pcb_component_id"],
    );
    expect(pads).toHaveLength(2);
    const xs = pads.map((p) => p["x"] as number).sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeCloseTo(1.02, 3);
  });
});
