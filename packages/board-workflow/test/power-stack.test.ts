/**
 * The inner-power audit, the atlc section bitmap and the mismatched-section helper. The first six cases are the toolkit's
 * `review/test_stack_resolution.py` (the power-review escapes found on C6's stack change), ported one for one.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoard } from "../src/board";
import { parseSexpr } from "../src/sexpr";
import { pairSection, pyFloat, sectionBitmap, type SectionSpec } from "../src/review/atlc";
import { pathCensus } from "../src/review/current-paths";
import { shortSection } from "../src/review/impedance";
import { loadNetlist } from "../src/review/netlist";
import { auditPower, checkInnerPower, riseEcss2152Vac, stackCensus, terminal } from "../src/review/power-stack";
import type { ReviewCtx } from "../src/review/context";
import type { Acceptance } from "../src/requirements";

describe("stack regression (toolkit test_stack_resolution.py)", () => {
  test("exported power types, not the name heuristic", () => {
    for (const [name, typ] of [
      ["VD18", "power_in"],
      ["VD18_O", "power_out"],
      ["PLLVCC", "power_in"],
      ["DVDD", "passive"],
    ] as const)
      expect(terminal({ ref: "U1", function: name, type: typ })).toBe(true);
    expect(terminal({ ref: "U1", function: "OVCJ", type: "input" })).toBe(false);
  });

  test("no phantom cross-layer connection", () => {
    const tr = [
      { a: [0, 0] as const, b: [1, 0] as const, w: 0.2, layer: "F.Cu" },
      { a: [1, 0] as const, b: [2, 0] as const, w: 0.2, layer: "In3.Cu" },
    ];
    const pads = [
      { x: 0, y: 0, layers: ["F.Cu"], contact_r: 0.1 },
      { x: 2, y: 0, layers: ["In3.Cu"], contact_r: 0.1 },
    ];
    const cu = { "F.Cu": 0.035, "In3.Cu": 0.0152 };
    let r = pathCensus(tr, [], pads, cu, ["F.Cu", "In3.Cu"], [0, 1]);
    expect(r.disconnected_terminal_pairs).toEqual([[0, 1]]);
    const via = [{ x: 1, y: 0, layers: ["F.Cu", "In3.Cu"], size: 0.5 }];
    r = pathCensus(tr, via, pads, cu, ["F.Cu", "In3.Cu"], [0, 1]);
    expect(r.disconnected_terminal_pairs).toEqual([]);
    expect(r.resistance_ohm).toBeGreaterThan((1.72e-5 / 0.2) * (1 / 0.035 + 1 / 0.0152));
  });

  test("via in pad without a surface track", () => {
    const tr = [{ a: [0, 0] as const, b: [2, 0] as const, w: 0.2, layer: "In3.Cu" }];
    const vias = [0, 2].map((x) => ({ x, y: 0, layers: ["F.Cu", "In3.Cu"], size: 0.5 }));
    const pads = [0, 2].map((x) => ({ x, y: 0, layers: ["F.Cu"], contact_r: 0.15 }));
    const r = pathCensus(tr, vias, pads, { "F.Cu": 0.035, "In3.Cu": 0.0152 }, ["F.Cu", "In3.Cu"], [0, 1]);
    expect(r.missing_terminals).toEqual([]);
    expect(r.disconnected_terminal_pairs).toEqual([]);
    expect(r.trunk_segments).toEqual([0]);
  });

  test("published ECSS reference: 1 A on 925 um x 25 um is a 5 C rise", () => {
    expect(Math.abs(riseEcss2152Vac(1, 0.925, 0.025) - 5)).toBeLessThan(0.1);
  });

  test("finite section limit cases", () => {
    expect(shortSection(90, 90, 4.1, 10, 0.5).section_reflection_at_knee).toBeLessThan(1e-12);
    expect(shortSection(90, 110, 4.1, 0, 0.5).section_reflection_at_knee).toBeLessThan(1e-12);
    expect(shortSection(90, 110, 4.1, 6.06, 4).section_reflection_at_knee).toBeLessThan(0.01);
  });

  test("same-layer copper overlap without a via", () => {
    for (const b of [
      [1, 0.05],
      [1, -1],
    ] as const) {
      const tr = [
        { a: [0, 0] as const, b: [2, 0] as const, w: 0.2, layer: "B.Cu" },
        { a: b, b: [1, 1] as const, w: 0.2, layer: "B.Cu" },
      ];
      const pads = [
        { x: 0, y: 0, layers: ["B.Cu"], contact_r: 0.1 },
        { x: 1, y: 1, layers: ["B.Cu"], contact_r: 0.1 },
      ];
      const r = pathCensus(tr, [], pads, { "B.Cu": 0.035 }, ["B.Cu"], [0, 1]);
      expect(r.disconnected_terminal_pairs).toEqual([]);
      expect(r.resistance_ohm).toBeGreaterThan(0);
    }
  });
});

// a 3-layer board: J1 feeds U1's supply pin over In1.Cu through two through vias
const PCB = (vias: string) => `(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal))
  (setup (stackup
    (layer "F.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 1" (type "prepreg") (thickness 0.1) (epsilon_r 4.1))
    (layer "In1.Cu" (type "copper") (thickness 0.0152))
    (layer "dielectric 2" (type "core") (thickness 0.8) (epsilon_r 4.17))
    (layer "B.Cu" (type "copper") (thickness 0.035))))
  (net 0 "") (net 1 "+3V3")
  (footprint "c:J" (layer "F.Cu") (at 0 0) (property "Reference" "J1") (property "Value" "CONN")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "+3V3")))
  (footprint "c:U" (layer "F.Cu") (at 10 0) (property "Reference" "U1") (property "Value" "MCU")
    (pad "1" smd roundrect (at 0 0) (size 1 0.6) (layers "F.Cu") (roundrect_rratio 0.25) (net 1 "+3V3")))
  (segment (start 0 0) (end 1 0) (width 0.3) (layer "F.Cu") (net "+3V3"))
  (segment (start 1 0) (end 9 0) (width 0.3) (layer "In1.Cu") (net "+3V3"))
  (segment (start 9 0) (end 10 0) (width 0.3) (layer "F.Cu") (net "+3V3"))
  ${vias}
)`;
const VIA = (x: number) => `(via (at ${x} 0) (size 0.5) (drill 0.2) (layers "F.Cu" "B.Cu") (net "+3V3"))`;
const NETLIST = `<export><components><comp ref="J1"><value>CONN</value></comp><comp ref="U1"><value>MCU</value></comp></components>
<nets><net code="1" name="+3V3"><node ref="J1" pin="1" pinfunction="1" pintype="passive"/><node ref="U1" pin="1" pinfunction="VDD" pintype="power_in"/></net></nets></export>`;
const ACC = (extra: Record<string, unknown>) =>
  ({ stack_policy: { copper_layers: ["F.Cu", "In1.Cu", "B.Cu"] }, net_classes: { classes: {}, net_current_A: { "+3V3": 0.3 } }, ...extra }) as unknown as Acceptance;

async function runCheck(vias: string, acc: Acceptance, cfg: Record<string, unknown> = {}) {
  const out = await mkdtemp(join(tmpdir(), "inner-power-"));
  const text = PCB(vias);
  const root = parseSexpr(text);
  const ctx = { project: { cfg, pcb: join(out, "board.kicad_pcb") }, acceptance: acc, comps: loadNetlist(NETLIST), pcbText: text, root, board: readBoard(root), out } as unknown as ReviewCtx;
  try {
    const r = await checkInnerPower(ctx);
    const audit = r.artifacts["audit"] ? JSON.parse(await readFile(String(r.artifacts["audit"]), "utf8")) : null;
    return { r, audit };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

describe("inner_power check", () => {
  test("runs on a supplier stack and passes a connected net", async () => {
    const { r, audit } = await runCheck(VIA(1) + VIA(9), ACC({ supplier_stack: { power_width_reduction_mm: 0.01778 } }));
    expect(r.status).toBe("ok");
    expect(audit.rows[0].terminals).toEqual(["J1.1", "U1.1"]);
    expect(audit.rows[0].min_width_mm).toBeCloseTo(0.3 - 0.01778, 12);
    expect(r.findings.map((f) => [f.rule, f.severity, f.key])).toEqual([["INNER_POWER", "note", "complete"]]);
  });

  test("a terminal cut off on its own layer is must-fix", async () => {
    const { r, audit } = await runCheck(VIA(1), ACC({ supplier_stack: {} }));
    expect(audit.rows[0].graph.disconnected_terminal_pairs).toEqual([[0, 1]]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ rule: "INNER_POWER", severity: "must-fix", key: "+3V3", net: "+3V3" });
    expect(r.findings[0]!.claim).toContain("0 missing and 1 disconnected terminals");
  });

  test("skipped without a supplier stack unless the review config asks", async () => {
    expect((await runCheck(VIA(1) + VIA(9), ACC({}))).r.status).toBe("skipped");
    expect((await runCheck(VIA(1) + VIA(9), ACC({}), { inner_power: true })).r.status).toBe("ok");
    expect((await runCheck(VIA(1) + VIA(9), ACC({ supplier_stack: {} }), { inner_power: false })).r.status).toBe("skipped");
  });

  test("the census names pin types from the netlist", () => {
    const text = PCB(VIA(1) + VIA(9));
    const root = parseSexpr(text);
    const c = stackCensus(text, root, readBoard(root), ACC({}), loadNetlist(NETLIST));
    expect(c.inner_power["+3V3"]!.pads.map((p) => [p.ref, p.function, p.type, p.contact_shape?.shape])).toEqual([
      ["J1", "1", "passive", "rect"],
      ["U1", "VDD", "power_in", "roundrect"],
    ]);
    expect(auditPower(c).rows[0]!.pass).toBe(true);
  });
});

describe("atlc section", () => {
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  test("the bitmap is the toolkit's, byte for byte (C6 stack106 usb-class-4um)", () => {
    const spec: SectionSpec = {
      box: [-1.2, 0, 1.2, 0.6684],
      dielectrics: [{ y0: 0, y1: 0.6684, er: 4.17 }],
      conductors: [
        { potential: 1, points: [[-0.223, 0.13], [-0.1, 0.13], [-0.10889000000000001, 0.1452], [-0.21411, 0.1452]] },
        { potential: -1, points: [[0.1, 0.13], [0.223, 0.13], [0.21411, 0.1452], [0.10889000000000001, 0.1452]] },
      ],
    };
    const { bmp, grid, ers } = sectionBitmap(spec, 0.004);
    expect(grid).toEqual([601, 168]);
    expect(ers).toEqual([["204080", 4.17]]);
    expect(sha(bmp)).toBe("e9d48273ed284b04b8f5a6fbfeacf7bcedc20e2b2afd5a63a0ef412d191da0cf");
  });

  test("a masked microstrip pair from pairSection draws the toolkit's bitmap (stack106 keyboard-escape-2um)", () => {
    const spec = pairSection({ width: 0.123, gap: 0.522, thickness: 0.04064, hnear: 0.0994, er: 4.1, mask: true });
    expect(spec.dielectric_polygons?.[0]?.points[2]).toEqual([-0.25465000000000004, 0.15528]);
    expect(sha(sectionBitmap(spec, 0.002).bmp)).toBe("ffaa363cf65626f56c972289bfe6a1588991d9ae3ffa0961003eae1e9d4a0911");
  });

  test("solver arguments print floats as Python does", () => {
    expect([pyFloat(1e-5), pyFloat(4.17), pyFloat(4), pyFloat(0.002)]).toEqual(["1e-05", "4.17", "4.0", "0.002"]);
  });
});
