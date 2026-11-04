import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnclosureBoardDimensions } from "./EnclosureBoardDimensions";

const props = {
  paths: ["boards/usb.kicad_pcb"],
  selected: "boards/usb.kicad_pcb",
  disabled: false,
  onSelect: () => {},
  onFocus: () => {},
};
test("selected PCB measures its outline and laminate, not tall components", () => {
  const html = renderToStaticMarkup(
    createElement(EnclosureBoardDimensions, {
      ...props,
      features: {
        pcbRevision: "r",
        thicknessMm: 0.8,
        outline: {
          minX: 100,
          minY: 20,
          maxX: 118.25,
          maxY: 26,
          widthMm: 18.25,
          heightMm: 6,
          closed: false,
        },
        holes: [],
        components: [
          {
            ref: "J1",
            x: 100,
            y: 20,
            heightMm: 15,
            bottom: false,
            bounds: { minX: 95, minY: 15, maxX: 120, maxY: 30 },
          },
        ],
      },
    }),
  );
  expect(html).toContain('value="boards/usb.kicad_pcb" selected');
  expect(html).toContain("18.25");
  expect(html).toContain("0.8");
  expect(html).toContain("components excluded");
  expect(html).toContain("outline needs review");
  expect(html).not.toContain('type="number"');
});
test("unavailable measurements are not displayed as zeros", () => {
  const html = renderToStaticMarkup(
    createElement(EnclosureBoardDimensions, { ...props, features: null }),
  );
  expect(html).toContain("not available yet");
  expect(html).not.toContain("<dd>");
});
