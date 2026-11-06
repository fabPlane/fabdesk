import { expect, test } from "bun:test";
import { RootSchematicPreviewRevision, type ProjectBoardSources } from "@fabdesk/protocol";
import { inspectRootSchematicPreview } from "./assembly-schematic-preview";
import { CoreHttpError } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";

async function fixture() {
  const files = new Map<string, Blob>([["board.kicad_sch", new Blob(["root"])], ["child.kicad_sch", new Blob(["reused child"])], ...["root", "left", "right"].map((name): [string, Blob] => [`renders/schematic/v1/${name}.svg`, new Blob([`<svg>${name}</svg>`])])]);
  const receipt = RootSchematicPreviewRevision.parse({ contract: "fabplane.schematic-preview-revision.v1", projectId: "p", sourceRevision: "a".repeat(64), sourceFiles: await Promise.all(["board.kicad_sch", "child.kicad_sch"].map(async path => ({ path, sha256: await sha256Blob(files.get(path)!) }))), sheets: await Promise.all(["root", "left", "right"].map(async (name, i) => { const path = `renders/schematic/v1/${name}.svg`; return { path, name: "same-export-name.svg", sha256: await sha256Blob(files.get(path)!), nativeSheet: { identity: name, hierarchyPath: i ? `/${name}/` : "/", nativePath: i ? "child.kicad_sch" : "board.kicad_sch", pageNumber: i + 1 } }; })), dependencies: "unverified", generatedAt: "2026-11-05T10:00:00Z" });
  const save = () => files.set("renders/schematic.revision.json", new Blob([JSON.stringify(receipt)])); save();
  const source = { projectId: "p", mode: "single", observedAt: "2026-11-05T10:00:00Z", editing: "single-board-only", assembly: null, manifestSha256: null, sources: [] } as ProjectBoardSources;
  const reads: string[] = [], client = { inspectBoardSources: async () => source, readFileBlob: async (_project: string, path: string) => { reads.push(path); const blob = files.get(path); if (!blob) throw new CoreHttpError(404, path, "missing"); return blob; } };
  return { files, receipt, source, reads, client, save };
}
test("root page selection retains distinct repeated native instances instead of identical export filenames", async () => {
  const f = await fixture(), page = f.receipt.sheets[2]!;
  const result = await inspectRootSchematicPreview(f.client, "p", page.path);
  expect(result.state).toBe("source-unchanged"); expect(result.svg).toContain("right"); expect(result.sheet?.nativeSheet).toMatchObject({ identity: "right", nativePath: "child.kicad_sch", pageNumber: 3 });
  expect(f.reads.some(path => path.endsWith("left.svg") || path.endsWith("root.svg"))).toBe(false);
  expect(result.dependencies).toBe("unverified");
});
test("root receipts reject another project's identity and a root-to-assembly scope change", async () => {
  const f = await fixture(); f.receipt.projectId = "other"; f.save();
  const wrong = await inspectRootSchematicPreview(f.client, "p"); expect(wrong.svg).toBeNull(); expect(wrong.state).toBe("scope-unverified");
  expect(f.reads.some(path => path.endsWith(".kicad_sch"))).toBe(false);
  f.source.mode = "assembly"; await expect(inspectRootSchematicPreview(f.client, "p")).rejects.toThrow("root schematic source changed");
});
test("a child save while its page downloads marks the entire root circuit snapshot stale", async () => {
  const f = await fixture(), read = f.client.readFileBlob;
  const result = await inspectRootSchematicPreview({ ...f.client, readFileBlob: async (project, path) => { const blob = await read(project, path); if (path.endsWith("right.svg")) f.files.set("child.kicad_sch", new Blob(["edited"])); return blob; } }, "p", f.receipt.sheets[2]!.path);
  expect(result.state).toBe("source-changed"); expect(result.svg).toContain("right");
});
test("working page receipts require unique page/instance identities and source-backed native paths", async () => {
  const f = await fixture();
  for (const patch of [{ identity: "root" }, { pageNumber: 1 }, { nativePath: "unknown.kicad_sch" }]) {
    const bad = structuredClone(f.receipt); Object.assign(bad.sheets[1]!.nativeSheet!, patch);
    expect(RootSchematicPreviewRevision.safeParse(bad).success).toBe(false);
  }
  const missing = structuredClone(f.receipt); delete missing.sheets[1]!.nativeSheet; expect(RootSchematicPreviewRevision.safeParse(missing).success).toBe(false);
});
