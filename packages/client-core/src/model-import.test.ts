import { expect, test } from "bun:test";
import { ImportedMechanicalModel } from "@fabdesk/protocol";
import { createModelImportSession, mechanicalModelFormat } from "./model-import";

function fixture() {
  const writes: Array<{ project: string; path: string; body: string | Blob }> = [];
  let failMetadata = false;
  const session = createModelImportSession({ projectId: "original-project", client: { writeFile: async (project, path, body) => {
    if (path.endsWith("model.json") && failMetadata) { failMetadata = false; throw new Error("metadata failed"); }
    writes.push({ project, path, body });
  } } });
  return { session, writes, failMetadata: () => { failMetadata = true; } };
}
test("original model bytes, name, units and unplaced status are preserved in one project", async () => {
  const f = fixture(), file = new Blob([new Uint8Array([0, 255, 2, 9])]);
  const model = await f.session.save(file, "My enclosure.stl", "mm");
  expect(f.writes[0]!.body).toBe(file);
  expect(f.writes.every((write) => write.project === "original-project")).toBe(true);
  expect(model).toMatchObject({ originalName: "My enclosure.stl", units: "mm", placement: "unplaced", bytes: 4 });
  expect(ImportedMechanicalModel.parse(JSON.parse(f.writes[1]!.body as string))).toEqual(model);
});
test("metadata retry reuses the original import path without uploading a second copy", async () => {
  const f = fixture(), file = new Blob(["stl bytes"]); f.failMetadata();
  await expect(f.session.save(file, "case.stl", "mm")).rejects.toThrow("metadata failed");
  const originalPath = f.writes[0]!.path;
  const model = await f.session.save(file, "case.stl", "cm");
  expect(model.path).toBe(originalPath);
  expect(model.units).toBe("cm");
  expect(f.writes.filter((write) => write.body instanceof Blob)).toHaveLength(1);
});
test("parallel saves share the same import and reject a different source", async () => {
  const f = fixture(), file = new Blob(["model"]);
  const first = f.session.save(file, "case.obj", "in");
  const second = f.session.save(file, "case.obj", "in");
  await expect(f.session.save(new Blob(["other"]), "different.obj", "mm")).rejects.toThrow("another file");
  expect(await first).toEqual(await second);
  expect(f.writes).toHaveLength(2);
});
test("format and unit mismatches fail before writing; hostile names cannot escape the import folder", async () => {
  const f = fixture(), file = new Blob(["model"]);
  await expect(f.session.save(file, "case.glb", "mm")).rejects.toThrow("units");
  expect(f.writes).toHaveLength(0);
  const model = await f.session.save(file, "../../case.glb", "m");
  expect(model.path).toStartWith(`mechanical/imports/${model.id}/`);
  expect(model.path.split("/")).toHaveLength(4);
  expect(mechanicalModelFormat("PART.STEP")).toBe("step");
  expect(mechanicalModelFormat("archive.zip")).toBeNull();
});
