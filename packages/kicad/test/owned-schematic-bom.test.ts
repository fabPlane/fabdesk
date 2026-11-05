import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exportOwnedSchematicBom, type KicadCli } from "../src";
import { ownedPreviewFixture } from "./owned-schematic-fixture";

async function fixture(change?: (dir: string) => Promise<void>) {
  const f = await ownedPreviewFixture();
  let calls = 0;
  const cli: KicadCli = { ...f.cli, trace: async event => {
    if (!event.command.includes("bom")) return f.cli.trace!(event);
    calls++;
    const { command } = event, source = command.at(-1)!;
    expect(source.startsWith(f.dir)).toBe(false);
    expect(await readFile(join(dirname(source), "child.kicad_sch"), "utf8")).toContain("000000000003");
    expect(command).toContain("--exclude-dnp");
    expect(command[command.indexOf("--fields") + 1]).toContain("EXCLUDE_FROM_BOM");
    await writeFile(command[command.indexOf("-o") + 1]!, 'Reference,Value,Footprint,MPN,Manufacturer,QUANTITY,DNP,EXCLUDE_FROM_BOM,EXCLUDE_FROM_BOARD\nR1,1k,R_Axial,,,1,0,0,0\n');
    await change?.(f.dir);
    return { stdout: "", stderr: "", exitCode: 0 };
  } };
  return { ...f, cli, calls: () => calls };
}

test("owned BOM exports captured source and exclusion fields without changing native files", async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.dir, "board.kicad_sch")), hierarchy = await f.inspect();
    const result = await exportOwnedSchematicBom(f.cli, { projectDir: f.dir, hierarchy });
    expect(result.csv).toContain("R1,1k"); expect(result.sourceRevision).toBe(hierarchy.aggregateRevision);
    expect(result.sourceFiles).toHaveLength(3); expect(f.calls()).toBe(1);
    expect(await readFile(join(f.dir, "board.kicad_sch"))).toEqual(before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const when of ["before", "during"] as const) test(`a changed referenced sheet ${when} BOM export prevents returning mixed evidence`, async () => {
  const change = async (dir: string) => { const path = join(dir, "child.kicad_sch"); await writeFile(path, await readFile(path, "utf8") + "\n"); };
  const f = await fixture(when === "during" ? change : undefined);
  try {
    const hierarchy = await f.inspect(); if (when === "before") await change(f.dir);
    await expect(exportOwnedSchematicBom(f.cli, { projectDir: f.dir, hierarchy })).rejects.toThrow(/changed|revision/);
    expect(f.calls()).toBe(when === "before" ? 0 : 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
