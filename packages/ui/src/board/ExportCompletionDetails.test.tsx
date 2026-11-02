import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportCompletionDetails } from "./ExportCompletionDetails";

test("stencil completion preserves exporter review notes beside the saved-file result", () => {
  const html = renderToStaticMarkup(<ExportCompletionDetails kind="export_laser_stencil" result={{ json: { apertureCount: 214, warnings: [{ code: "no_tooling_holes", message: "Registration holes were placed in frame corners." }] } }} />);
  expect(html).toContain("214 paste openings exported");
  expect(html).toContain("Export notes · 1");
  expect(html).toContain("Registration holes were placed in frame corners.");
});

test("unknown result fields cannot invent export counts or hide valid messages", () => {
  const html = renderToStaticMarkup(<ExportCompletionDetails kind="export_stencil" result={{ json: { apertureCount: "214", warnings: [null, {}, { message: 42 }, { message: "" }, { message: "Review the small openings." }] } }} />);
  expect(html).not.toContain("paste openings exported");
  expect(html).toContain("Export notes · 1");
  expect(html).toContain("Review the small openings.");
});

test("saved ZIP completion continues to report omitted files", () => {
  const html = renderToStaticMarkup(<ExportCompletionDetails kind="export_zip" result={{ json: { files: ["board.drl", "board.gtl"], missing: ["positions.csv"] } }} />);
  expect(html).toContain("2 saved files packaged");
  expect(html).toContain("Not included: positions.csv");
});
