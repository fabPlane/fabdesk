import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { prepareComMarkerArtwork } from "./commarker-export";
import { sha256Blob } from "./pcb-preview-revision";

async function fixture(artworkBounds?: { xMm: number; yMm: number; widthMm: number; heightMm: number }) {
  const pcb = new Blob(["selected pcb"]), svg = new Blob(["<svg/>"], { type: "image/svg+xml" });
  const sourceSha256 = await sha256Blob(pcb), svgSha256 = await sha256Blob(svg);
  const board = { sourceId: "io", manifestSha256: "a".repeat(64) };
  const source = { id: "io", name: "Panel", location: "project", directory: "boards/io" };
  const sources = ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: board.manifestSha256,
    editing: "explicit-source-tools", observedAt: "2026-11-24T00:00:00Z", assembly: null,
    sources: [{ source, status: "available", pcbSha256: sourceSha256 }] });
  const relativePath = `exports/commarker/copper-${sourceSha256}.svg`;
  const files = new Map([["boards/io/board.kicad_pcb", pcb], ["boards/io/" + relativePath, svg]]);
  const client = { inspectBoardSources: async () => sources, readFileBlob: async (_projectId: string, path: string) => {
    const file = files.get(path);
    if (!file) throw new Error("Read outside board directory: " + path);
    return file;
  } };
  const json = { relativePath, sourceSha256, svgSha256, widthMm: 20, heightMm: 12, ...(artworkBounds ? { artworkBounds } : {}) };
  const run = async (name: string, args: Record<string, unknown>) => {
    expect(name).toBe("export_commarker_copper"); expect(args).toEqual({ projectId: "p", board, expectedSourceSha256: sourceSha256 });
    return { status: "done" as const, result: { json } };
  };
  return { json, files, svg, sources, options: { projectId: "p", prefix: "boards/io/", board, run, client } };
}
test("copper handoff uses the selected member and exactly the verified SVG bytes", async () => {
  const f = await fixture(), output = await prepareComMarkerArtwork(f.options);
  expect(output.svg).toBe(f.svg);
  expect(output.filename).toBe("copper-" + f.json.sourceSha256 + ".svg");
  expect(output.widthMm).toBe(20);
  expect(output.artworkBounds).toBeUndefined(); // Compatible with older core receipts.
});
test("scoped receipts retain the artwork bounds and reject invalid registration", async () => {
  const bounds = { xMm: 4, yMm: 3, widthMm: 12, heightMm: 5 };
  const f = await fixture(bounds);
  const result = await prepareComMarkerArtwork(f.options);
  expect(result.artworkBounds).toEqual(bounds);
  expect(result.svg).toBe(f.svg);
  const outside = await fixture({ ...bounds, yMm: 8 });
  await expect(prepareComMarkerArtwork(outside.options)).rejects.toThrow("bounds exceed");
  const invalid = await fixture({ ...bounds, xMm: -1 });
  await expect(prepareComMarkerArtwork(invalid.options)).rejects.toThrow("incomplete file receipt");
});
test("copper handoff rejects changed artwork, source or directory before launching", async () => {
  const f = await fixture();
  f.files.set("boards/io/" + f.json.relativePath, new Blob(["modified"]));
  await expect(prepareComMarkerArtwork(f.options)).rejects.toThrow("artwork changed");
  f.files.set("boards/io/" + f.json.relativePath, f.svg);
  f.sources.manifestSha256 = "c".repeat(64);
  await expect(prepareComMarkerArtwork(f.options)).rejects.toThrow("source changed");
  f.json.relativePath = "../foreign.svg";
  await expect(prepareComMarkerArtwork(f.options)).rejects.toThrow("different board revision");
});
