import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CoreHttpError } from "./CoreClient";
import { inspectOutputRevision, outputRevisionLabel } from "./output-revision";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(member = false) {
  const prefix = member ? "boards/io/" : "", board = { sourceId: "io", manifestSha256: "a".repeat(64) };
  const files = new Map([[prefix + "board.kicad_pcb", "pcb"], [prefix + "renders/top.png", "image"]]);
  const reads: string[] = [];
  const read = async (_project: string, path: string) => { reads.push(path); const value = files.get(path); if (value === undefined) throw new CoreHttpError(404, path, "missing"); return value; };
  const client = { readFile: read, readFileBlob: async (id: string, path: string) => new Blob([await read(id, path)]) };
  const receipt = { contract: "fabplane.output-revision.v1", projectId: "p", ...(member ? { board } : {}), artifact: "renders/top.png", artifactSha256: hash("image"), basis: "pcb", inputs: [{ path: "board.kicad_pcb", sha256: hash("pcb") }], generatedAt: "2026-10-30T12:00:00.000Z", dependencies: "unverified" };
  const target = { path: prefix + "renders/top.png", directory: member ? "boards/io" : ".", ...(member ? { board } : {}) };
  const write = (value: unknown = receipt) => files.set(target.path + ".revision.json", JSON.stringify(value));
  return { prefix, files, reads, client, receipt, target, write, inspect: () => inspectOutputRevision(client, "p", target) };
}
test("legacy and unsafe receipts cannot certify output bytes", async () => {
  const f = fixture(); expect((await f.inspect()).state).toBe("untracked");
  for (const path of ["../outside", "/absolute", "boards\\outside", "renders/../outside"]) {
    f.write({ ...f.receipt, inputs: [{ path, sha256: hash("pcb") }] });
    expect((await f.inspect()).state).toBe("untracked");
    expect(f.reads).not.toContain(path);
  }
});
test("exact artifact and PCB bytes qualify freshness, with source change and restoration", async () => {
  const f = fixture(); f.write(); expect(await f.inspect()).toEqual({ state: "inputs-unchanged", basis: "pcb" });
  f.files.set("board.kicad_pcb", "edited"); expect((await f.inspect()).state).toBe("input-changed");
  f.files.set("board.kicad_pcb", "pcb"); expect((await f.inspect()).state).toBe("inputs-unchanged");
  f.files.set("renders/top.png", "replaced"); expect((await f.inspect()).state).toBe("artifact-changed");
  f.files.delete("renders/top.png"); expect((await f.inspect()).state).toBe("missing-artifact");
});
test("member scope is captured by project, source and declaration before reading native inputs", async () => {
  const f = fixture(true); f.write(); expect((await f.inspect()).state).toBe("inputs-unchanged");
  expect(f.reads).toContain("boards/io/board.kicad_pcb"); expect(f.reads).not.toContain("board.kicad_pcb");
  for (const bad of [{ ...f.receipt, projectId: "other" }, { ...f.receipt, board: { ...f.receipt.board, sourceId: "lcd" } }, { ...f.receipt, board: { ...f.receipt.board, manifestSha256: "b".repeat(64) } }, { ...f.receipt, artifact: "renders/bottom.png" }]) {
    f.write(bad); f.reads.length = 0; expect((await f.inspect()).state).toBe("scope-unverified"); expect(f.reads).toHaveLength(1);
  }
});
test("packaging receipts establish saved-file identity without claiming current PCB input", async () => {
  const f = fixture(); f.files.set("exports/fabrication.zip", "zip"); f.files.set("exports/positions.csv", "placements");
  f.files.set("exports/fabrication.zip.revision.json", JSON.stringify({ ...f.receipt, artifact: "exports/fabrication.zip", artifactSha256: hash("zip"), basis: "saved-files", inputs: [{ path: "exports/positions.csv", sha256: hash("placements") }] }));
  const inspect = () => inspectOutputRevision(f.client, "p", { path: "exports/fabrication.zip", directory: "." });
  f.files.set("board.kicad_pcb", "new PCB"); expect(outputRevisionLabel(await inspect())).toBe("Packaged files unchanged · PCB not compared");
  f.files.set("exports/positions.csv", "new placements"); expect((await inspect()).state).toBe("input-changed");
  f.files.delete("exports/positions.csv"); expect((await inspect()).state).toBe("missing-input");
});
