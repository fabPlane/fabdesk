import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { snapshotProjectDependencies, assertProjectDependencies } from "../src/project-dependencies";
import { tempProject } from "./mock-services";

test("rules, tables, project libraries and model edits invalidate dependency evidence", async () => {
  const p = await tempProject("dependency-evidence");
  await mkdir(join(p.dir, "Parts.pretty"));
  await writeFile(join(p.dir, "Parts.pretty/X.kicad_mod"), "footprint bytes");
  await writeFile(join(p.dir, "fp-lib-table"), '(fp_lib_table (lib (name "Parts") (uri "${KIPRJMOD}/Parts.pretty")))');
  await writeFile(join(p.dir, "board.kicad_pcb"), '(kicad_pcb (footprint "Parts:X" (property "Reference" "U1") (model "${KIPRJMOD}/body.step")))');
  const captured = await snapshotProjectDependencies(p.dir);
  expect(captured.files).toContainEqual({ path: "body.step", sha256: null });
  for (const path of ["board.kicad_pro", "board.kicad_dru", "Parts.pretty/X.kicad_mod", "body.step", "fp-lib-table"]) {
    const before = await snapshotProjectDependencies(p.dir);
    await writeFile(join(p.dir, path), `changed ${path}`);
    await expect(assertProjectDependencies(p.dir, before)).rejects.toThrow("dependencies changed");
  }
});

test("dependency walking terminates on internal directory symlink cycles and discloses external libraries", async () => {
  const { symlink } = await import("node:fs/promises");
  const p = await tempProject("dependency-cycle");
  await mkdir(join(p.dir, "Parts.pretty"));
  await symlink(join(p.dir, "Parts.pretty"), join(p.dir, "Parts.pretty/again"), "dir");
  await writeFile(join(p.dir, "fp-lib-table"), '(fp_lib_table (lib (name "Parts") (uri "${KIPRJMOD}/Parts.pretty")) (lib (name "External") (uri "/outside.pretty")))');
  await writeFile(join(p.dir, "board.kicad_pcb"), '(kicad_pcb (footprint "External:X"))');
  const snapshot = await snapshotProjectDependencies(p.dir);
  expect(snapshot.unresolved).toContain("library:External:/outside.pretty");
  expect(snapshot.files.length).toBe(4);
});
