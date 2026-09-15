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
      `(footprint "USB_C_16P" (descr "USB-C receptacle")
        (pad "A1" smd rect (at -3.2 -3.68) (size 0.6 1.15) (layers "F.Cu"))
        (pad "S1" thru_hole circle (at 4.32 1.075) (size 1 1.8) (layers "*.Cu")))`,
    );
    await writeFile(
      join(symbols, "Connector.kicad_sym"),
      `(kicad_symbol_lib (version 20231120)
        (symbol "USB_C_Receptacle_USB2.0_16P"
          (property "Description" "USB-C receptacle")
          (symbol "USB_C_Receptacle_USB2.0_16P_1_1"
            (pin passive line (at 0 0 0) (length 2.54) (name "GND") (number "A1"))
            (pin bidirectional line (at 2.54 0 180) (length 2.54) (name "CC1") (number "A5")))))`,
    );

    const catalog = new KicadLibraryCatalog({ footprints, symbols });
    expect(await catalog.search("footprint", "USB C 16P", 10)).toMatchObject([
      { libId: "Connector_USB:USB_C_16P" },
    ]);
    expect(await catalog.search("symbol", "USB_C_Receptacle 16P", 10)).toMatchObject([
      { libId: "Connector:USB_C_Receptacle_USB2.0_16P" },
    ]);
    expect(await catalog.describe("footprint", "Connector_USB:USB_C_16P")).toMatchObject({
      description: "USB-C receptacle",
      pads: [
        { number: "A1", position: { x: -3.2, y: -3.68 }, size: { x: 0.6, y: 1.15 } },
        { number: "S1", position: { x: 4.32, y: 1.075 }, size: { x: 1, y: 1.8 } },
      ],
    });
    expect(await catalog.describe("symbol", "Connector:USB_C_Receptacle_USB2.0_16P")).toMatchObject(
      {
        description: "USB-C receptacle",
        pins: [
          { number: "A1", name: "GND", electricalType: "PT_PASSIVE" },
          { number: "A5", name: "CC1", electricalType: "PT_BIDI" },
        ],
      },
    );
  });
});
