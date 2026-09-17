import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSchematicHierarchy, type KicadCli } from "../src";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const schematic = (n: number) =>
  `(kicad_sch (version 20231120) (generator eeschema) (uuid "${id(n)}") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "${n}"))))\n`;

async function fixture(sheetCount = 2) {
  const projectDir = await mkdtemp(join(tmpdir(), "fabdesk-hierarchy-test-"));
  const sheets = Array.from({ length: sheetCount }, (_, index) => ({
    filename: index ? `child-${index}.kicad_sch` : "board.kicad_sch",
    name: index ? `Child ${index}` : "Root",
    uuid: id(index + 10),
  }));
  for (let index = 0; index < sheetCount; index++)
    await writeFile(join(projectDir, sheets[index]!.filename), schematic(index + 1));
  await writeFile(
    join(projectDir, "board.kicad_pro"),
    JSON.stringify({ schematic: { top_level_sheets: sheets } }),
  );
  const xml = `<?xml version="1.0"?><export><design><sheet number="1" name="/Root/"/><sheet number="2" name="/Child 1/"/></design><components><comp ref="R1"><sheetpath names="/Root/"/></comp><comp ref="C1"><sheetpath names="/Child 1/"/></comp></components><nets><net code="1" name="N"><node ref="R1" pin="1"/><node ref="C1" pin="1"/></net></nets></export>`;
  const executable = join(projectDir, "fake-kicad-cli");
  await writeFile(
    executable,
    `#!/bin/sh\nfor last; do :; done\nwhile [ "$1" != "-o" ]; do shift; done\nprintf '%s' '${xml}' > "$2"\n`,
  );
  await chmod(executable, 0o755);
  return { projectDir, cli: { path: executable, version: "10.99.0" } satisfies KicadCli };
}

describe("saved schematic hierarchy", () => {
  test("aggregates all referenced sheets, changes on child mutation, and excludes orphans", async () => {
    const { projectDir, cli } = await fixture();
    await writeFile(join(projectDir, "orphan.kicad_sch"), schematic(99));
    const before = await inspectSchematicHierarchy(cli, {
      projectDir,
      rootSchematic: join(projectDir, "board.kicad_sch"),
      projectFile: join(projectDir, "board.kicad_pro"),
    });
    expect(before).toMatchObject({
      complete: true,
      counts: { components: 2, nets: 1, sheets: 2 },
      referencedFiles: ["board.kicad_sch", "child-1.kicad_sch"],
      orphanFiles: ["orphan.kicad_sch"],
    });
    await writeFile(
      join(projectDir, "child-1.kicad_sch"),
      `${await readFile(join(projectDir, "child-1.kicad_sch"), "utf8")}\n`,
    );
    const after = await inspectSchematicHierarchy(cli, {
      projectDir,
      rootSchematic: join(projectDir, "board.kicad_sch"),
      projectFile: join(projectDir, "board.kicad_pro"),
    });
    expect(after.aggregateRevision).not.toBe(before.aggregateRevision);
  });

  test("fails closed when a referenced child is missing", async () => {
    const { projectDir, cli } = await fixture(1);
    const pro = JSON.parse(await readFile(join(projectDir, "board.kicad_pro"), "utf8"));
    pro.schematic.top_level_sheets.push({
      filename: "missing.kicad_sch",
      name: "Missing",
      uuid: id(88),
    });
    await writeFile(join(projectDir, "board.kicad_pro"), JSON.stringify(pro));
    const result = await inspectSchematicHierarchy(cli, {
      projectDir,
      rootSchematic: join(projectDir, "board.kicad_sch"),
      projectFile: join(projectDir, "board.kicad_pro"),
    });
    expect(result.complete).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "missing", path: "missing.kicad_sch" }),
      ]),
    );
    expect(result.counts.components).toBe(0);
  });

  test("fails closed when native project hierarchy metadata is malformed", async () => {
    const { projectDir, cli } = await fixture(1);
    await writeFile(join(projectDir, "board.kicad_pro"), "{not-json");
    const result = await inspectSchematicHierarchy(cli, {
      projectDir,
      rootSchematic: join(projectDir, "board.kicad_sch"),
      projectFile: join(projectDir, "board.kicad_pro"),
    });
    expect(result.complete).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "parse", path: "board.kicad_pro" })]),
    );
    expect(result.counts.components).toBe(0);
  });
});
