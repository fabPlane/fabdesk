import { expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRegistry, inspectProjectBoardSources } from "@fabdesk/tools";
import { mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { createContextFactory } from "../src/context";
import type { ProjectStore } from "../src/projects";
import { exportGlb } from "@fabdesk/kicad";
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
async function fixture(native = false) {
  const project = await tempProject("scoped-model"), declaration = join(project.dir, "fabplane.assembly.json");
  for (const id of ["a", "b"]) {
    await mkdir(join(project.dir, "boards", id, "renders"), { recursive: true });
    await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), join(project.dir, "boards", id, "board.kicad_pcb"));
    await Bun.write(join(project.dir, "boards", id, "renders/board.glb"), `previous ${id} model`);
    await Bun.write(join(project.dir, "boards", id, "renders/board.glb.revision.json"), `previous ${id} receipt`);
  }
  await Bun.write(join(project.dir, "renders/board.glb"), "unrelated root model");
  await writeFile(declaration, JSON.stringify({ contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: [{ id: "left", name: "Left", sourceId: "a" }, { id: "right", name: "Right", sourceId: "a" }, { id: "other", name: "Other", sourceId: "b" }], connections: [] }));
  const membership = await inspectProjectBoardSources(project), board = { sourceId: "a", manifestSha256: membership.manifestSha256! }, source = await realpath(join(project.dir, "boards/a/board.kicad_pcb")), revision = sha(await readFile(source));
  let fault: "none" | "source" | "membership" = "none", calls = 0;
  const base = mockServices([project]), services = mockServices([project], { kicad: { ...base.kicad,
    resolveCli: async () => ({ path: native ? process.env["FABPLANE_KICAD_CLI"]! : "/mock/cli", version: "10.99.0" }),
    exportGlb: async (cli, args) => {
      calls++; expect(args.board).toBe(source); expect(args.output.startsWith(await realpath(project.dir))).toBe(false);
      const result = native ? await exportGlb(cli, args) : (await Bun.write(args.output, "new source GLB"), { fused: false, warnings: ["Unverified component models"] });
      if (fault === "source") await writeFile(source, (await readFile(source)).toString() + "\n");
      if (fault === "membership") await writeFile(declaration, (await readFile(declaration)).toString() + "\n");
      return result;
    },
  } });
  const registry = createRegistry(), factory = createContextFactory({ services, projects: { isPromoting: () => false, resolve: async () => project } as unknown as ProjectStore, tokens: null });
  const invoke = (args: Record<string, unknown>) => registry.invoke("render_glb", { project: project.id, ...args }, (projectRef, def, selected) => factory({ projectRef, def, ...(selected ? { board: selected } : {}), signal: new AbortController().signal, progress: () => {} }));
  return { project, board, source, declaration, revision, registry, factory, invoke, setFault: (value: typeof fault) => { fault = value; }, calls: () => calls };
}
test("member model export requires explicit captured scope and inspected PCB hash", async () => {
  const f = await fixture(); try {
    await expect(f.invoke({})).rejects.toThrow("explicit assembly board source");
    await expect(f.invoke({ board: f.board })).rejects.toThrow("expectedSourceSha256");
    await expect(f.invoke({ board: f.board, expectedSourceSha256: "0".repeat(64) })).rejects.toThrow("changed since inspection");
    expect(f.calls()).toBe(0);
  } finally { await rm(f.project.dir, { recursive: true, force: true }); }
});
async function publication(native: boolean) {
  const f = await fixture(native); try {
    const original = await readFile(f.source), manifest = await readFile(f.declaration), args = { board: f.board, expectedSourceSha256: f.revision };
    const result = await f.invoke(args), output = join(f.project.dir, "boards/a/renders/board.glb"), receiptPath = output + ".revision.json", saved = await readFile(output), savedReceipt = await readFile(receiptPath), receipt = JSON.parse(savedReceipt.toString());
    expect(result.json).toMatchObject({ _board: { projectId: f.project.id, ...f.board } });
    expect(receipt.boardSource).toEqual({ projectId: f.project.id, ...f.board }); expect(receipt.sourceSha256).toBe(f.revision); expect(receipt.artifactSha256).toBe(sha(saved)); expect(receipt.dependencies).toBe("unverified");
    expect(await readFile(f.source)).toEqual(original); expect(await Bun.file(join(f.project.dir, "boards/b/renders/board.glb")).text()).toBe("previous b model"); expect(await Bun.file(join(f.project.dir, "renders/board.glb")).text()).toBe("unrelated root model");
    for (const fault of ["source", "membership"] as const) {
      f.setFault(fault); await expect(f.invoke(args)).rejects.toThrow(); expect(await readFile(output)).toEqual(saved); expect(await readFile(receiptPath)).toEqual(savedReceipt);
      await writeFile(f.source, original); await writeFile(f.declaration, manifest);
    }
    f.setFault("none"); const def = f.registry.get("render_glb")!, queued = await f.factory({ def, projectRef: f.project.id, board: f.board, signal: new AbortController().signal, progress: () => {} });
    await writeFile(f.declaration, manifest.toString() + "\n"); const calls = f.calls(); await expect(f.registry.invoke("render_glb", args, () => queued)).rejects.toThrow("ownership changed"); expect(f.calls()).toBe(calls);
  } finally { await rm(f.project.dir, { recursive: true, force: true }); }
}
test("member export publication preserves previous model/receipt and other/root source files after source/declaration/queued changes", () => publication(false));
test.skipIf(!process.env["FABPLANE_KICAD_CLI"])("installed KiCad exports the exact captured member and rejects changed publication without replacing prior models", () => publication(true), 120_000);
