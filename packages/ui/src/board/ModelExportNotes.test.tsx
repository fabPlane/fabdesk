import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelExportNotes } from "./ModelExportNotes";
import { inspectModelWarnings } from "./model-warnings";

test("group shared files and count each affected placement once across receipt formats", () => {
  const warnings = ["Could not add 3D model for J1.", "File not found: connector.step",
    "J1, J2: exact stock model unavailable (lib/connector.step); no substitute was used.",
    "J2: model unavailable (custom/shield.step); provide the original model file.",
    "R3: no 3D model is assigned; add the exact part model."];
  const result = inspectModelWarnings(warnings);
  expect(result.label).toBe("3 placements missing 3D models");
  expect([...result.byFile.get("lib/connector.step")!]).toEqual(["J1", "J2"]);
  expect(result.ungrouped).toEqual(["R3"]);
  const html = renderToStaticMarkup(<ModelExportNotes projectId="p" warnings={warnings} />);
  for (const text of ["connector.step", "J1, J2", "Model file unspecified", "Technical details", "Find missing models", "custom/shield.step"]) expect(html).toContain(text);
  expect(html).not.toContain("<details open");
});

test("older and offline receipts retain available evidence without guessing a file for legacy references", () => {
  expect(inspectModelWarnings(["Could not add 3D model for SW1.", "File not found: x.step"]).ungrouped).toEqual(["SW1"]);
  expect(inspectModelWarnings(["Q1: stock model is not available locally (q.step)."]).label).toBe("1 placement missing a 3D model");
  expect(inspectModelWarnings(["Unknown exporter message"]).references).toEqual([]);
});
