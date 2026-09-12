import { describe, expect, test } from "bun:test";
import {
  boardOutlineBbox,
  containedRect,
  groupBySeverity,
  normalizeReport,
  renderPoint,
  summarize,
} from "./drc";

/** Trimmed from ~/fabdesk/blinky/reports/erc.json (fabdesk's verify_erc wrapper, KiCad 10.0.4). */
const ercFabdesk = {
  violations: [
    {
      rule: "pin_not_connected",
      severity: "error",
      description: "Pin not connected",
      items: [
        {
          description: "Pin 1 [???, ?]",
          uuid: "a61d29d3-4d8f-4dd8-aa86-d588d2537ba5",
          pos: { x: 0.411375, y: 1.0785 },
        },
      ],
      signature: "pin_not_connected:Pin 1 [???, ?]",
    },
    {
      rule: "pin_not_connected",
      severity: "error",
      description: "Pin not connected",
      items: [
        {
          description: "Symbol U1 Pin 3 [OUT, Passive, Line]",
          uuid: "b500fc1e-2362-47b2-9dd6-3139a85575f0",
          pos: { x: 1.450125, y: 1.065 },
        },
      ],
      signature: "pin_not_connected:Symbol U1 Pin 3 [OUT, Passive, Line]",
    },
  ],
  counts: { errors: 6, warnings: 0 },
  raw: {
    $schema: "https://schemas.kicad.org/erc.v1.json",
    coordinate_units: "mm",
    kicad_version: "10.0.4",
    sheets: [
      {
        path: "/",
        violations: [
          {
            type: "pin_not_connected",
            severity: "error",
            description: "Pin not connected",
            items: [{ description: "raw copy — must not be read twice", pos: { x: 1, y: 2 } }],
          },
        ],
      },
    ],
  },
};

/** ~/fabdesk/blinky/reports/drc.json as written by verify_drc for a clean board. */
const drcClean = {
  violations: [],
  unconnected: [],
  schematicParity: [],
  counts: { errors: 0, warnings: 0, unconnected: 0 },
  raw: {
    $schema: "https://schemas.kicad.org/drc.v1.json",
    coordinate_units: "mm",
    kicad_version: "10.0.4",
    source: "board.kicad_pcb",
    schematic_parity: [],
    unconnected_items: [],
    violations: [],
  },
};

/** fabdesk wrapper with findings in every list. */
const drcFabdesk = {
  violations: [
    {
      rule: "clearance",
      severity: "error",
      description: "Clearance violation (netclass 'Default' clearance 0.2000 mm; actual 0.1564 mm)",
      items: [
        { description: "Track [GND] on F.Cu, length 3.2 mm", pos: { x: 100.419, y: 99.722 } },
        { description: "Via [VCC] on F.Cu - B.Cu", pos: { x: 100.772, y: 98.554 } },
      ],
      signature: "clearance:Track [GND] on F.Cu, length 3.2 mm",
    },
    {
      rule: "silk_over_copper",
      severity: "warning",
      description: "Silkscreen clipped by solder mask",
      items: [{ description: "Footprint Text 'C2' on F.Silkscreen", pos: { x: 92.5, y: 95.1 } }],
      signature: "silk_over_copper:Footprint Text 'C2' on F.Silkscreen",
    },
  ],
  unconnected: [
    {
      rule: "unconnected_items",
      severity: "error",
      description: "Missing connection between items",
      items: [{ description: "Pad 1 [Net-(R1-Pad1)] of R1 on F.Cu", pos: { x: 95.5, y: 104 } }],
      signature: "unconnected_items:Pad 1 [Net-(R1-Pad1)] of R1 on F.Cu",
    },
  ],
  schematicParity: [],
  counts: { errors: 1, warnings: 1, unconnected: 1 },
  raw: {},
};

/** KiCad's own `kicad-cli pcb drc --format json` shape, for a board checked outside fabdesk. */
const drcKicad = {
  $schema: "https://schemas.kicad.org/drc.v1.json",
  coordinate_units: "mm",
  violations: [
    {
      type: "courtyards_overlap",
      severity: "warning",
      description: "Courtyards overlap",
      excluded: true,
      items: [{ description: "Footprint C1", pos: { x: 110, y: 104 } }],
    },
  ],
  unconnected_items: [
    {
      severity: "error",
      description: "Missing connection between items",
      items: [{ description: "Pad 2 of U1" }],
    },
  ],
  schematic_parity: [],
};

describe("normalizeReport", () => {
  test("fabdesk's wrapper: rule → type, unconnected list, raw not read twice", () => {
    const rows = normalizeReport(ercFabdesk, "erc");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "erc",
      type: "pin_not_connected",
      severity: "error",
      description: "Pin not connected",
    });
    expect(rows[0]?.items[0]?.pos).toEqual({ x: 0.411375, y: 1.0785 });
    expect(rows.some((r) => r.items[0]?.description.startsWith("raw copy"))).toBe(false);

    const drc = normalizeReport(drcFabdesk, "drc");
    expect(drc.map((v) => `${v.severity}:${v.type}`)).toEqual([
      "error:clearance",
      "warning:silk_over_copper",
      "error:unconnected_items",
    ]);
    expect(drc[0]?.items).toHaveLength(2);
  });

  test("a clean report is an empty list, so is no report", () => {
    expect(normalizeReport(drcClean, "drc")).toEqual([]);
    expect(normalizeReport(null, "drc")).toEqual([]);
    expect(normalizeReport(undefined, "erc")).toEqual([]);
    expect(normalizeReport("nonsense", "drc")).toEqual([]);
  });

  test("KiCad's own shape: type, unconnected_items typed as unconnected, excluded kept, sheets flattened", () => {
    const rows = normalizeReport(drcKicad, "drc");
    expect(rows.map((v) => [v.type, v.severity, v.excluded ?? false])).toEqual([
      ["courtyards_overlap", "warning", true],
      ["unconnected", "error", false],
    ]);
    expect(rows[1]?.items[0]).toEqual({ description: "Pad 2 of U1" });
    const erc = normalizeReport(ercFabdesk.raw, "erc");
    expect(erc).toHaveLength(1);
    expect(erc[0]?.items[0]?.description).toStartWith("raw copy");
  });

  test("a bare array works too", () => {
    expect(normalizeReport([{ type: "x", severity: "warning" }], "drc")).toMatchObject([
      { type: "x", severity: "warning", items: [] },
    ]);
  });
});

describe("grouping and summary", () => {
  const all = [...normalizeReport(drcFabdesk, "drc"), ...normalizeReport(drcKicad, "drc")];

  test("errors, then warnings, then excluded at the end", () => {
    const sections = groupBySeverity(all);
    expect(sections.map((s) => [s.severity, s.violations.length])).toEqual([
      ["error", 3],
      ["warning", 1],
      ["excluded", 1],
    ]);
  });

  test("summary counts exclude the excluded", () => {
    expect(summarize(all)).toEqual({ total: 4, errors: 3, warnings: 1, excluded: 1 });
    expect(summarize([])).toEqual({ total: 0, errors: 0, warnings: 0, excluded: 0 });
  });
});

/** The four Edge.Cuts lines from ~/fabdesk/blinky/board.kicad_pcb, plus a decoy on F.Cu. */
const blinkyOutline = `
  (segment (start 93.325 106.5) (end 95 106.5) (width 0.2) (layer "F.Cu") (net 1))
  (gr_line (start 85 110) (end 115 110) (width 0.1) (layer Edge.Cuts))
  (gr_line (start 115 110) (end 115 90) (width 0.1) (layer Edge.Cuts))
  (gr_line (start 115 90) (end 85 90) (width 0.1) (layer Edge.Cuts))
  (gr_line (start 85 90) (end 85 110) (width 0.1) (layer Edge.Cuts))
  (gr_line (start 0 0) (end 500 500) (width 0.1) (layer "F.SilkS"))
`;

describe("boardOutlineBbox", () => {
  test("only Edge.Cuts graphics count", () => {
    expect(boardOutlineBbox(blinkyOutline)).toEqual({ minX: 85, minY: 90, maxX: 115, maxY: 110 });
  });

  test("KiCad 8 quoted layers, rects, and circles by radius", () => {
    const pcb = `
      (gr_rect (start 10 20) (end 40 50) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
      (gr_circle (center 60 35) (end 65 35) (stroke (width 0.1) (type default)) (layer "Edge.Cuts"))
      (gr_text "Edge.Cuts is just a string here" (at 1000 1000) (layer "F.SilkS"))
    `;
    expect(boardOutlineBbox(pcb)).toEqual({ minX: 10, minY: 20, maxX: 65, maxY: 50 });
  });

  test("no outline → null; a footprint's fp_line on Edge.Cuts counts", () => {
    expect(boardOutlineBbox("(kicad_pcb (version 1))")).toBeNull();
    const pcb = `(footprint "X" (fp_line (start 1 2) (end 3 4) (layer "Edge.Cuts")))`;
    expect(boardOutlineBbox(pcb)).toEqual({ minX: 1, minY: 2, maxX: 3, maxY: 4 });
  });
});

describe("renderPoint", () => {
  const outline = { minX: 85, minY: 90, maxX: 115, maxY: 110 };
  const image = { width: 1600, height: 1200 };

  test("matches where kicad-cli painted the blinky board (measured 206..1361 × 203..973 px)", () => {
    const tl = renderPoint({ x: 85, y: 90 }, outline, image)!;
    const br = renderPoint({ x: 115, y: 110 }, outline, image)!;
    // 0.9625 * 1200 / 30 mm = 38.5 px/mm around the image centre; measured corners are within
    // ~1% of the image size of these.
    expect(tl.fx * 1600).toBeCloseTo(222.5, 0);
    expect(tl.fy * 1200).toBeCloseTo(215, 0);
    expect(br.fx * 1600).toBeCloseTo(1377.5, 0);
    expect(br.fy * 1200).toBeCloseTo(985, 0);
    expect(Math.abs(tl.fx * 1600 - 206)).toBeLessThan(0.015 * 1600);
    expect(Math.abs(br.fy * 1200 - 973)).toBeLessThan(0.015 * 1200);
  });

  test("the board centre is the image centre; the bottom view mirrors x", () => {
    expect(renderPoint({ x: 100, y: 100 }, outline, image)).toEqual({ fx: 0.5, fy: 0.5 });
    const top = renderPoint({ x: 85, y: 100 }, outline, image)!;
    const bottom = renderPoint({ x: 85, y: 100 }, outline, image, "bottom")!;
    expect(bottom.fx).toBeCloseTo(1 - top.fx, 6);
    expect(bottom.fy).toBe(top.fy);
  });

  test("a tall board is framed by its height; off-picture points are null", () => {
    const tall = { minX: 0, minY: 0, maxX: 20, maxY: 40 };
    const top = renderPoint({ x: 10, y: 0 }, tall, { width: 800, height: 600 })!;
    expect(top.fy).toBeCloseTo((1 - 0.9625) / 2, 6);
    expect(renderPoint({ x: 10, y: -30 }, tall, { width: 800, height: 600 })).toBeNull();
    expect(renderPoint({ x: 1, y: 1 }, { minX: 5, minY: 5, maxX: 5, maxY: 5 }, image)).toBeNull();
  });
});

describe("containedRect", () => {
  test("letterboxes a 4:3 image in a wide box and pillarboxes it in a tall one", () => {
    const wide = containedRect({ width: 1600, height: 1200 }, { width: 400, height: 200 });
    expect(wide.x).toBeCloseTo(66.667, 3);
    expect(wide.y).toBe(0);
    expect(wide.width).toBeCloseTo(266.667, 3);
    expect(wide.height).toBe(200);
    expect(containedRect({ width: 1600, height: 1200 }, { width: 300, height: 600 })).toEqual({
      x: 0,
      y: 187.5,
      width: 300,
      height: 225,
    });
  });
});
