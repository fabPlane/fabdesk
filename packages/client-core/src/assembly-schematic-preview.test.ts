import { expect, test } from "bun:test";
import { ProjectBoardSources, AssemblySchematicPreviewRevision } from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
import { inspectAssemblySchematicPreview } from "./assembly-schematic-preview";
async function fixture() {
  const board = { sourceId: "a", manifestSha256: "a".repeat(64) }, source = { id: "a", name: "A", location: "project", directory: "boards/a" };
  const data = ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: board.manifestSha256, observedAt: "2026-10-28T03:00:00Z", editing: "explicit-source-tools", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", sourceId: "a", name: "Left" }, { id: "right", sourceId: "a", name: "Right" }], connections: [] }, sources: [{ source, status: "available", pcbSha256: "b".repeat(64) }] });
  const files = new Map<string, Blob>([["board.kicad_sch", new Blob(["root references child"])], ["child.kicad_sch", new Blob(["child symbols"])], ["renders/schematic/v1/root.svg", new Blob(['<svg viewBox="0 0 10 10"><text>Root</text></svg>'])], ["renders/schematic/v1/child.svg", new Blob(['<svg viewBox="0 0 10 10"><text>Child</text></svg>'])]]);
  const revision = AssemblySchematicPreviewRevision.parse({ contract: "fabplane.schematic-preview-revision.v1", boardSource: { projectId: "p", ...board }, sourceRevision: "c".repeat(64), sourceFiles: await Promise.all(["board.kicad_sch", "child.kicad_sch"].map(async path => ({ path, sha256: await sha256Blob(files.get(path)!) }))), sheets: await Promise.all(["renders/schematic/v1/root.svg", "renders/schematic/v1/child.svg"].map(async path => ({ path, name: path.split("/").at(-1)!, sha256: await sha256Blob(files.get(path)!) }))), dependencies: "unverified", generatedAt: "2026-10-28T03:00:00Z" });
  files.set("renders/schematic.revision.json", new Blob([JSON.stringify(revision)]));
  const paths: string[] = []; const client = { inspectBoardSources: async () => data, readFileBlob: async (_p: string, path: string) => { paths.push(path); const result = files.get(path.replace(/^boards\/a\//, "")); if (!result) throw new CoreHttpError(404, path, "missing"); return result; } };
  return { board, data, files, revision, client, paths };
}
test("reads exact selected page and recorded native sources without fetching a root PCB or other page", async () => {
  const f = await fixture(), page = f.revision.sheets[1]!;
  const result = await inspectAssemblySchematicPreview(f.client, "p", f.board, page.path);
  expect(result.state).toBe("source-unchanged"); expect(result.svg).toContain("Child"); expect(result.sheet?.path).toBe(page.path); expect(result.sheets).toHaveLength(2);
  expect(f.paths.every(path => path.startsWith("boards/a/"))).toBe(true); expect(f.paths.some(path => path.endsWith("board.kicad_pcb") || path.endsWith("root.svg"))).toBe(false);
});
for (const file of ["child.kicad_sch", "board.kicad_sch", "board.kicad_pro", "renders/schematic/v1/root.svg"] as const) test(`reports changed ${file} separately without claiming an electrical or dependency check`, async () => {
  const f = await fixture(); f.files.set(file, new Blob(["changed"])); const result = await inspectAssemblySchematicPreview(f.client, "p", f.board);
  expect(result.state).toBe(file.endsWith(".svg") ? "artifact-changed" : "source-changed"); expect(result.dependencies).toBe("unverified");
});
test("missing sources retain an older page; missing or unscoped receipts never inherit root previews", async () => {
  const f = await fixture(); f.files.delete("child.kicad_sch"); expect((await inspectAssemblySchematicPreview(f.client, "p", f.board)).state).toBe("source-changed");
  f.files.set("renders/schematic.revision.json", new Blob([JSON.stringify({ ...f.revision, boardSource: { ...f.revision.boardSource, sourceId: "other" } })]));
  const unscoped = await inspectAssemblySchematicPreview(f.client, "p", f.board); expect(unscoped.state).toBe("scope-unverified"); expect(unscoped.svg).toBeNull(); expect(unscoped.sheets).toHaveLength(0);
  f.files.delete("renders/schematic.revision.json"); expect((await inspectAssemblySchematicPreview(f.client, "p", f.board)).state).toBe("missing-preview");
});
test("native saves during page download, changing ownership and obsolete page selections cannot appear current", async () => {
  const f = await fixture(), original = f.client.readFileBlob;
  const changed = await inspectAssemblySchematicPreview({ ...f.client, readFileBlob: async (p, path) => { const blob = await original(p, path); if (path.endsWith("root.svg")) f.files.set("child.kicad_sch", new Blob(["saved during page download"])); return blob; } }, "p", f.board);
  expect(changed.state).toBe("source-changed");
  await expect(inspectAssemblySchematicPreview(f.client, "p", f.board, "renders/schematic/old/root.svg")).rejects.toThrow("pages changed");
  let inspections = 0; await expect(inspectAssemblySchematicPreview({ ...f.client, inspectBoardSources: async () => { const next = structuredClone(f.data); if (inspections++) next.manifestSha256 = "d".repeat(64); return next; } }, "p", f.board)).rejects.toThrow("source changed");
});
test("receipt publication races reject the old pointer instead of returning an obsolete selection", async () => {
  const f = await fixture(), read = f.client.readFileBlob; let pointers = 0;
  await expect(inspectAssemblySchematicPreview({ ...f.client, readFileBlob: async (p, path) => path.endsWith("schematic.revision.json") && pointers++ ? new Blob([JSON.stringify({ ...f.revision, generatedAt: "2026-10-28T04:00:00Z" })]) : read(p, path) }, "p", f.board)).rejects.toThrow("previews changed");
});
test("receipt rejects duplicate, escaping and non-schematic native paths", async () => {
  const f = await fixture();
  for (const path of ["../other.kicad_sch", "board.kicad_pcb", "/absolute.kicad_sch"]) expect(AssemblySchematicPreviewRevision.safeParse({ ...f.revision, sourceFiles: [...f.revision.sourceFiles, { path, sha256: "a".repeat(64) }] }).success).toBe(false);
  expect(AssemblySchematicPreviewRevision.safeParse({ ...f.revision, sourceFiles: [...f.revision.sourceFiles, f.revision.sourceFiles[0]] }).success).toBe(false);
});

test("source reads use bounded workers, settle before failure and stop later batches", async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++) { const path = `extra-${i}.kicad_sch`, blob = new Blob([`sheet ${i}`]); f.files.set(path, blob); f.revision.sourceFiles.push({ path, sha256: await sha256Blob(blob) }); }
  f.files.set("renders/schematic.revision.json", new Blob([JSON.stringify(f.revision)]));
  const read = f.client.readFileBlob; let active = 0, calls = 0, released!: () => void;
  const gate = new Promise<void>(resolve => { released = resolve; });
  const query = inspectAssemblySchematicPreview({ ...f.client, readFileBlob: async (p, path) => {
    if (!path.endsWith(".kicad_sch")) return read(p, path);
    calls++; active++; try { if (path.endsWith("board.kicad_sch")) throw new Error("offline"); await gate; return await read(p, path); } finally { active--; }
  } }, "p", f.board);
  let rejected = false; void query.catch(() => { rejected = true; }); await new Promise(resolve => setTimeout(resolve, 1));
  expect(rejected).toBe(false); expect(active).toBe(3); released(); await expect(query).rejects.toThrow("offline"); expect(calls).toBe(4); expect(active).toBe(0);
});
