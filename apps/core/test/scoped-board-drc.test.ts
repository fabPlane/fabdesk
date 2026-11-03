import { expect, test } from "bun:test";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRegistry, inspectProjectBoardSources } from "@fabdesk/tools";
import { contextFactory, mockServices, tempProject } from "../../../packages/tools/test/mock-services";
import { createContextFactory } from "../src/context";
import type { ProjectStore } from "../src/projects";
import { runDrc } from "@fabdesk/kicad";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(native = false) {
  const project = await tempProject("scoped-drc"), declaration = join(project.dir, "fabplane.assembly.json");
  for (const id of ["a", "b"]) {
    await mkdir(join(project.dir, "boards", id), { recursive: true });
    await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), join(project.dir, "boards", id, "board.kicad_pcb"));
    await Bun.write(join(project.dir, "boards", id, "reports/drc.json"), `previous ${id} report`);
  }
  await Bun.write(join(project.dir, "reports/drc.json"), "unrelated root report");
  await writeFile(declaration, JSON.stringify({ contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: [{ id: "left", name: "Left", sourceId: "a" }, { id: "right", name: "Right", sourceId: "a" }, { id: "other", name: "Other", sourceId: "b" }], connections: [] }));
  const membership = await inspectProjectBoardSources(project), board = { sourceId: "a", manifestSha256: membership.manifestSha256! };
  const source = await realpath(join(project.dir, "boards/a/board.kicad_pcb")), revision = sha(await readFile(source));
  let fault: "none" | "membership" | "source" = "none", calls = 0;
  const base = mockServices([project]);
  const services = mockServices([project], { design: { ...base.design, query: async () => [] }, kicad: { ...base.kicad,
    resolveCli: async () => ({ path: native ? process.env["FABPLANE_KICAD_CLI"]! : "/mock/cli", version: "10.99.0" }),
    runDrc: async (cli, args) => {
      calls++; expect(args.board).toBe(source); expect(args.schematicParity).toBe(false);
      const result = native ? await runDrc(cli, args) : { violations: [], unconnected: [], schematicParity: [], counts: { errors: 0, warnings: 0, unconnected: 0 } };
      if (fault === "membership") await writeFile(declaration, (await readFile(declaration)).toString() + "\n");
      if (fault === "source") await writeFile(source, (await readFile(source)).toString() + "\n");
      return result;
    },
  } });
  const registry = createRegistry(), factory = createContextFactory({ services, projects: { isPromoting: () => false, resolve: async () => project } as unknown as ProjectStore, tokens: null });
  const invoke = (args: Record<string, unknown>) => registry.invoke("verify_drc", { project: project.id, ...args }, (projectRef, def, selected) => factory({ projectRef, def, ...(selected ? { board: selected } : {}), signal: new AbortController().signal, progress: () => {} }));
  return { project, board, source, declaration, revision, registry, services, factory, invoke, setFault: (value: typeof fault) => { fault = value; }, calls: () => calls };
}
test("member DRC requires explicit captured scope, source revision and PCB-only choice", async () => {
  const f = await fixture();
  try {
    await expect(f.invoke({ schematicParity: false })).rejects.toThrow("explicit assembly board source");
    await expect(f.invoke({ board: f.board, schematicParity: false })).rejects.toThrow("expectedSourceSha256");
    await expect(f.invoke({ board: f.board, expectedSourceSha256: f.revision })).rejects.toThrow("PCB-only");
    await expect(f.invoke({ board: f.board, expectedSourceSha256: "0".repeat(64), schematicParity: false })).rejects.toThrow("changed since inspection");
    const ignored = contextFactory(f.services, f.project);
    await expect(f.registry.invoke("verify_drc", { board: f.board, expectedSourceSha256: f.revision, schematicParity: false }, projectRef => ignored({ def: f.registry.get("verify_drc")!, projectRef, signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow("did not establish");
    expect(f.calls()).toBe(0);
    expect(await Bun.file(join(f.project.dir, "boards/a/reports/drc.json")).text()).toBe("previous a report");
  } finally { await rm(f.project.dir, { recursive: true, force: true }); }
});
async function publication(native: boolean) {
  const f = await fixture(native);
  try {
    const original = await readFile(f.source), manifest = await readFile(f.declaration);
    const args = { board: f.board, expectedSourceSha256: f.revision, schematicParity: false };
    const result = await f.invoke(args), reportPath = join(f.project.dir, "boards/a/reports/drc.json"), saved = await readFile(reportPath), report = JSON.parse(saved.toString());
    expect(result.json).toMatchObject({ _board: { projectId: f.project.id, ...f.board } });
    expect(report.boardSource).toEqual({ projectId: f.project.id, ...f.board });
    expect(report.pcbRevision.sha256).toBe(f.revision); expect(report.schematicParityChecked).toBe(false);
    expect(await readFile(f.source)).toEqual(original);
    expect(await Bun.file(join(f.project.dir, "boards/b/reports/drc.json")).text()).toBe("previous b report");
    expect(await Bun.file(join(f.project.dir, "reports/drc.json")).text()).toBe("unrelated root report");
    f.setFault("membership"); await expect(f.invoke(args)).rejects.toThrow("ownership changed"); expect(await readFile(reportPath)).toEqual(saved);
    await writeFile(f.declaration, manifest);
    f.setFault("source"); await expect(f.invoke(args)).rejects.toThrow("changed while DRC"); expect(await readFile(reportPath)).toEqual(saved);
    await writeFile(f.source, original); f.setFault("none");
    const def = f.registry.get("verify_drc")!;
    const queued = await f.factory({ def, projectRef: f.project.id, board: f.board, signal: new AbortController().signal, progress: () => {} });
    await writeFile(f.declaration, manifest.toString() + "\n"); const before = f.calls();
    await expect(f.registry.invoke("verify_drc", args, () => queued)).rejects.toThrow("ownership changed"); expect(f.calls()).toBe(before); expect(await readFile(reportPath)).toEqual(saved);
  } finally { await rm(f.project.dir, { recursive: true, force: true }); }
}
test("member report publication remains leaf-owned and preserves earlier reports after ownership/source/queued changes", () => publication(false));
test.skipIf(!process.env["FABPLANE_KICAD_CLI"])("installed KiCad checks the explicit member and preserves other/root reports and failed measurements", () => publication(true), 120_000);
