import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { addLibraryFile } from "../src/library";
import { libraryTestProject, libraryToolContext } from "../src/library/test-project";
import {
  project_files_cite,
  project_files_link,
  project_files_list,
  project_files_search,
} from "../src/tools/library";

function pdf(text: string): Uint8Array {
  const payload = deflateSync(Buffer.from(`BT /F1 12 Tf 10 100 Td (${text}) Tj ET`, "latin1"));
  return Buffer.from(
    [
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
    ].join("\n"),
    "latin1",
  );
}

describe("project files library tools", () => {
  test("lists, searches PDF text, cites a page, and links a datasheet to a part", async () => {
    const project = await libraryTestProject("library-tools");
    const entry = await addLibraryFile(project, {
      filename: "mcu.pdf",
      data: pdf("STM32F103 Absolute maximum ratings"),
    });
    const ctx = libraryToolContext(project);

    const listed = await project_files_list.handler({}, ctx);
    expect((listed.json as { entries: Array<{ id: string }> }).entries[0]?.id).toBe(entry.id);

    const search = await project_files_search.handler({ q: "absolute maximum", limit: 12 }, ctx);
    const hits = (search.json as { hits: Array<{ page: number | null; path: string }> }).hits;
    expect(hits[0]?.page).toBe(1);
    expect(search.text).toContain("p.1");

    const cited = await project_files_cite.handler({ id: entry.id, page: 1 }, ctx);
    expect(cited.text).toContain("STM32F103");
    expect((cited.json as { path: string }).path).toContain("files/");

    const linked = await project_files_link.handler(
      { id: entry.id, refs: ["U1"], mpns: ["STM32F103C8T6"] },
      ctx,
    );
    expect(linked.text).toContain("U1");
    expect((linked.json as { entry: { linkedRefs: string[] } }).entry.linkedRefs).toEqual(["U1"]);
  });
});
