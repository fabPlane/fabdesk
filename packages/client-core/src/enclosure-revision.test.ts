import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CoreHttpError } from "./CoreClient";
import { inspectEnclosureSourceRevision } from "./enclosure-revision";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const spec = { contract: { name: "fabdesk.enclosure", version: "2.0.0" }, pcbRevision: hash("board") };
test("generated case records distinguish unchanged and changed PCB bytes", async () => {
  let board = "board";
  const client = { readFile: async () => JSON.stringify(spec), readFileBlob: async () => new Blob([board]) };
  expect(await inspectEnclosureSourceRevision(client, "p")).toBe("unchanged");
  board += "\n";
  expect(await inspectEnclosureSourceRevision(client, "p")).toBe("changed");
});
test("invalid provenance and missing PCB cannot imply a fresh or compatible case", async () => {
  const missing = async () => { throw new CoreHttpError(404, "board.kicad_pcb", "Not found"); };
  expect(await inspectEnclosureSourceRevision({ readFile: async () => "{}", readFileBlob: missing }, "p")).toBe("untracked");
  expect(await inspectEnclosureSourceRevision({ readFile: async () => JSON.stringify(spec), readFileBlob: missing }, "p")).toBe("missing-pcb");
  await expect(inspectEnclosureSourceRevision({ readFile: async () => { throw new Error("offline"); }, readFileBlob: missing }, "p")).rejects.toThrow("offline");
});
