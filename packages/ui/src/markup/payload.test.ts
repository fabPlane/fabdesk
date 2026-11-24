import { expect, test } from "bun:test";
import { formatMarkupContext, markupAttachment, markupViewCapturable, markupViewKind, markupViewLabel } from "./payload";

test("markup capture is limited to design views with a canvas or image", () => {
  expect(markupViewCapturable("pcb", "boards")).toBe(true);
  expect(markupViewCapturable("schematic", "boards")).toBe(true);
  expect(markupViewCapturable("placement", "boards")).toBe(true);
  expect(markupViewCapturable("cinema", "boards")).toBe(true);
  expect(markupViewCapturable("3d", "boards")).toBe(true);
  expect(markupViewCapturable("layers", "boards")).toBe(true);
  expect(markupViewCapturable("cad", "mechanical")).toBe(true);
  expect(markupViewCapturable("art", "boards")).toBe(true);
  expect(markupViewCapturable("3d", "outputs")).toBe(true);
  expect(markupViewCapturable("notes", "files")).toBe(false);
  expect(markupViewCapturable("files", "files")).toBe(false);
  expect(markupViewCapturable("comments", "review")).toBe(false);
  expect(markupViewCapturable("drc", "review")).toBe(false);
  expect(markupViewCapturable("renders", "outputs")).toBe(false);
  expect(markupViewCapturable("bom", "parts")).toBe(false);
});

test("view kind maps schematic, 3D/CAD and everything else on the board to pcb", () => {
  expect(markupViewKind("schematic", "boards")).toBe("schematic");
  expect(markupViewKind("pcb", "boards")).toBe("pcb");
  expect(markupViewKind("cinema", "boards")).toBe("pcb");
  expect(markupViewKind("placement", "boards")).toBe("pcb");
  expect(markupViewKind("3d", "outputs")).toBe("3d");
  expect(markupViewKind("cad", "mechanical")).toBe("3d");
  expect(markupViewLabel("cinema", "boards")).toBe("Routing");
});

test("markup attachment payload is an image with role markup", () => {
  expect(markupAttachment("sketches/markup-1.png")).toEqual({
    path: "sketches/markup-1.png",
    mime: "image/png",
    role: "markup",
  });
});

test("structured context lists view, viewport, nearby objects, and a missing-image note", () => {
  const text = formatMarkupContext({
    view: "pcb",
    viewLabel: "PCB",
    viewport: { x: 0, y: 0, w: 80, h: 50, units: "mm" },
    marked: { x: 12, y: 8, w: 10, h: 6 },
    objects: { refdes: ["R1", "R1", "U2"], nets: ["VCC"] },
    imageAttached: false,
  });
  expect(text).toContain("[markup]");
  expect(text).toContain("view: pcb");
  expect(text).toContain("surface: PCB");
  expect(text).toContain("viewport: 0, 0, 80 × 50 mm");
  expect(text).toContain("marked: 12, 8, 10 × 6");
  expect(text).toContain("refdes: R1, U2");
  expect(text).toContain("nets: VCC");
  expect(text).toContain("note: marked view image was not attached");
});
