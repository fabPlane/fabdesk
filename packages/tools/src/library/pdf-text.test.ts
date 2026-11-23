import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { extractPdfPageText } from "./pdf-text";

function pdfWith(content: string, flate = false): Uint8Array {
  const payload = flate ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const filter = flate ? "/Filter /FlateDecode " : "";
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << ${filter}/Length ${payload.byteLength} >> stream`,
    Buffer.from(payload).toString("latin1"),
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    "7 0 obj << /Length 48 >> stream",
    "BT /F1 12 Tf 10 80 Td (Absolute maximum ratings) Tj ET",
    "endstream endobj",
    "xref",
    "0 8",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return Buffer.from(body, "latin1");
}

test("extracts page text including FlateDecode streams", () => {
  const pages = extractPdfPageText(pdfWith("BT /F1 12 Tf 10 100 Td (STM32F103 datasheet) Tj ET", true));
  expect(pages).toHaveLength(2);
  expect(pages[0]?.page).toBe(1);
  expect(pages[0]?.text).toContain("STM32F103 datasheet");
  expect(pages[1]?.text).toContain("Absolute maximum ratings");
});

test("numbers pages from the catalog /Kids tree, not object-file order", () => {
  const first = "BT /F1 12 Tf 10 100 Td (first page text) Tj ET";
  const second = "BT /F1 12 Tf 10 80 Td (second page text) Tj ET";
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj",
    "6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `7 0 obj << /Length ${second.length} >> stream`,
    second,
    "endstream endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${first.length} >> stream`,
    first,
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  const pages = extractPdfPageText(Buffer.from(body, "latin1"));
  expect(pages).toHaveLength(2);
  expect(pages[0]).toEqual({ page: 1, text: "first page text" });
  expect(pages[1]).toEqual({ page: 2, text: "second page text" });
});

test("rejects non-PDF bytes", () => {
  expect(extractPdfPageText(Buffer.from("not a pdf"))).toEqual([]);
});
