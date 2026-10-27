import { expect, test } from "bun:test";
import { inspectPcbCheckRevision } from "./check-revision";
import { sha256Blob } from "./pcb-preview-revision";
import { CoreHttpError } from "./CoreClient";
const missing = () => new CoreHttpError(404, "/files", "not found");
test("DRC source identity follows PCB bytes and recognizes an exact return to the checked source", async () => {
  const original = new Blob(["original PCB"]), receipt = JSON.stringify({ pcbRevision: { sha256: await sha256Blob(original), bytes: original.size } });
  let current = original;
  const client = { readFile: async () => receipt, readFileBlob: async () => current };
  expect(await inspectPcbCheckRevision(client, "p")).toBe("source-unchanged");
  current = new Blob(["external PCB"]);
  expect(await inspectPcbCheckRevision(client, "p")).toBe("source-changed");
  current = original;
  expect(await inspectPcbCheckRevision(client, "p")).toBe("source-unchanged");
});
test("legacy or missing reports, missing source and transport failures never imply current checks", async () => {
  const board = new Blob(["PCB"]), valid = JSON.stringify({ pcbRevision: { sha256: await sha256Blob(board), bytes: board.size } });
  for (const raw of ["{}", "not json", JSON.stringify({ pcbRevision: { sha256: "old", bytes: 4 } })]) expect(await inspectPcbCheckRevision({ readFile: async () => raw, readFileBlob: async () => board }, "p")).toBe("untracked");
  expect(await inspectPcbCheckRevision({ readFile: async () => { throw missing(); }, readFileBlob: async () => board }, "p")).toBe("missing-report");
  expect(await inspectPcbCheckRevision({ readFile: async () => valid, readFileBlob: async () => { throw missing(); } }, "p")).toBe("missing-source");
  await expect(inspectPcbCheckRevision({ readFile: async () => valid, readFileBlob: async () => { throw Error("offline"); } }, "p")).rejects.toThrow("offline");
});
