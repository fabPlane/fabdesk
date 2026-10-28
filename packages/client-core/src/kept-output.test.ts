import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CoreHttpError } from "./CoreClient";
import { captureKeptOutput, inspectKeptOutputIdentity, keptOutputKey, keptOutputMatches, type KeptOutputKind } from "./kept-output";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(kind: KeptOutputKind = "pcb-preview") {
  const artifact = kind === "pcb-preview" ? "renders/pcb.svg" : "renders/board.glb", receiptPath = `${artifact}.revision.json`;
  const receipt = { contract: kind === "pcb-preview" ? "fabplane.pcb-preview-revision.v1" : "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact, sourceSha256: hash("old PCB"), artifactSha256: hash("saved output"), generatedAt: "2026-10-28T00:00:00Z", ...(kind === "board-model" ? { dependencies: "unverified" } : {}) };
  const files = new Map([["board.kicad_pcb", "new PCB"], [artifact, "saved output"], [receiptPath, JSON.stringify(receipt)]]);
  const read = async (_id: string, path: string) => { const value = files.get(path); if (value === undefined) throw new CoreHttpError(404, path, "Missing file"); return value; };
  const single = { projectId: "p", mode: "single" as const, assembly: null, manifestSha256: null, sources: [], observedAt: "2026-10-28T00:00:00Z", editing: "single-board-only" as const };
  const client = { readFile: read, readFileBlob: async (id: string, path: string) => new Blob([await read(id, path)]), inspectBoardSources: async () => single };
  return { client, files, receipt, receiptPath, artifact, single };
}
test.each(["pcb-preview", "board-model"] as const)("keeping %s binds current PCB, unchanged recorded bytes and exact receipt", async kind => {
  const f = fixture(kind), before = [...f.files];
  const choice = await captureKeptOutput(f.client, "p", kind);
  expect(choice.sourceSha256).toBe(hash("new PCB"));
  expect(choice.artifactSha256).toBe(hash("saved output"));
  expect(choice.receiptSha256).toBe(hash(JSON.stringify(f.receipt)));
  expect(keptOutputMatches(choice, await inspectKeptOutputIdentity(f.client, "p", kind))).toBe(true);
  expect([...f.files]).toEqual(before);
});
test("a replaced output, untracked receipt, member receipt or current source cannot be kept as a verified saved root output", async () => {
  const f = fixture(); f.files.set(f.artifact, "changed output");
  await expect(captureKeptOutput(f.client, "p", "pcb-preview")).rejects.toThrow("saved output changed");
  f.files.set(f.artifact, "saved output"); f.files.set(f.receiptPath, "{broken");
  await expect(captureKeptOutput(f.client, "p", "pcb-preview")).rejects.toThrow("valid source record");
  f.files.set(f.receiptPath, JSON.stringify({ ...f.receipt, boardSource: { sourceId: "io" } }));
  await expect(captureKeptOutput(f.client, "p", "pcb-preview")).rejects.toThrow("project-root");
  f.files.set(f.receiptPath, JSON.stringify(f.receipt)); f.files.set("board.kicad_pcb", "old PCB");
  await expect(captureKeptOutput(f.client, "p", "pcb-preview")).rejects.toThrow("already matches");
});
test("a PCB or assembly declaration change during the choice rejects the capture", async () => {
  const f = fixture(); let reads = 0;
  const sourceRace = { ...f.client, readFileBlob: async (id: string, path: string) => { if (path === "board.kicad_pcb" && ++reads === 2) f.files.set(path, "newer PCB"); return f.client.readFileBlob(id, path); } };
  await expect(captureKeptOutput(sourceRace, "p", "pcb-preview")).rejects.toThrow("changed while");
  let scopes = 0;
  const scopeRace = { ...f.client, inspectBoardSources: async () => ++scopes === 1 ? f.single : { ...f.single, mode: "assembly" as const } };
  await expect(captureKeptOutput(scopeRace, "p", "pcb-preview")).rejects.toThrow("single-board");
});
test("decisions stop matching any changed identity and cannot cross endpoint/project/output keys", () => {
  const identity = { sourceSha256: "a", artifactSha256: "b", receiptSha256: "c" };
  for (const field of ["sourceSha256", "artifactSha256", "receiptSha256"] as const) expect(keptOutputMatches(identity, { ...identity, [field]: "different" })).toBe(false);
  const key = keptOutputKey("http://localhost:1/", "p", "pcb-preview");
  expect(key).toBe(keptOutputKey("http://localhost:1", "p", "pcb-preview"));
  expect(key).not.toBe(keptOutputKey("http://localhost:2", "p", "pcb-preview"));
  expect(key).not.toBe(keptOutputKey("http://localhost:1", "other", "pcb-preview"));
  expect(key).not.toBe(keptOutputKey("http://localhost:1", "p", "board-model"));
});

test("an output changed during the final source recheck cannot be recorded as kept", async () => {
  const f = fixture(); let reads = 0;
  const artifactRace = { ...f.client, readFileBlob: async (id: string, path: string) => {
    if (path === "board.kicad_pcb" && ++reads === 2) f.files.set(f.artifact, "changed during recheck");
    return f.client.readFileBlob(id, path);
  } };
  await expect(captureKeptOutput(artifactRace, "p", "pcb-preview")).rejects.toThrow("output changed while");
});
