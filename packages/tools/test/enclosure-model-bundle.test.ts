import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleEnclosureModels } from "../src/tools/enclosure-model-bundle";
import { tempProject } from "./mock-services";
import { readSavedBoardModels, resolveModelPath } from "@fabdesk/kicad";

const pcb = (path: string) =>
  new TextEncoder().encode(`(kicad_pcb
  (footprint "test" (property "Reference" "U1") (property "Description" "${path}")
    (model "${path}" (offset (xyz 0 0 0)))))`);

test("portable board models survive extraction, deduplicate and preserve original source bytes", async () => {
  const project = await tempProject("model-bundle");
  await mkdir(join(project.dir, "models"));
  await mkdir(join(project.dir, "nested"));
  await writeFile(join(project.dir, "models/part.step"), "model bytes");
  const boards = {
    "board.kicad_pcb": pcb("${KIPRJMOD}/models/part.step"),
    "nested/second.kicad_pcb": pcb("${KIPRJMOD}/../models/part.step"),
  };
  const result = await bundleEnclosureModels(project.dir, boards);
  const modelFiles = Object.keys(result.files).filter((p) =>
    p.startsWith("boards/.fabdesk-models/"),
  );
  expect(modelFiles).toHaveLength(1);
  expect(result.dependencies.every((d) => d.status === "packaged")).toBe(true);
  const extracted = await tempProject("model-extracted");
  for (const [name, data] of Object.entries(result.files)) {
    await mkdir(join(extracted.dir, name, ".."), { recursive: true });
    await writeFile(join(extracted.dir, name), data);
  }
  for (const [name, original] of Object.entries(boards)) {
    expect(result.files[`source-boards/${name}`]).toEqual(original);
    const text = new TextDecoder().decode(result.files[`boards/${name}`]);
    expect(text).toContain('(property "Description" "${KIPRJMOD}/');
    const declared = readSavedBoardModels(text)[0]!.models[0]!.declared;
    const root = name.startsWith("nested/")
      ? join(extracted.dir, "boards/nested")
      : join(extracted.dir, "boards");
    const resolved = resolveModelPath(declared, root);
    expect(resolved.status).toBe("resolved");
    expect(await readFile(resolved.path!, "utf8")).toBe("model bytes");
  }
});

test("model content edits invalidate the snapshot even when PCB bytes stay identical", async () => {
  const project = await tempProject("model-revision");
  await writeFile(join(project.dir, "part.step"), "first");
  const boards = { "board.kicad_pcb": pcb("part.step") };
  const first = await bundleEnclosureModels(project.dir, boards);
  await writeFile(join(project.dir, "part.step"), "second");
  const second = await bundleEnclosureModels(project.dir, boards);
  expect(first.revision).not.toBe(second.revision);
  expect(first.dependencies[0]!.files[0]!.sha256).not.toBe(
    second.dependencies[0]!.files[0]!.sha256,
  );
});

test("VRML and STEP substitutions retain a shared stem; missing VRML can use its STEP", async () => {
  const project = await tempProject("model-substitution");
  await writeFile(join(project.dir, "part.wrl"), "vrml");
  await writeFile(join(project.dir, "part.step"), "step");
  await writeFile(join(project.dir, "only.step"), "only step");
  const result = await bundleEnclosureModels(project.dir, {
    "board.kicad_pcb": pcb("part.wrl"),
    "other.kicad_pcb": pcb("only.wrl"),
  });
  const pair = result.dependencies[0]!.files.map((f) => f.path.replace(/\.(wrl|step)$/, ""));
  expect(pair).toHaveLength(2);
  expect(pair[0]).toBe(pair[1]);
  expect(new TextDecoder().decode(result.files["boards/other.kicad_pcb"])).toContain('.step"');
});

test("missing, unbound library and outside-project models remain explicit and are not bundled", async () => {
  const project = await tempProject("model-gaps");
  const external = await tempProject("model-private");
  await writeFile(join(external.dir, "private.step"), "must not be exported");
  const source = pcb(join(external.dir, "private.step").replaceAll("\\", "/"));
  const result = await bundleEnclosureModels(project.dir, {
    "board.kicad_pcb": source,
    "missing.kicad_pcb": pcb("missing.step"),
    "unresolved.kicad_pcb": pcb("${FABDESK_UNSET_TEST_MODEL_DIR}/part.step"),
  });
  expect(result.dependencies.map((d) => d.status)).toEqual(["external", "missing", "unresolved"]);
  expect(Object.keys(result.files).some((p) => p.includes(".fabdesk-models"))).toBe(false);
  expect(result.files["boards/board.kicad_pcb"]).toEqual(source);
});

test("a model directory symlink cannot pull external files into an export", async () => {
  const project = await tempProject("model-link");
  const external = await tempProject("model-link-target");
  await writeFile(join(external.dir, "part.step"), "outside data");
  await symlink(
    external.dir,
    join(project.dir, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await bundleEnclosureModels(project.dir, {
    "board.kicad_pcb": pcb("linked/part.step"),
  });
  expect(result.dependencies[0]!.status).toBe("external");
  expect(result.dependencies[0]!.files).toEqual([]);
});

test("absolute board paths inside the project become safe relative archive entries", async () => {
  const project = await tempProject("model-absolute-board");
  await writeFile(join(project.dir, "part.step"), "local model");
  const result = await bundleEnclosureModels(project.dir, {
    [join(project.dir, "board.kicad_pcb")]: pcb("part.step"),
  });
  expect(result.files["boards/board.kicad_pcb"]).toBeDefined();
  expect(
    Object.keys(result.files).every((name) => !name.includes(":") && !name.includes("\\")),
  ).toBe(true);
});
