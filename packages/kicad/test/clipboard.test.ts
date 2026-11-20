import { describe, expect, test } from "bun:test";
import {
  applyLibraryFields,
  buildSchematicClipboard,
  clipboardLooksPasteable,
  fallbackSymbolSexpr,
  renameSymbolSexpr,
  splitLibId,
} from "../src/clipboard";
import { makePartFromDatasheet } from "../src/datasheet-part";

describe("kicad clipboard", () => {
  test("splits lib ids", () => {
    expect(splitLibId("Device:R")).toEqual({ nickname: "Device", entry: "R" });
    expect(splitLibId("R")).toEqual({ nickname: "fabplane", entry: "R" });
  });

  test("emits a pasteable schematic snippet with Footprint, MPN and Manufacturer", () => {
    const text = buildSchematicClipboard(
      {
        libId: "Device:R",
        reference: "R",
        value: "10k",
        footprint: "Resistor_SMD:R_0402_1005Metric",
        mpn: "RC0402FR-0710KL",
        manufacturer: "Yageo",
        pinNumbers: ["1", "2"],
      },
      "11111111-2222-4333-8444-555555555555",
    );
    expect(clipboardLooksPasteable(text)).toBe(true);
    expect(text).toContain('(lib_id "Device:R")');
    expect(text).toContain('(property "Footprint" "Resistor_SMD:R_0402_1005Metric"');
    expect(text).toContain('(property "MPN" "RC0402FR-0710KL"');
    expect(text).toContain('(property "Manufacturer" "Yageo"');
    expect(text).toContain('(property "Value" "10k"');
    expect(text).toContain("(lib_symbols");
  });

  test("renames a library symbol to match lib_id", () => {
    expect(renameSymbolSexpr('(symbol "R" (property "Value" "x"))', "Device:R")).toContain(
      '(symbol "Device:R"',
    );
  });

  test("rewrites library Footprint on an existing symbol body", () => {
    const body = fallbackSymbolSexpr({
      libId: "fabplane:X",
      reference: "U",
      value: "X",
      footprint: "old",
    });
    const next = applyLibraryFields(body, {
      reference: "U",
      value: "STM32",
      footprint: "Package_QFP:LQFP-48_7x7mm_P0.5mm",
    });
    expect(next).toContain('(property "Footprint" "Package_QFP:LQFP-48_7x7mm_P0.5mm"');
    expect(next).toContain('(property "Value" "STM32"');
  });
});

describe("datasheet part maker", () => {
  test("maps a 0402 resistor MPN onto Device-style fields and a pasteable symbol", () => {
    const part = makePartFromDatasheet({ mpn: "RC0402FR-0710KL" });
    expect(part.mpn).toBe("RC0402FR-0710KL");
    expect(part.manufacturer).toBe("Yageo");
    expect(part.footprint).toBe("Resistor_SMD:R_0402_1005Metric");
    expect(part.reference).toBe("R");
    expect(clipboardLooksPasteable(part.paste)).toBe(true);
    expect(part.paste).toContain('(property "MPN" "RC0402FR-0710KL"');
    expect(part.paste).toContain('(property "Manufacturer" "Yageo"');
  });

  test("uses the datasheet filename when no MPN is given", () => {
    const part = makePartFromDatasheet({
      datasheetUrl: "https://www.ti.com/lit/ds/symlink/tps7a02.pdf",
    });
    expect(part.name).toBe("tps7a02");
    expect(clipboardLooksPasteable(part.paste)).toBe(true);
  });

  test("rejects an empty request", () => {
    expect(() => makePartFromDatasheet({})).toThrow(/mpn or datasheetUrl/);
  });
});
