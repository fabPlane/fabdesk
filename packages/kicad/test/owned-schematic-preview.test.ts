import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { exportOwnedSchematicSvg, inspectSchematicHierarchy, type KicadCli } from "../src";
import { ownedPreviewFixture } from "./owned-schematic-fixture";

test("owned SVG export returns every sheet and captured source hashes without changing native files", async () => {
  const f = await ownedPreviewFixture(); try {
    const before = await readFile(join(f.dir, "board.kicad_sch")), hierarchy = await f.inspect();
    const result = await exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy });
    expect(result.sourceRevision).toBe(hierarchy.aggregateRevision); expect(result.sheets).toHaveLength(2); expect(result.sourceFiles.map(file => file.path).sort()).toEqual(["board.kicad_pro", "board.kicad_sch", "child.kicad_sch"]);
    expect(result.sheets.every(sheet => new TextDecoder().decode(sheet.svg).includes("Native test sheet"))).toBe(true); expect(await readFile(join(f.dir, "board.kicad_sch"))).toEqual(before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
for (const when of ["before", "during"] as const) for (const file of ["child.kicad_sch", "board.kicad_pro"] as const) test(`rejects changed ${file} ${when} SVG export`, async () => {
  const f = await ownedPreviewFixture(); try {
    const hierarchy = await f.inspect(), change = async () => { const path = join(f.dir, file); await writeFile(path, (await readFile(path, "utf8")) + "\n"); };
    if (when === "before") await change(); else f.mutate(change);
    await expect(exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy })).rejects.toThrow(/changed|revision/);
    expect(f.svgCalls()).toBe(when === "before" ? 0 : 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test("incomplete or canceled hierarchy cannot publish rendered bytes", async () => {
  const f = await ownedPreviewFixture(); try {
    const hierarchy = await f.inspect(); await expect(exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy: { ...hierarchy, complete: false } })).rejects.toThrow("complete bounded");
    const controller = new AbortController(); f.mutate(async () => controller.abort());
    await expect(exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy, signal: controller.signal })).rejects.toThrow();
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test.skipIf(!process.env["FABPLANE_KICAD_CLI"])("installed KiCad produces two native SVG pages from an owned captured hierarchy", async () => {
  const f = await ownedPreviewFixture(true); try {
    const hierarchy = await f.inspect(), result = await exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy });
    expect(result.sheets).toHaveLength(2); expect(result.sheets.every(sheet => new TextDecoder().decode(sheet.svg).includes("<svg"))).toBe(true); expect(result.sourceFiles).toHaveLength(3);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
