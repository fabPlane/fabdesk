import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PcbModelStatus } from "./PcbModelStatus";

test("model review prioritizes unloaded parts and distinguishes pads from hidden models", () => {
  const html = renderToStaticMarkup(
    createElement(PcbModelStatus, {
      loading: false,
      error: "",
      retry: () => {},
      models: {
        "board.kicad_pcb": {
          modelPath: "board.glb",
          pcbRevision: "r1",
          data: new ArrayBuffer(0),
          warnings: [],
          coverage: {
            total: 3,
            loaded: 0,
            missing: ["TP1", "U1", "J1"],
            details: [
              {
                ref: "TP1",
                footprint: "TestPoint:TestPoint_Pad_D1.0mm",
                reason: "unassigned",
                models: [],
              },
              { ref: "U1", footprint: "QFN", reason: "not-loaded", models: ["chip.step"] },
              { ref: "J1", footprint: "USB", reason: "hidden", models: [] },
            ],
          },
        },
      },
    }),
  );
  expect(html).toContain("3 footprints need model review");
  expect(html.indexOf("<strong>U1</strong>")).toBeLessThan(html.indexOf("<strong>TP1</strong>"));
  expect(html).toContain("chip.step");
  expect(html).toContain("Enable the footprint&#x27;s 3D model");
  expect(html).toContain("Check solder height and probe or jumper access");
  expect(html).toContain("(partial)");
});
