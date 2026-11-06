import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { exportOwnedSchematicSvg, exportOwnedSchematicPage, inspectSchematicHierarchy, type KicadCli } from "../src";
import { ownedPreviewFixture } from "./owned-schematic-fixture";

test("owned SVG export returns every sheet and captured source hashes without changing native files", async () => {
  const f = await ownedPreviewFixture(); try {
    const before = await readFile(join(f.dir, "board.kicad_sch")), hierarchy = await f.inspect();
    const result = await exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy });
    expect(result.sourceRevision).toBe(hierarchy.aggregateRevision); expect(result.sheets).toHaveLength(2); expect(result.sourceFiles.map(file => file.path).sort()).toEqual(["board.kicad_pro", "board.kicad_sch", "child.kicad_sch"]);
    expect(result.sheets.every(sheet => new TextDecoder().decode(sheet.svg).includes("Native test sheet"))).toBe(true); expect(await readFile(join(f.dir, "board.kicad_sch"))).toEqual(before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test("selected native page follows inspected UUID instance identity rather than export filenames", async () => {
  const f = await ownedPreviewFixture(); try {
    const hierarchy = await f.inspect(), child = hierarchy.sheets.find(sheet => sheet.nativePath === "child.kicad_sch")!;
    expect(child.pageNumber).toBe(2); expect(child.instancePath).toBe("/00000000-0000-0000-0000-000000000002/");
    expect(child.symbolInstancePath).toBe("/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002");
    const page = await exportOwnedSchematicPage(f.cli, { projectDir: f.dir, hierarchy, sheetIdentity: child.identity });
    expect(page.sheets.map(sheet => sheet.name)).toEqual(["child.svg"]);
    expect(page.sourceFiles).toHaveLength(3);
    await expect(exportOwnedSchematicPage(f.cli, { projectDir: f.dir, hierarchy, sheetIdentity: "not-a-sheet" })).rejects.toThrow("unique inspected");
    await expect(exportOwnedSchematicPage(f.cli, { projectDir: f.dir, hierarchy: { ...hierarchy, sheets: hierarchy.sheets.map(sheet => ({ ...sheet, pageNumber: 2 })) }, sheetIdentity: child.identity })).rejects.toThrow("unique inspected");
    await writeFile(join(f.dir, "child.kicad_sch"), (await readFile(join(f.dir, "child.kicad_sch"), "utf8")) + "\n");
    await expect(exportOwnedSchematicPage(f.cli, { projectDir: f.dir, hierarchy, sheetIdentity: child.identity })).rejects.toThrow("changed");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test("circuit sheets bind native page identities even when hierarchy order differs from filenames", async () => {
  const f = await ownedPreviewFixture(); try {
    const hierarchy = await f.inspect(); hierarchy.sheets.reverse();
    const result = await exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy, circuit: true });
    expect(result.sheets.map(sheet => sheet.nativeSheet?.hierarchyPath)).toEqual(["/Child/", "/"]);
    expect(result.sheets.map(sheet => sheet.name)).toEqual(["child.svg", "root.svg"]);
    expect(result.sheets.every(sheet => new TextDecoder().decode(sheet.svg).includes('data-fabplane-schematic-view="circuit'))).toBe(true);
    const invalid = { ...hierarchy, sheets: hierarchy.sheets.map(sheet => ({ ...sheet, pageNumber: 1 })) };
    await expect(exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy: invalid, circuit: true })).rejects.toThrow("unique inspected");
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
}, 30_000);
test.skipIf(!process.env["FABPLANE_KICAD_CLI"])("installed KiCad selects the actual child instance page and leaves both native sheets unchanged", async () => {
  const f = await ownedPreviewFixture(true); try {
    const before = await Promise.all(["board.kicad_sch", "child.kicad_sch"].map(path => readFile(join(f.dir, path), "utf8")));
    const hierarchy = await f.inspect(), child = hierarchy.sheets.find(sheet => sheet.depth === 1)!;
    expect(child.pageNumber).toBe(2);
    const result = await exportOwnedSchematicPage(f.cli, { projectDir: f.dir, hierarchy, sheetIdentity: child.identity });
    expect(result.sheets).toHaveLength(1); expect(new TextDecoder().decode(result.sheets[0]!.svg)).toContain("Eeschema-SVG");
    expect(await Promise.all(["board.kicad_sch", "child.kicad_sch"].map(path => readFile(join(f.dir, path), "utf8")))).toEqual(before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
}, 30_000);
test.skipIf(!process.env["FABPLANE_KICAD_CLI"])("installed KiCad circuit framing omits paper furniture while document export and source metadata stay intact", async () => {
  const f = await ownedPreviewFixture(true); try {
    const before = await Promise.all(["board.kicad_sch", "child.kicad_sch", "board.kicad_pro"].map(path => readFile(join(f.dir, path), "utf8")));
    const hierarchy = await f.inspect();
    const document = await exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy });
    const circuit = await exportOwnedSchematicSvg(f.cli, { projectDir: f.dir, hierarchy, circuit: true });
    const rootDocument = new TextDecoder().decode(document.sheets[0]!.svg), rootCircuit = new TextDecoder().decode(circuit.sheets[0]!.svg);
    expect(/viewBox="([^"]+)"/.exec(rootDocument)![1]!.split(/\s+/).map(Number).slice(0, 2)).toEqual([0, 0]); expect(rootDocument).not.toContain('data-fabplane-schematic-view');
    expect(rootCircuit).toContain('data-fabplane-schematic-view="circuit"');
    const box = /viewBox="([^"]+)"/.exec(rootCircuit)![1]!.split(/\s+/).map(Number);
    expect(box[2]).toBeLessThan(100); expect(box[3]).toBeLessThan(100);
    expect(circuit.sourceRevision).toBe(document.sourceRevision);
    expect(await Promise.all(["board.kicad_sch", "child.kicad_sch", "board.kicad_pro"].map(path => readFile(join(f.dir, path), "utf8")))).toEqual(before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
}, 30_000);
