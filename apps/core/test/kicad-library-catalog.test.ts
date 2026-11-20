import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KicadLibraryCatalog } from "../src/kicad-library-catalog";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("bundled KiCad library catalog", () => {
  test("searches without a project and describes symbol pins and footprint pads", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabdesk-library-catalog-"));
    roots.push(root);
    const footprints = join(root, "footprints");
    const symbols = join(root, "symbols");
    await mkdir(join(footprints, "Connector_USB.pretty"), { recursive: true });
    await mkdir(symbols, { recursive: true });
    await writeFile(
      join(footprints, "Connector_USB.pretty", "USB_C_16P.kicad_mod"),
      `(footprint "USB_C_16P" (descr "USB-C receptacle, power-only https://example.com/usb.pdf")
        (tags "USB Type-C charging-only")
        (attr smd)
        (fp_rect (start -4 -2) (end 4 2) (stroke (width 0.1) (type default)) (fill none) (layer "F.Fab"))
        (fp_rect (start -4.2 -2.2) (end 4.2 2.2) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
        (fp_text user "PCB Edge" (at 0 1.5) (layer "Dwgs.User"))
        (pad "A1" smd rect (at -3.2 -3.68) (size 0.6 1.15) (layers "F.Cu"))
        (pad "A5" smd rect (at -1 -3.68) (size 0.6 1.15) (layers "F.Cu"))
        (pad "A9" smd rect (at 1 -3.68) (size 0.6 1.15) (layers "F.Cu"))
        (pad "A12" smd rect (at 3.2 -3.68) (size 0.6 1.15) (layers "F.Cu"))
        (pad "SH" thru_hole circle (at 4.32 1.075) (size 1 1.8) (layers "*.Cu"))
        (model "\${KICAD10_3DMODEL_DIR}/Connector_USB.3dshapes/USB_C.step"))`,
    );
    await writeFile(
      join(symbols, "Connector.kicad_sym"),
      `(kicad_symbol_lib (version 20231120)
        (symbol "USB_C_Receptacle_USB2.0_16P"
          (property "Description" "USB-C power receptacle")
          (property "Datasheet" "https://example.com/symbol.pdf")
          (symbol "USB_C_Receptacle_USB2.0_16P_1_1"
            (pin passive line (at 0 0 0) (length 2.54) (name "GND") (number "A12"))
            (pin power_in line (at 2.54 0 180) (length 2.54) (name "VBUS") (number "A9"))
            (pin bidirectional line (at 5.08 0 180) (length 2.54) (name "CC1") (number "A5")))))`,
    );
    await writeFile(
      join(symbols, "Device.kicad_sym"),
      `(kicad_symbol_lib (version 20231120)
        (symbol "R"
          (property "ki_keywords" "R res resistor")
          (property "ki_description" "Resistor")
          (pin passive line (at 0 0 0) (length 2.54) (name "~") (number "1")))
        (symbol "Heater"
          (property "ki_keywords" "resistor heater")
          (property "ki_description" "Heating element / resistor")))`,
    );

    const catalog = new KicadLibraryCatalog({ footprints, symbols });
    const roleHits = await catalog.search("footprint", "power-only USB C", 10);
    expect(roleHits).toMatchObject([
      { libId: "Connector_USB:USB_C_16P", description: expect.stringContaining("power-only") },
    ]);
    expect(roleHits[0]?.part?.roleSuitability).toEqual([
      expect.objectContaining({ role: "power-only-usb-c", suitable: true }),
    ]);
    expect(await catalog.search("symbol", "USB_C_Receptacle 16P", 10)).toMatchObject([
      { libId: "Connector:USB_C_Receptacle_USB2.0_16P" },
    ]);
    expect((await catalog.search("symbol", "resistor", 10))[0]?.libId).toBe("Device:R");
    expect(await catalog.describe("footprint", "Connector_USB:USB_C_16P")).toMatchObject({
      description: expect.stringContaining("USB-C receptacle"),
      datasheet: "https://example.com/usb.pdf",
      package: {
        assemblyMethod: "smd",
        bodyBounds: { size: { x: 8, y: 4 } },
        courtyardBounds: { size: { x: 8.4, y: 4.4 } },
        connectorEdgeDatum: { axis: "y", coordinate: 1.5, label: "PCB Edge" },
      },
      fabrication: {
        courtyard: "available",
        fabOutline: "available",
        threeDModels: "available",
        includedInBom: true,
        includedInPositionFiles: true,
      },
      roleSuitability: [{ role: "power-only-usb-c", suitable: true }],
      pads: [
        {
          number: "A1",
          type: "smd",
          shape: "rect",
          position: { x: -3.2, y: -3.68 },
          size: { x: 0.6, y: 1.15 },
        },
        { number: "A5" },
        { number: "A9" },
        { number: "A12" },
        {
          number: "SH",
          type: "thru_hole",
          position: { x: 4.32, y: 1.075 },
          size: { x: 1, y: 1.8 },
        },
      ],
    });
    expect(await catalog.describe("symbol", "Connector:USB_C_Receptacle_USB2.0_16P")).toMatchObject(
      {
        description: "USB-C power receptacle",
        datasheet: "https://example.com/symbol.pdf",
        roleSuitability: [{ role: "power-only-usb-c", suitable: true }],
        pins: [
          { number: "A12", name: "GND", electricalType: "PT_PASSIVE" },
          { number: "A9", name: "VBUS", electricalType: "PT_POWER_IN" },
          { number: "A5", name: "CC1", electricalType: "PT_BIDI" },
        ],
      },
    );
  });

  test("picker search matches an MPN like RC0402 onto Device:R and a 0402 footprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "fabdesk-picker-catalog-"));
    roots.push(root);
    const symbols = join(root, "symbols");
    await mkdir(symbols, { recursive: true });
    await writeFile(
      join(symbols, "Device.kicad_sym"),
      `(kicad_symbol_lib (version 20231120)
        (symbol "R"
          (property "Value" "R")
          (property "Footprint" "")
          (property "ki_keywords" "R res resistor")
          (property "ki_description" "Resistor")
          (pin passive line (at 0 0 0) (length 2.54) (name "~") (number "1"))
          (pin passive line (at 2.54 0 180) (length 2.54) (name "~") (number "2")))
        (symbol "C"
          (property "Value" "C")
          (property "ki_keywords" "C cap capacitor")
          (property "ki_description" "Unpolarized capacitor")))`,
    );
    const catalog = new KicadLibraryCatalog({ symbols });
    const hits = await catalog.searchPicker("RC0402", 10);
    expect(hits[0]).toMatchObject({
      libId: "Device:R",
      footprint: "Resistor_SMD:R_0402_1005Metric",
      value: "R",
    });
    expect(hits[0]?.pinNumbers).toEqual(["1", "2"]);
  });
});
