import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { enclosureSourceBoards } from "@fabdesk/client-core";
import { OverviewBoardFiles } from "./OverviewBoardFiles";

test("nested board collection excludes exported copies and preserves distinct paths", () => {
  const paths = enclosureSourceBoards([
    "hardware/usb/board.kicad_pcb", "hardware/power/board.kicad_pcb",
    "exports/case/boards/hardware/usb/board.kicad_pcb",
    "vendor/example/board.kicad_pcb", "hardware/usb/board.kicad_pcb",
  ], []);
  const html = renderToStaticMarkup(createElement(OverviewBoardFiles, {
    paths, onOpen: () => {}, onEnclosure: () => {},
  }));
  expect(paths).toHaveLength(2);
  expect(html).toContain("Open board file: hardware/usb/board.kicad_pcb");
  expect(html).toContain("Open board file: hardware/power/board.kicad_pcb");
  expect(html).toContain("Open enclosure");
  expect(html).not.toContain("exports/case");
  expect(html).not.toContain("Start with an idea");
});
