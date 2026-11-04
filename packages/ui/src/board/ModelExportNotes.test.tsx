import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { missingModelReferences, ModelExportNotes } from "./ModelExportNotes";

test("export notes count missing references rather than duplicate path warnings", () => {
  const warnings = ["Could not add 3D model for SW1.", "File not found: ${KICAD10_3DMODEL_DIR}/switch.step", "Could not add 3D model for J1.", "Could not add 3D model for SW1."];
  expect(missingModelReferences(warnings)).toEqual(["SW1", "J1"]);
  const html = renderToStaticMarkup(<ModelExportNotes projectId="p" warnings={warnings} />);
  expect(html).toContain("2 component models missing");
  expect(html).toContain("SW1, J1");
  expect(html).toContain("Review missing models");
  expect(html).toContain("Components missing 3D models");
  expect(html.match(/3D model not included/g)).toHaveLength(2);
  expect(html).not.toContain("4 notes");
  expect(html).toContain("Technical details");
  expect(html).toContain("Find missing models");
  expect(html).toContain("incomplete preview");
  expect(html).toContain("switch.step");
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
});

test("unknown warnings remain actionable without inventing missing components", () => {
  const html = renderToStaticMarkup(<ModelExportNotes projectId="p" warnings={["Exporter requires review."]} />);
  expect(html).toContain("Model export needs review");
  expect(html).toContain("Exporter requires review.");
  expect(html).not.toContain("component models missing");
});
