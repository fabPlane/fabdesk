import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, NativeRevisionConflict, type CoreServices } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function fixture(run: (source: string, target: Awaited<ReturnType<typeof tempProject>>, call: (services?: Partial<CoreServices>) => Promise<unknown>) => Promise<void>) {
  const source = await mkdtemp(join(tmpdir(), "fabdesk-import-source-"));
  const project = await tempProject("import-target");
  const registry = createRegistry();
  const call = (overrides?: Partial<CoreServices>) => {
    const factory = contextFactory(mockServices([project], overrides), project);
    return registry.invoke("project_import_kicad", { path: join(source, "product.kicad_pcb") }, ref => factory({
      def: registry.get("project_import_kicad")!, projectRef: ref, signal: new AbortController().signal, progress() {},
    }));
  };
  try {
    await writeFile(join(source, "product.kicad_pcb"), "imported board");
    await writeFile(join(source, "product.kicad_sch"), "imported root sheet");
    await writeFile(join(project.dir, "board.kicad_pcb"), "saved target board");
    await writeFile(join(project.dir, "board.kicad_sch"), "saved target schematic");
    await run(source, project, call);
  } finally { await rm(source, { recursive: true, force: true }); await rm(project.dir, { recursive: true, force: true }); }
}

test.each(["board.kicad_sch", "BOARD.kicad_sch"])("an adjacent %s cannot silently replace a renamed imported root sheet", name => fixture(async (source, target, call) => {
  await writeFile(join(source, name), "unrelated adjacent sheet");
  await expect(call()).rejects.toThrow("multiple source files");
  expect(await readFile(join(target.dir, "board.kicad_pcb"), "utf8")).toBe("saved target board");
  expect(await readFile(join(target.dir, "board.kicad_sch"), "utf8")).toBe("saved target schematic");
}));

test("adoption preserves exact native bytes, custom rules, and non-conflicting adjacent sheets", () => fixture(async (source, target, call) => {
  await writeFile(join(source, "product.kicad_dru"), "custom rules");
  await writeFile(join(source, "child.kicad_sch"), "child sheet");
  await call();
  expect(await readFile(join(target.dir, "board.kicad_pcb"), "utf8")).toBe("imported board");
  expect(await readFile(join(target.dir, "board.kicad_sch"), "utf8")).toBe("imported root sheet");
  expect(await readFile(join(target.dir, "board.kicad_dru"), "utf8")).toBe("custom rules");
  expect(await readFile(join(target.dir, "child.kicad_sch"), "utf8")).toBe("child sheet");
}));

test("adoption refuses unsaved live work before replacing saved files", () => fixture(async (_source, target, call) => {
  const base = mockServices([target]);
  await expect(call({ design: { ...base.design, withSavedFilesRecovery: async () => { throw new NativeRevisionConflict("unsaved live changes"); } } })).rejects.toThrow("unsaved live changes");
  expect(await readFile(join(target.dir, "board.kicad_pcb"), "utf8")).toBe("saved target board");
}));

test.skipIf(process.platform === "win32")("a destination sheet symlink cannot overwrite an external file", () => fixture(async (source, target, call) => {
  const outside = join(source, "outside.txt");
  await writeFile(outside, "external data");
  await rm(join(target.dir, "board.kicad_sch"));
  await symlink(outside, join(target.dir, "board.kicad_sch"));
  await expect(call()).rejects.toThrow("symlink");
  expect(await readFile(outside, "utf8")).toBe("external data");
  expect(await readFile(join(target.dir, "board.kicad_pcb"), "utf8")).toBe("saved target board");
}));
