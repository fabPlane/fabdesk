import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const cli: KicadCli = {
    path: process.execPath,
    version: "10.99.0",
    trace: async ({ command }) => {
      await writeFile(command[command.indexOf("-o") + 1]!, xml);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  return { projectDir, cli };
}

describe("saved schematic hierarchy", () => {
  for (const format of ["quoted", "unquoted", "mixed"] as const) {
    test(`reads distinct sibling sheet IDs in ${format} schematics`, async () => {
      const { projectDir, inspect } = await nestedFixture(format);
      try {
        const result = await inspect();
        expect(result.complete).toBe(true);
        expect(result.issues).toEqual([]);
        expect(result.sheets.map((sheet) => sheet.identity)).toEqual([
          id(1),
          `root/${id(11)}`,
          `root/${id(12)}`,
        ]);
        expect(result.referencedFiles).toEqual([
          "board.kicad_sch",
          "left.kicad_sch",
          "right.kicad_sch",
        ]);
        expect(result.counts).toEqual({ components: 2, nets: 1, sheets: 3 });
        const before = result.aggregateRevision;
        await writeFile(
          join(projectDir, "right.kicad_sch"),
          `${await readFile(join(projectDir, "right.kicad_sch"), "utf8")}\n`,
        );
        expect((await inspect()).aggregateRevision).not.toBe(before);
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  }

  test("does not confuse UUID-looking text or nested pin IDs with sheet IDs", async () => {
    const { projectDir, inspect } = await nestedFixture("unquoted");
    try {
      const root = join(projectDir, "board.kicad_sch");
      const text = await readFile(root, "utf8");
      await writeFile(
        root,
        text.replace(
          `(uuid ${id(11)})`,
          `(property "Note" "(uuid fake)") (pin "P" (uuid "${id(99)}")) (uuid\n ${id(11)}\n )`,
        ),
      );
      const result = await inspect();
      expect(result.complete).toBe(true);
      expect(result.sheets[1]?.identity).toBe(`root/${id(11)}`);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  for (const format of ["quoted", "unquoted"] as const) {
    test(`still rejects genuinely duplicated ${format} sibling IDs`, async () => {
      const { projectDir, inspect } = await nestedFixture(format);
      try {
        const root = join(projectDir, "board.kicad_sch");
        await writeFile(root, (await readFile(root, "utf8")).replace(id(12), id(11)));
        const result = await inspect();
        expect(result.complete).toBe(false);
        expect(result.issues).toContainEqual({
          kind: "duplicate",
          path: "right.kicad_sch",
          detail: `sheet identity root/${id(11)} is also used at /left/`,
        });
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  }

  for (const problem of ["missing", "cycle", "parse"] as const) {
    test(`still rejects ${problem} errors in unquoted child schematics`, async () => {
      const { projectDir, inspect } = await nestedFixture("unquoted");
      try {
        const child = join(projectDir, "right.kicad_sch");
        if (problem === "missing") await rm(child);
        else if (problem === "cycle")
          await writeFile(
            child,
            `(kicad_sch (uuid ${id(3)}) (sheet (uuid ${id(13)}) (property "Sheetfile" "board.kicad_sch")))`,
          );
        else await writeFile(child, `(kicad_sch (uuid ${id(3)})`);
        const result = await inspect();
        expect(result.complete).toBe(false);
        expect(result.issues.some((issue) => issue.kind === problem)).toBe(true);
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    });
  }

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

/** Sibling sheet instances, as written in KiCad 7 (bare IDs) and newer files. */
async function nestedFixture(format: "quoted" | "unquoted" | "mixed") {
  const projectDir = await mkdtemp(join(tmpdir(), "fabdesk-hierarchy-uuid-test-"));
  const token = (n: number) =>
    format === "quoted" || (format === "mixed" && n % 2 === 0) ? `"${id(n)}"` : id(n);
  const document = (n: number, body = "") =>
    `(kicad_sch (version ${format === "unquoted" ? "20230121" : "20231120"}) (uuid ${token(n)}) ${body})`;
  const sheet = (n: number, name: string) =>
    `(sheet (uuid ${token(n)}) (property "Sheetname" "${name}") (property "Sheetfile" "${name}.kicad_sch"))`;
  await writeFile(
    join(projectDir, "board.kicad_sch"),
    document(1, `${sheet(11, "left")} ${sheet(12, "right")}`),
  );
  await writeFile(join(projectDir, "left.kicad_sch"), document(2));
  await writeFile(join(projectDir, "right.kicad_sch"), document(3));
  const cli: KicadCli = {
    path: process.execPath,
    version: "10.99.0",
    trace: async ({ command }) => {
      await writeFile(
        command[command.indexOf("-o") + 1]!,
        '<export><design><sheet number="1" name="/"/><sheet number="2" name="/left/"/><sheet number="3" name="/right/"/></design><components><comp ref="R1"><sheetpath names="/left/"/></comp><comp ref="C1"><sheetpath names="/right/"/></comp></components><nets><net code="1"><node ref="R1"/><node ref="C1"/></net></nets></export>',
      );
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  const inspect = () =>
    inspectSchematicHierarchy(cli, {
      projectDir,
      rootSchematic: join(projectDir, "board.kicad_sch"),
    });
  return { projectDir, cli, inspect };
}
