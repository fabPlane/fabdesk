import { expect, test } from "bun:test";
import type { CoreClient } from "../CoreClient";
import { sha256Blob } from "../pcb-preview-revision";
import { createPlacementWorkingCopy, PlacementCopyError, placementWorkingFiles } from "./working-copy";

async function fixture() {
  const files = new Map<string, Blob>([
    ["board.kicad_pcb", new Blob(["original PCB"])], ["board.kicad_sch", new Blob(["schematic"])],
    ["models/local.bin", new Blob([new Uint8Array([0, 255, 16])])], ["renders/top.png", new Blob(["stale preview"])],
    ["reports/drc.json", new Blob(["old report"])], ["placement/candidate.kicad_pcb", new Blob(["unrouted PCB"])],
    ["fabdesk.json", new Blob(["old identity"])],
  ]);
  const copies = new Map<string, Blob>(), writes: string[] = [], patches: string[] = [];
  let created = 0;
  const client = {
    async getProject() { return { manifest: { board: { layers: 4 } }, files: [...files].map(([path, blob]) => ({ path, size: blob.size })) }; },
    async createProject() { created++; return { id: "copy", name: "Working copy" }; },
    async readFileBlob(projectId: string, path: string) { const value = (projectId === "original" ? files : copies).get(path); if (!value) throw Error("missing file"); return value; },
    async writeFile(projectId: string, path: string, body: string | Blob) { writes.push(projectId + "/" + path); if (projectId !== "copy") throw Error("original write forbidden"); copies.set(path, typeof body === "string" ? new Blob([body]) : body); },
    async request(path: string) { patches.push(path); return {}; },
  } as unknown as Pick<CoreClient, "getProject" | "createProject" | "readFileBlob" | "writeFile" | "request">;
  const source = { projectId: "original", path: "board.kicad_pcb", sha256: await sha256Blob(files.get("board.kicad_pcb")!) };
  const candidate = { path: "placement/candidate.kicad_pcb", sha256: await sha256Blob(files.get("placement/candidate.kicad_pcb")!), revision: 1, widthMm: 32, heightMm: 20 };
  return { client, files, copies, writes, patches, source, candidate, created: () => created };
}
test("working copy preserves binary source assets, replaces only its own PCB, and excludes old evidence", async () => {
  const f = await fixture(), before = [...f.files];
  const result = await createPlacementWorkingCopy(f.client, { source: f.source, candidate: f.candidate, name: "Working copy" });
  expect(result.id).toBe("copy");
  expect(await f.copies.get("board.kicad_pcb")!.text()).toBe("unrouted PCB");
  expect(await f.copies.get("models/local.bin")!.arrayBuffer()).toEqual(await f.files.get("models/local.bin")!.arrayBuffer());
  expect([...f.copies.keys()].sort()).toEqual(["board.kicad_pcb", "board.kicad_sch", "models/local.bin", "placement/working-copy.json"]);
  expect(f.writes.every(path => path.startsWith("copy/"))).toBe(true);
  expect(f.patches).toEqual(["/projects/copy"]);
  expect([...f.files]).toEqual(before);
  expect(JSON.parse(await f.copies.get("placement/working-copy.json")!.text()).candidate.sha256).toBe(f.candidate.sha256);
});
test("a stale PCB or altered exported file cannot create a new working project", async () => {
  for (const target of ["board.kicad_pcb", "placement/candidate.kicad_pcb"]) {
    const f = await fixture(); f.files.set(target, new Blob(["changed"]));
    await expect(createPlacementWorkingCopy(f.client, { source: f.source, candidate: f.candidate, name: "Copy" })).rejects.toThrow("changed");
    expect(f.created()).toBe(0); expect(f.writes).toEqual([]);
  }
});
test("concurrent source changes keep a partial project inspectable without touching the original", async () => {
  const f = await fixture(); let caught: unknown;
  try {
    await createPlacementWorkingCopy(f.client, { source: f.source, candidate: f.candidate, name: "Copy", onProgress: done => { if (done === 3) f.files.set("board.kicad_sch", new Blob(["changed hierarchy"])); } });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(PlacementCopyError);
  expect((caught as PlacementCopyError).projectId).toBe("copy");
  expect((caught as Error).message).toContain("Source changed while copying");
  expect(await f.copies.get("board.kicad_pcb")!.text()).toBe("original PCB");
  expect(f.copies.has("placement/working-copy.json")).toBe(false);
});
test("assembly membership and source paths remain intact while member-generated evidence is excluded", () => {
  const files = ["fabplane.assembly.json", "boards/io/board.kicad_pcb", "boards/io/child.kicad_sch", "boards/io/models/connector.step", "boards/io/renders/pcb.svg", "boards/io/reports/drc.json", "boards/rh/exports/gerbers.zip", ".fabdesk/runs/run/a.json", "board.kicad_pro.lck"].map(path => ({ path, size: 1 }));
  expect(placementWorkingFiles(files).map(file => file.path)).toEqual(["fabplane.assembly.json", "boards/io/board.kicad_pcb", "boards/io/child.kicad_sch", "boards/io/models/connector.step"]);
});
test("a PCB changed between initial verification and snapshot copying cannot activate an old candidate", async () => {
  const f = await fixture();
  const create = f.client.createProject.bind(f.client);
  f.client.createProject = async (...args) => {
    const next = await create(...args);
    f.files.set("board.kicad_pcb", new Blob(["new PCB revision"]));
    return next;
  };
  await expect(createPlacementWorkingCopy(f.client, { source: f.source, candidate: f.candidate, name: "Copy" })).rejects.toThrow("PCB changed while copying");
  expect(f.copies.has("placement/working-copy.json")).toBe(false);
  expect(f.copies.has("board.kicad_pcb")).toBe(false);
});
