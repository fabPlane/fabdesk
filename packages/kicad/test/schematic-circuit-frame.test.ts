import { expect, test } from "bun:test";
import { frameSchematicCircuit, SchematicPreviewUnavailableError } from "../src/raster";
const page =
  '<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210"><g transform="translate(30 40)"><rect x="10" y="20" width="30" height="40" fill="black"/></g><path d="M 50,60 L 70,80" stroke="red"/></svg>';
test("circuit framing removes paper margins while preserving symbols, wires, transforms and native coordinates", async () => {
  const framed = await frameSchematicCircuit(page);
  const box = /viewBox="([^"]+)"/.exec(framed)![1]!.split(" ").map(Number);
  expect(box[0]).toBeLessThan(40);
  expect(box[1]).toBeLessThan(60);
  expect(box[0]! + box[2]!).toBeGreaterThan(70);
  expect(box[1]! + box[3]!).toBeGreaterThan(100);
  expect(box[2]).toBeLessThan(100);
  expect(box[3]).toBeLessThan(100);
  expect(framed).toContain('data-fabplane-schematic-view="circuit"');
  expect(framed.slice(framed.indexOf("<g"))).toBe(page.slice(page.indexOf("<g")));
  expect(page).toContain('viewBox="0 0 297 210"');
});
test("empty schematics remain navigable and unsupported coordinate scales fail explicitly", async () => {
  expect(await frameSchematicCircuit(page.replace(/<g[\s\S]*<\/svg>/, "</svg>"))).toContain(
    "circuit-empty",
  );
  await expect(
    frameSchematicCircuit(page.replace('width="297mm"', 'width="1123px"')),
  ).rejects.toThrow("millimetre");
});
test("missing or incomplete preview output is distinct from an unsupported coordinate system", async () => {
  for (const missing of ["", " \n", "<svg"]) {
    const error = await frameSchematicCircuit(missing).catch((error) => error);
    expect(error).toBeInstanceOf(SchematicPreviewUnavailableError);
    expect(error.message).not.toContain("framing limit");
  }
  const unsupported = await frameSchematicCircuit(
    page.replace('width="297mm"', 'width="1123px"'),
  ).catch((error) => error);
  expect(unsupported).toBeInstanceOf(Error);
  expect(unsupported).not.toBeInstanceOf(SchematicPreviewUnavailableError);
});
