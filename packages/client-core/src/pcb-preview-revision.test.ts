import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CoreHttpError } from "./CoreClient";
import { inspectPcbPreviewRevision } from "./pcb-preview-revision";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const files = new Map<string, string>([["board.kicad_pcb", "board-a"], ["renders/pcb.svg", "preview-a"]]);
  const receipt = { contract: "fabplane.pcb-preview-revision.v1", source: "board.kicad_pcb", artifact: "renders/pcb.svg", sourceSha256: hash("board-a"), artifactSha256: hash("preview-a"), generatedAt: "2026-10-27T12:00:00.000Z" };
  const writeReceipt = (value: unknown = receipt) => files.set("renders/pcb.svg.revision.json", JSON.stringify(value));
  const read = async (_id: string, path: string) => { const text = files.get(path); if (text === undefined) throw new CoreHttpError(404, path, "Not found"); return text; };
  const client = { readFile: read, readFileBlob: async (id: string, path: string) => new Blob([await read(id, path)]) };
  return { files, receipt, writeReceipt, inspect: () => inspectPcbPreviewRevision(client, "study") };
}
test("legacy, malformed and noncanonical receipts never certify a preview", async () => {
  const f = fixture();
  expect(await f.inspect()).toBe("untracked");
  f.files.set("renders/pcb.svg.revision.json", "{");
  expect(await f.inspect()).toBe("untracked");
  f.writeReceipt({ ...f.receipt, source: "../outside.kicad_pcb" });
  expect(await f.inspect()).toBe("untracked");
});
test("byte identity detects source changes and restores status when identical bytes return", async () => {
  const f = fixture(); f.writeReceipt();
  expect(await f.inspect()).toBe("matches-source");
  f.files.set("board.kicad_pcb", "board-b");
  expect(await f.inspect()).toBe("source-changed");
  f.files.set("board.kicad_pcb", "board-a");
  expect(await f.inspect()).toBe("matches-source");
});
test("replaced outputs cannot inherit an old receipt even when source still matches", async () => {
  const f = fixture(); f.writeReceipt(); f.files.set("renders/pcb.svg", "unrelated-preview");
  expect(await f.inspect()).toBe("artifact-changed");
});
test("missing source and artifact are distinct from a matching receipt", async () => {
  const f = fixture(); f.writeReceipt(); f.files.delete("board.kicad_pcb");
  expect(await f.inspect()).toBe("missing-source");
  f.files.set("board.kicad_pcb", "board-a"); f.files.delete("renders/pcb.svg");
  expect(await f.inspect()).toBe("missing-artifact");
});
test("transport failures remain errors rather than being reported as unverified or current", async () => {
  await expect(inspectPcbPreviewRevision({ readFile: async () => { throw new Error("offline"); }, readFileBlob: async () => new Blob() }, "study")).rejects.toThrow("offline");
});

test("member preview checks stay inside the captured source directory", async () => {
  const f = fixture(); f.writeReceipt();
  const files = new Map([...f.files.entries()].map(([path, value]) => [`boards/io/${path}`, value]));
  const reads: string[] = [];
  const read = async (_id: string, path: string) => { reads.push(path); const value = files.get(path); if (value === undefined) throw new CoreHttpError(404, path, "not found"); return value; };
  const client = { readFile: read, readFileBlob: async (id: string, path: string) => new Blob([await read(id, path)]) };
  expect(await inspectPcbPreviewRevision(client, "project", "boards/io")).toBe("matches-source");
  expect(reads.every(path => path.startsWith("boards/io/"))).toBe(true);
  files.set("boards/io/board.kicad_pcb", "changed source");
  expect(await inspectPcbPreviewRevision(client, "project", "boards/io")).toBe("source-changed");
  reads.length = 0;
  await expect(inspectPcbPreviewRevision(client, "project", "../outside")).rejects.toThrow();
  expect(reads).toEqual([]);
});
