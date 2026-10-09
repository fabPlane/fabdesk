import { describe, expect, test } from "bun:test";
import {
  OffboardKind,
  ProjectPartsFile,
  emptyProjectParts,
  findOffboardCatalogPart,
  nextOffboardRef,
  projectBomCsv,
  projectBomLines,
  searchOffboardCatalog,
} from "../src/parts";
import type { NetlistComponent } from "../src/fp-pcb";

const comp = (ref: string, value: string, footprint: string, fields?: Record<string, string>): NetlistComponent => ({
  ref,
  value,
  footprint,
  ...(fields ? { fields } : {}),
});

describe("off-board catalog", () => {
  test("covers the Flux launch categories: motors, displays, standoffs, screws", () => {
    const kinds = new Set(searchOffboardCatalog("").map((p) => p.kind));
    expect(kinds.has("motor")).toBe(true);
    expect(kinds.has("display")).toBe(true);
    expect(kinds.has("standoff")).toBe(true);
    expect(kinds.has("fastener")).toBe(true);
    expect(findOffboardCatalogPart("nema-17-stepper")?.name).toContain("NEMA 17");
    expect(findOffboardCatalogPart("ssd1306-oled-128x64")?.kind).toBe("display");
  });

  test("search matches aliases, kind filter, and empty query", () => {
    expect(searchOffboardCatalog("oled").map((p) => p.id)).toContain("ssd1306-oled-128x64");
    expect(searchOffboardCatalog("nema", { kind: "motor" }).every((p) => p.kind === "motor")).toBe(true);
    expect(searchOffboardCatalog("nema", { kind: "display" })).toEqual([]);
    expect(searchOffboardCatalog("", { kind: "fastener" }).length).toBeGreaterThan(0);
    expect(searchOffboardCatalog("stepper", { limit: 1 })).toHaveLength(1);
  });

  test("nextOffboardRef skips used designators", () => {
    expect(nextOffboardRef("motor", [])).toBe("M1");
    expect(nextOffboardRef("motor", ["M1", "M3"])).toBe("M2");
    expect(nextOffboardRef("display", ["DS1"])).toBe("DS2");
    expect(nextOffboardRef("fastener", [])).toBe("H1");
  });
});

describe("project.parts.json schema", () => {
  test("accepts a robotics line and rejects a bad kind", () => {
    const file = ProjectPartsFile.parse({
      schema: 1,
      parts: [
        {
          id: "line_1",
          catalogId: "nema-17-stepper",
          ref: "M1",
          name: "NEMA 17 stepper motor",
          kind: "motor",
          qty: 2,
          mpn: "17HS4401",
        },
      ],
    });
    expect(file.parts[0]?.qty).toBe(2);
    expect(OffboardKind.safeParse("widget").success).toBe(false);
    expect(ProjectPartsFile.safeParse({ schema: 1, parts: [{ id: "x" }] }).success).toBe(false);
    expect(emptyProjectParts()).toEqual({ schema: 1, parts: [] });
  });
});

describe("project BOM", () => {
  test("lists STM32-style PCB parts next to a motor and OLED", () => {
    const lines = projectBomLines(
      [
        comp("U1", "STM32F103C8T6", "Package_QFP:LQFP-48_7x7mm_P0.5mm", { MPN: "STM32F103C8T6" }),
        comp("C1", "100nF", "Capacitor_SMD:C_0402_1005Metric"),
        comp("C2", "100nF", "Capacitor_SMD:C_0402_1005Metric"),
        comp("#PWR01", "GND", ""),
        comp("R9", "10k", "Resistor_SMD:R_0402_1005Metric", { DNP: "yes" }),
      ],
      [
        {
          id: "line_m",
          catalogId: "nema-17-stepper",
          ref: "M1",
          name: "NEMA 17 stepper motor",
          kind: "motor",
          qty: 1,
          mpn: "17HS4401",
        },
        {
          id: "line_ds",
          catalogId: "ssd1306-oled-128x64",
          ref: "DS1",
          name: "0.96 in OLED display (SSD1306)",
          kind: "display",
          qty: 1,
        },
      ],
    );
    expect(lines.map((l) => [l.source, l.refs.join(" "), l.qty, l.kind])).toEqual([
      ["pcb", "C1 C2", 2, "pcb"],
      ["pcb", "U1", 1, "pcb"],
      ["offboard", "DS1", 1, "display"],
      ["offboard", "M1", 1, "motor"],
    ]);
    expect(lines.find((l) => l.refs[0] === "U1")?.mpn).toBe("STM32F103C8T6");
    expect(lines.find((l) => l.lineId === "line_m")?.catalogId).toBe("nema-17-stepper");
  });

  test("CSV has Kind and Source so off-board rows stay distinct", () => {
    const csv = projectBomCsv(
      projectBomLines(
        [comp("R1", "1k", "Resistor_SMD:R_0402_1005Metric")],
        [{ id: "line_h", ref: "H1", name: "M3 Phillips screw 8 mm", kind: "fastener", qty: 8 }],
      ),
    );
    expect(csv).toContain("Kind,Source,Reference,Value,Quantity");
    expect(csv).toContain("pcb,pcb,R1,1k,1");
    expect(csv).toContain("fastener,offboard,H1,M3 Phillips screw 8 mm,8");
  });

  test("empty inputs yield an empty BOM", () => {
    expect(projectBomLines(null, null)).toEqual([]);
    expect(projectBomCsv([])).toBe("Kind,Source,Reference,Value,Quantity,Footprint,MPN,Manufacturer,Notes\n");
  });
});
