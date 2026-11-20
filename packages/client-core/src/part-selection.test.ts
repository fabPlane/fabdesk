import { afterEach, expect, test } from "bun:test";
import { hitSelectionPart, partScopeKey, pcbSelectionParts, schematicSelectionParts, usePartSelection } from "./part-selection";
import { inspectSelectionIndex } from "./part-selection-source";
import { CoreHttpError } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
import type { ProjectBoardSources } from "@fabdesk/protocol";

const pcb = `(kicad_pcb (footprint "R" (at 20 30 90) (uuid "r") (property "Reference" "R[1]") (property "Value" "10k") (pad "1" smd rect (at 2 0 90) (size 2 1))))`;
const schematic = (annotations = "", extra = "", at = "20 30 0", mirror = "") => `(kicad_sch (uuid "root") (lib_symbols (symbol "Device:R" (symbol "R_0_1" (rectangle (start -1 2) (end 1 -2))))) (symbol (lib_id "Device:R") (at ${at}) (unit 1) (uuid "r") (property "Reference" "R1") ${mirror} ${annotations}) ${extra})`;
afterEach(() => usePartSelection.setState({ selection: null }));
test("selection follows a board across views and cannot leak across projects, endpoints or sources", () => {
  const a = partScopeKey({ endpoint: "a", projectId: "p", sourceId: "one", manifestSha256: "v1" });
  usePartSelection.getState().select(a, "R1");
  for (const scope of [{ endpoint: "b", projectId: "p", sourceId: "one", manifestSha256: "v1" }, { endpoint: "a", projectId: "q", sourceId: "one", manifestSha256: "v1" }, { endpoint: "a", projectId: "p", sourceId: "two", manifestSha256: "v1" }, { endpoint: "a", projectId: "p", sourceId: "one", manifestSha256: "v2" }]) {
    expect(partScopeKey(scope)).not.toBe(a); usePartSelection.getState().clear(partScopeKey(scope)); expect(usePartSelection.getState().selection?.ref).toBe("R1");
  }
  usePartSelection.getState().clear(a); expect(usePartSelection.getState().selection).toBeNull();
});
test("PCB hit testing respects native rotation and literal references", () => {
  const parts = pcbSelectionParts(pcb); expect(parts).toHaveLength(1);
  expect(hitSelectionPart(parts, { x: 20, y: 28 })?.ref).toBe("R[1]");
  expect(hitSelectionPart(parts, { x: 22, y: 30 })).toBeNull();
  expect(parts[0]?.value).toBe("10k");
  expect(pcbSelectionParts(pcb.replace('(property "Value" "10k")', '(fp_text value "4k7")'))[0]?.value).toBe("4k7");
  expect(parts[0]!.box.width).toBeCloseTo(1.8);
});
test("PCB duplicate references are ambiguous and malformed sources fail closed", () => {
  expect(pcbSelectionParts(pcb.replace(/\)$/, pcb.slice(11, -1) + ")"))).toEqual([]);
  expect(() => pcbSelectionParts(pcb.slice(0, -1))).toThrow();
  expect(() => pcbSelectionParts("(kicad_pcb) extra")).toThrow();
});
test("schematic parts come from placed symbols, not library definitions", () => {
  const parts = schematicSelectionParts(schematic(), "root", schematic());
  expect(parts).toHaveLength(1); expect(hitSelectionPart(parts, { x: 20, y: 30 })?.ref).toBe("R1");
  const valued = schematic('(property "Value" "ESP32-WROOM-32E")');
  expect(schematicSelectionParts(valued, "root", valued)[0]?.value).toBe("ESP32-WROOM-32E");
  expect(parts[0]!.box.width).toBeCloseTo(2.8); expect(parts[0]!.box.height).toBeCloseTo(4.8);
});
test("repeated schematic instances use their exact annotation", () => {
  const text = schematic('(instances (project "p" (path "/root/left" (reference "R1")) (path "/root/right" (reference "R2"))))');
  expect(schematicSelectionParts(text, "root/left", text)[0]?.ref).toBe("R1");
  expect(schematicSelectionParts(text, "root/right", text)[0]?.ref).toBe("R2");
  expect(schematicSelectionParts(text, "root/missing", text)).toEqual([]);
});
test("rotated and mirrored symbols keep native drawing coordinates", () => {
  const text = schematic("", "", "20 30 90", "(mirror x)");
  const p = schematicSelectionParts(text, "root", text)[0]!;
  expect(p.box.width).toBeCloseTo(4.8); expect(p.box.height).toBeCloseTo(2.8);
  expect(hitSelectionPart([p], { x: 21.8, y: 30 })?.ref).toBe("R1");
});
async function fixture() {
  const files = new Map<string, Blob>([["board.kicad_pcb", new Blob([pcb])]]);
  const sha = await sha256Blob(files.get("board.kicad_pcb")!);
  const receipt = { source: "board.kicad_pcb", sourceSha256: sha, artifactSha256: "b".repeat(64), generatedAt: "2026-11-11T00:00:00Z" };
  files.set("renders/pcb.svg.revision.json", new Blob([JSON.stringify({ ...receipt, contract: "fabplane.pcb-preview-revision.v1", artifact: "renders/pcb.svg" })]));
  files.set("renders/board.glb.revision.json", new Blob([JSON.stringify({ ...receipt, contract: "fabplane.board-model-revision.v1", artifact: "renders/board.glb", dependencies: "unverified" })]));
  const sources = { projectId: "p", mode: "single", sources: [] } as unknown as ProjectBoardSources;
  const client = { inspectBoardSources: async () => sources, readFileBlob: async (_: string, path: string) => { const blob = files.get(path); if (!blob) throw new CoreHttpError(404, path, "missing"); return blob; } };
  return { files, sources, client };
}
test("preview mappings bind to saved PCB hashes, and stale previews lose selection targets", async () => {
  const f = await fixture(); const fresh = await inspectSelectionIndex(f.client, "p");
  expect(fresh.pcb?.parts[0]?.ref).toBe("R[1]"); expect(fresh.model?.references).toEqual(["R[1]"]);
  expect(fresh.model?.values?.["R[1]"]).toBe("10k");
  f.files.set("board.kicad_pcb", new Blob([pcb.replace("20 30", "40 50")]));
  const stale = await inspectSelectionIndex(f.client, "p"); expect(stale.pcb).toBeNull(); expect(stale.model).toBeNull();
});
test("source changes during inspection reject the entire mapping", async () => {
  const f = await fixture(), read = f.client.readFileBlob; let reads = 0;
  f.client.readFileBlob = async (project, path) => { const result = await read(project, path); if (path === "board.kicad_pcb" && ++reads === 1) f.files.set(path, new Blob([pcb + " "])); return result; };
  await expect(inspectSelectionIndex(f.client, "p")).rejects.toThrow("changed while loading");
});
test("assembly selection refuses a root fallback or mismatched manifest", async () => {
  const f = await fixture(); f.sources.mode = "assembly";
  await expect(inspectSelectionIndex(f.client, "p")).rejects.toThrow("Select a board");
  await expect(inspectSelectionIndex(f.client, "p", { sourceId: "x", manifestSha256: "a".repeat(64) })).rejects.toThrow("source changed");
});
test("identical references in separate assembly sources use their own bytes and model receipt", async () => {
  const f = await fixture(), manifest = "a".repeat(64);
  const rootFiles = [...f.files]; f.files.clear();
  for (const id of ["a", "b"]) for (const [path, blob] of rootFiles) {
    let bytes = blob;
    if (path.endsWith("board.glb.revision.json")) bytes = new Blob([JSON.stringify({ ...JSON.parse(await blob.text()), boardSource: { projectId: "p", sourceId: id, manifestSha256: manifest } })]);
    f.files.set(`boards/${id}/${path}`, bytes);
  }
  Object.assign(f.sources, { mode: "assembly", manifestSha256: manifest, sources: ["a", "b"].map(id => ({ source: { id, name: id, location: "project", directory: `boards/${id}` }, status: "available" })) });
  const a = await inspectSelectionIndex(f.client, "p", { sourceId: "a", manifestSha256: manifest }); expect(a.model?.references).toEqual(["R[1]"]);
  f.files.set("boards/b/board.kicad_pcb", new Blob([pcb.replace("20 30", "50 60")]));
  const b = await inspectSelectionIndex(f.client, "p", { sourceId: "b", manifestSha256: manifest }); expect(b.model).toBeNull(); expect(b.pcb).toBeNull();
  const again = await inspectSelectionIndex(f.client, "p", { sourceId: "a", manifestSha256: manifest });
  expect(a.pcb).not.toBeNull(); expect(again.pcb).not.toBeNull();
  if (!a.pcb || !again.pcb) throw new Error("Expected source A to stay selectable");
  expect(again.pcb.parts).toEqual(a.pcb.parts);
});
test("multiple units of a schematic part are all selectable", () => {
  const other = '(symbol (lib_id "Device:R") (at 50 60) (unit 2) (uuid "other-unit") (property "Reference" "R1"))';
  const text = schematic("", other), parts = schematicSelectionParts(text, "root", text);
  expect(parts).toHaveLength(2);
  if (!parts) throw new Error("Expected multi-unit schematic parts");
  expect(hitSelectionPart(parts, { x: 50, y: 60 })?.ref).toBe("R1");
});

test("PCB pad bounds match KiCad board-absolute pad rotations", () => {
  // KiCad 10.0.4 pcbnew PAD.GetBoundingBox: 6x2 pad at 90 => 2x6,
  // at 45/135 => 5.656854x5.656854, before our 0.4 mm selection inset.
  for (const angle of [0, 45, 90, 135]) {
    const text = `(kicad_pcb (footprint "Test" (at 20 30 ${angle}) (property "Reference" "R1") (pad "1" smd rect (at 0 0 ${angle}) (size 6 2))))`;
    const box = pcbSelectionParts(text)[0]!.box;
    const width = angle === 0 ? 6 : angle === 90 ? 2 : Math.SQRT2 * 4;
    const height = angle === 0 ? 2 : angle === 90 ? 6 : Math.SQRT2 * 4;
    expect(box.x).toBeCloseTo(20 - width / 2 - .4, 5);
    expect(box.y).toBeCloseTo(30 - height / 2 - .4, 5);
    expect(box.width).toBeCloseTo(width + .8, 5);
    expect(box.height).toBeCloseTo(height + .8, 5);
  }
});
test("diagonal footprint rectangles keep all four corners selectable", () => {
  const text = '(kicad_pcb (footprint "Test" (at 20 30 45) (property "Reference" "U1") (fp_rect (start -2 -2) (end 2 2))))';
  const parts = pcbSelectionParts(text);
  expect(parts[0]!.box.width).toBeCloseTo(4 * Math.SQRT2 + .8);
  expect(parts[0]!.box.height).toBeCloseTo(4 * Math.SQRT2 + .8);
  expect(hitSelectionPart(parts, { x: 20, y: 32.5 })?.ref).toBe("U1");
});
test("transform-format footprint placement keeps the exact reference", () => {
  const text = '(kicad_pcb (footprint "Test" (transform (translate 20 30) (rotate 90)) (property "Reference" "U1") (pad "1" smd rect (at 2 0 90) (size 2 1))))';
  expect(hitSelectionPart(pcbSelectionParts(text), { x: 20, y: 28 })?.ref).toBe("U1");
});
test("round and curved footprint graphics retain their rotated extents", () => {
  const circle = '(kicad_pcb (footprint "Test" (at 20 30 45) (property "Reference" "U1") (fp_circle (center 0 0) (end 2 0))))';
  expect(pcbSelectionParts(circle)[0]!.box.width).toBeCloseTo(4.8);
  expect(pcbSelectionParts(circle)[0]!.box.height).toBeCloseTo(4.8);
  const arc = '(kicad_pcb (footprint "Test" (at 20 30) (property "Reference" "U1") (fp_arc (start 1.732050808 1) (mid 0 2) (end -1.732050808 -1))))';
  expect(pcbSelectionParts(arc)[0]!.box.x).toBeCloseTo(17.6);
});


test("colored footprint envelope follows rotated native geometry instead of its padded hit box", () => {
  const [part] = pcbSelectionParts('(kicad_pcb (footprint "R" (at 10 20 45) (property "Reference" "R1") (fp_rect (start -3 -1) (end 3 1))))');
  expect(part!.hull).toHaveLength(4);
  const area = Math.abs(part!.hull!.reduce((sum,p,i,points)=>{const next=points[(i+1)%points.length]!;return sum+p.x*next.y-next.x*p.y;},0))/2;
  expect(area).toBeCloseTo(12, 8);
  expect(area).toBeLessThan(part!.box.width*part!.box.height);
});

test("schematic color fill follows the symbol body without enclosing its distant pin anchors", () => {
  const text = schematic().replace('(rectangle (start -1 2) (end 1 -2))', '(rectangle (start -1 2) (end 1 -2)) (pin input line (at 6 0) (length 5))');
  const [part] = schematicSelectionParts(text, "root", text);
  expect(part!.hull).toHaveLength(4);
  expect(Math.max(...part!.hull!.map(p=>p.x))).toBe(21);
  expect(part!.box.x + part!.box.width).toBeCloseTo(26.4);
});
