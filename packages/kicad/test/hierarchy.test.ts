import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSchematicHierarchy, type KicadCli } from "../src";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const schematic = (n: number) =>
  `(kicad_sch (version 20231120) (generator eeschema) (uuid "${id(n)}") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "${n}"))))\n`;

async function fixture(sheetCount = 2) {
  const projectDir = await realpath(await mkdtemp(join(tmpdir(), "fabdesk-hierarchy-test-")));
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

describe("independently owned member hierarchy snapshots", () => {
  const inspect = (projectDir: string, cli: KicadCli) => inspectSchematicHierarchy(cli, { projectDir, rootSchematic: join(projectDir, "board.kicad_sch"), ownedFilesOnly: true });
  test("exports captured native bytes from scratch, binds project metadata and preserves originals", async () => {
    const { projectDir, cli } = await fixture();
    try {
      const pcb = join(projectDir, "board.kicad_sch"), original = await readFile(pcb, "utf8");
      let scratch = "";
      const checked = { ...cli, trace: async (args: Parameters<NonNullable<KicadCli["trace"]>>[0]) => {
        scratch = args.command.at(-1)!;
        expect(scratch).not.toBe(pcb); expect(await readFile(scratch, "utf8")).toBe(original);
        expect(await readFile(join((await import("node:path")).dirname(scratch), "child-1.kicad_sch"), "utf8")).toBe(schematic(2));
        return cli.trace!(args);
      } };
      const first = await inspect(projectDir, checked); expect(first.complete).toBe(true);
      expect(await readFile(pcb, "utf8")).toBe(original);
      await expect(readFile(scratch)).rejects.toThrow();
      const pro = join(projectDir, "board.kicad_pro"); await writeFile(pro, (await readFile(pro, "utf8")) + "\n");
      expect((await inspect(projectDir, cli)).aggregateRevision).not.toBe(first.aggregateRevision);
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });
  for (const alias of ["symlink", "hardlink", "parent-symlink"] as const) test(`rejects a ${alias} child without exporting external native bytes`, async () => {
    const { projectDir, cli } = await fixture(); const external = await fixture(1); let exported = false;
    try {
      const { symlink, link, mkdir } = await import("node:fs/promises");
      const child = join(projectDir, "child-1.kicad_sch"); await rm(child);
      if (alias === "parent-symlink") {
        const pro = join(projectDir, "board.kicad_pro"), metadata = JSON.parse(await readFile(pro, "utf8")); metadata.schematic.top_level_sheets[1].filename = "nested/child.kicad_sch"; await writeFile(pro, JSON.stringify(metadata));
        await mkdir(join(external.projectDir, "nested")); await writeFile(join(external.projectDir, "nested", "child.kicad_sch"), schematic(2)); await symlink(join(external.projectDir, "nested"), join(projectDir, "nested"));
      } else await (alias === "symlink" ? symlink : link)(join(external.projectDir, "board.kicad_sch"), child);
      const result = await inspect(projectDir, { ...cli, trace: async args => { exported = true; return cli.trace!(args); } });
      expect(result.complete).toBe(false); expect(result.issues.some(issue => issue.kind === "unreadable")).toBe(true); expect(exported).toBe(false);
      expect(await readFile(join(external.projectDir, "board.kicad_sch"), "utf8")).toBe(schematic(1));
    } finally { await rm(projectDir, { recursive: true, force: true }); await rm(external.projectDir, { recursive: true, force: true }); }
  });
  for (const changed of ["child", "metadata", "new-metadata"] as const) test(`rejects ${changed} changes during native snapshot measurement`, async () => {
    const { projectDir, cli } = await fixture(changed === "new-metadata" ? 1 : 2);
    try {
      const pro = join(projectDir, "board.kicad_pro"), originalPro = await readFile(pro);
      if (changed === "new-metadata") await rm(pro);
      const result = await inspect(projectDir, { ...cli, trace: async args => {
        const source = args.command.at(-1)!; expect(source.startsWith(projectDir)).toBe(false);
        if (changed === "child") await writeFile(join(projectDir, "child-1.kicad_sch"), schematic(2) + "\n");
        else await writeFile(pro, changed === "new-metadata" ? originalPro : Buffer.concat([originalPro, Buffer.from("\n")]));
        return cli.trace!(args);
      } });
      expect(result.complete).toBe(false); expect(result.issues.some(issue => issue.kind === "unreadable")).toBe(true);
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });
  test("rejects aliased project metadata and missing children; ordinary root hierarchy policy remains separate", async () => {
    const { projectDir, cli } = await fixture();
    try {
      const { symlink } = await import("node:fs/promises"); const pro = join(projectDir, "board.kicad_pro"), other = join(projectDir, "original.json");
      await writeFile(other, await readFile(pro)); await rm(pro); await symlink(other, pro);
      expect((await inspect(projectDir, cli)).complete).toBe(false);
      await rm(pro); await writeFile(pro, await readFile(other)); await rm(join(projectDir, "child-1.kicad_sch"));
      const missing = await inspect(projectDir, cli); expect(missing.complete).toBe(false); expect(missing.issues.some(issue => issue.kind === "missing")).toBe(true);
    } finally { await rm(projectDir, { recursive: true, force: true }); }
  });
});

test("owned snapshots preserve repeated native sheet instances without copying unrelated orphans", async () => {
  const f = await nestedFixture("quoted"); const projectDir = await realpath(f.projectDir);
  try {
    const root = join(projectDir, "board.kicad_sch"); await writeFile(root, (await readFile(root, "utf8")).replace("right.kicad_sch", "left.kicad_sch"));
    const result = await inspectSchematicHierarchy(f.cli, { projectDir, rootSchematic: root, ownedFilesOnly: true });
    expect(result.complete).toBe(true); expect(result.sheets.map(sheet => sheet.nativePath)).toEqual(["board.kicad_sch", "left.kicad_sch", "left.kicad_sch"]);
    expect(result.sheets[1]!.sha256).toBe(result.sheets[2]!.sha256); expect(result.orphanFiles).toEqual(["right.kicad_sch"]);
  } finally { await rm(projectDir, { recursive: true, force: true }); }
});
