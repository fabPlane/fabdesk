import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { addLibraryFile } from "./store";
import { citeLibrary, searchLibrary } from "./search";
import { libraryTestProject } from "./test-project";

function pdf(text: string): Uint8Array {
  const payload = deflateSync(Buffer.from(`BT /F1 12 Tf 10 100 Td (${text}) Tj ET`, "latin1"));
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Filter /FlateDecode /Length ${payload.byteLength} >> stream`,
    Buffer.from(payload).toString("latin1"),
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return Buffer.from(body, "latin1");
}

test("search matches PDF page text and returns the page number", async () => {
  const project = await libraryTestProject("library-search");
  const entry = await addLibraryFile(project, {
    filename: "stm32.pdf",
    data: pdf("STM32F103 Absolute maximum ratings"),
    linkedRefs: ["U1"],
  });
  const hits = await searchLibrary(project, "absolute maximum");
  expect(hits).toHaveLength(1);
  expect(hits[0]?.id).toBe(entry.id);
  expect(hits[0]?.page).toBe(1);
  expect(hits[0]?.snippet.toLowerCase()).toContain("absolute");
  expect(hits[0]?.linkedRefs).toEqual(["U1"]);

  const cite = await citeLibrary(project, entry.id, 1);
  expect(cite?.text).toContain("STM32F103");
  expect(cite?.page).toBe(1);
});

test("a filename match is one page-null hit, not one hit per PDF page", async () => {
  const project = await libraryTestProject("library-search-meta-pages");
  const payload1 = deflateSync(Buffer.from("BT /F1 12 Tf 10 100 Td (supply voltage) Tj ET", "latin1"));
  const payload2 = deflateSync(Buffer.from("BT /F1 12 Tf 10 80 Td (thermal ratings) Tj ET", "latin1"));
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Filter /FlateDecode /Length ${payload1.byteLength} >> stream`,
    Buffer.from(payload1).toString("latin1"),
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `7 0 obj << /Filter /FlateDecode /Length ${payload2.byteLength} >> stream`,
    Buffer.from(payload2).toString("latin1"),
    "endstream endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  await addLibraryFile(project, {
    filename: "usb-hub-datasheet.pdf",
    data: Buffer.from(body, "latin1"),
  });
  const byName = await searchLibrary(project, "usb-hub-datasheet");
  expect(byName).toHaveLength(1);
  expect(byName[0]?.page).toBeNull();
  const byBody = await searchLibrary(project, "thermal ratings");
  expect(byBody).toHaveLength(1);
  expect(byBody[0]?.page).toBe(2);
});

test("search also matches file names and tags", async () => {
  const project = await libraryTestProject("library-search-meta");
  await addLibraryFile(project, {
    filename: "usb-hub-notes.md",
    data: Buffer.from("# Hub\nUse a 5 V rail with ferrite.\n"),
    tags: ["power"],
  });
  const byName = await searchLibrary(project, "usb-hub");
  expect(byName[0]?.path).toBe("files/research/usb-hub-notes.md");
  const byBody = await searchLibrary(project, "ferrite");
  expect(byBody[0]?.snippet).toContain("ferrite");
});
