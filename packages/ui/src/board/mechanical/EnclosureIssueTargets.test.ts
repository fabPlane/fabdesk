import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultEnclosureDesign, enclosureIssueRoute } from "@fabdesk/client-core";
import { EnclosureHardwarePanel } from "./EnclosureHardwarePanel";
import { EnclosureLayoutPanel } from "./EnclosureLayoutPanel";

test("hardware recovery targets exist beside their editable controls", () => {
  const design = defaultEnclosureDesign(null);
  design.boards = [{ path: "usb.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }];
  design.closure = {
    kind: "screws",
    screwDiameter: 3,
    screwLength: 8,
    pilotDiameter: 2.5,
    clearanceDiameter: 3.4,
    bossDiameter: 8,
  };
  const html = renderToStaticMarkup(
    createElement(EnclosureHardwarePanel, { design, onChange: () => {} }),
  );
  for (const code of [
    "hardware-access",
    "assembly-unavailable",
    "assembly-sampled",
    "fit-allowance",
    "holder-space",
    "holder-closure",
    "closure-length",
  ])
    expect(html).toContain(`data-enclosure-control="${enclosureIssueRoute(code)!.target}"`);
  expect(html).toContain('data-enclosure-control="holders" data-board-path="usb.kicad_pcb"');
  expect(html).toContain('aria-label="usb.kicad_pcb board retention"');
  expect(html).toContain("Screw length");
  expect(html).toContain("Check actual 3D models");
});

test("layout recovery targets distinguish cables, ports and print limits", () => {
  const html = renderToStaticMarkup(
    createElement(EnclosureLayoutPanel, {
      design: defaultEnclosureDesign(null),
      boards: [],
      busy: false,
      proposals: null,
      onChange: () => {},
      onFind: () => {},
      onUse: () => {},
      onCancel: () => {},
      showPlugs: false,
      onShowPlugs: () => {},
    }),
  );
  for (const code of ["cable-route-blocked", "port-measurements", "case-size-limit"])
    expect(html).toContain(`data-enclosure-control="${enclosureIssueRoute(code)!.target}"`);
  expect(html).toContain('data-enclosure-control="cables"><summary>Cable connections');
  expect(html).toContain('data-enclosure-control="ports"><summary>Ports &amp; plug access');
});
