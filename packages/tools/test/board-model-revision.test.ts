import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BOARD_MODEL_REVISION_PATH, BoardModelRevision } from "@fabdesk/protocol";
import { createRegistry } from "../src";
import { pcbPreviewFileHash } from "../src/pcb-preview-revision";
import { contextFactory, mockServices, tempProject } from "./mock-services";
import { prepareBoardModels } from "../../kicad/src/prepare-models";
import { cachedStockModel, stockModelCacheRoot } from "../../kicad/src/stock-model-cache";
import { snapshotProjectDependencies } from "../src/project-dependencies";

async function fixture(mode: "normal" | "source-change" | "failure" | "no-output") {
  const project = await tempProject("board-model-revision");
  const board = join(project.dir, "board.kicad_pcb"), output = join(project.dir, "renders/board.glb");
  await Bun.write(board, "(kicad_pcb)");
  const base = mockServices([project]);
  const services = mockServices([project], { kicad: { ...base.kicad, exportGlb: async (_cli, options) => {
    // Resolve component models in the real project, and export away from the saved artifact.
    expect(options.board).toBe(board); expect(options.output).not.toBe(output);
    if (mode !== "no-output") await Bun.write(options.output, "new GLB");
    if (mode === "source-change") await Bun.write(board, "(kicad_pcb changed)");
    if (mode === "failure") throw Error("export failed");
    return { fused: false, warnings: [] };
  } } });
  const registry = createRegistry(), factory = contextFactory(services, project);
  const run = () => registry.invoke("render_glb", {}, ref => factory({ def: registry.get("render_glb")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
  return { project, run, board, output };
}

test("GLB source receipt binds the newly exported bytes and explicitly leaves dependencies unverified", async () => {
  const { project, run, board, output } = await fixture("normal");
  try {
    await run();
    const receipt = BoardModelRevision.parse(JSON.parse(await readFile(join(project.dir, BOARD_MODEL_REVISION_PATH), "utf8")));
    expect(receipt.sourceSha256).toBe(await pcbPreviewFileHash(board));
    expect(receipt.artifactSha256).toBe(await pcbPreviewFileHash(output));
    expect(receipt.dependencies).toBe("unverified");
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});

for (const mode of ["source-change", "failure", "no-output"] as const) test(`${mode} keeps the previous model and receipt without certifying a new export`, async () => {
  const { project, run, output } = await fixture(mode);
  try {
    await Bun.write(output, "previous model");
    await Bun.write(join(project.dir, BOARD_MODEL_REVISION_PATH), "previous receipt");
    await expect(run()).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("previous model");
    expect(await readFile(join(project.dir, BOARD_MODEL_REVISION_PATH), "utf8")).toBe("previous receipt");
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});

test("imported root copy exports with the explicitly selected model directory without modifying sources", async () => {
  const project = await tempProject("imported-model-context"), origin = "versions/v4.1/board.kicad_pcb";
  await mkdir(join(project.dir, "versions/v4.1"), { recursive: true });
  await Bun.write(join(project.dir, origin), "original PCB");
  await Bun.write(join(project.dir, "board.kicad_pcb"), "edited working PCB");
  await project.updateManifest({ importedBoard: { path: origin, adoptedAt: new Date().toISOString(), pcbSha256: "a".repeat(64) } });
  const base = mockServices([project]), registry = createRegistry();
  const services = mockServices([project], { kicad: { ...base.kicad, exportGlb: async (_cli, options) => {
    expect(options.board).toBe(join(project.dir, "board.kicad_pcb"));
    expect(options.modelProjectDir).toBe(join(project.dir, "versions/v4.1"));
    await Bun.write(options.output, "model with imported dependencies");
    return { fused: false, warnings: ["Warning: one other model unavailable"] };
  } } });
  const factory = contextFactory(services, project);
  try {
    await registry.invoke("render_glb", {}, ref => factory({ def: registry.get("render_glb")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    const receipt = JSON.parse(await readFile(join(project.dir, BOARD_MODEL_REVISION_PATH), "utf8"));
    expect(receipt.modelProjectDirectory).toBe("versions/v4.1");
    expect(receipt.warnings).toEqual(expect.arrayContaining(["Warning: one other model unavailable"]));
    expect(await Bun.file(join(project.dir, origin)).text()).toBe("original PCB");
    expect(await Bun.file(join(project.dir, "board.kicad_pcb")).text()).toBe("edited working PCB");
    expect(receipt.sourceSha256).toBe(await pcbPreviewFileHash(join(project.dir, "board.kicad_pcb")));
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});

test("model downloads complete before dependency binding, and cache changes invalidate that receipt", async () => {
  const project = await tempProject("cached-model-receipt"), board = join(project.dir, "board.kicad_pcb");
  const declared = "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/FabDesk_Test_Part_0603.step";
  await Bun.write(board, `(kicad_pcb (footprint "R" (property "Reference" "R1") (model "${declared}")))`);
  const previousHome = process.env.FABDESK_HOME, previousModels = process.env.KICAD9_3DMODEL_DIR;
  const cacheHome = await mkdtemp(join(tmpdir(), "fabdesk-cache-receipt-"));
  process.env.FABDESK_HOME = cacheHome; process.env.KICAD9_3DMODEL_DIR = join(project.dir, "absent-library");
  const base = mockServices([project]); let downloads = 0;
  const services = mockServices([project], { kicad: { ...base.kicad,
    prepareModels: (cli, options) => prepareBoardModels(cli, { ...options, fetch: async () => { downloads++; return new Response("ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"); } }),
    exportGlb: async (_cli, options) => {
      expect(cachedStockModel(declared)).not.toBeNull();
      await Bun.write(options.output, "new geometry"); return { fused: false, warnings: [] };
    },
  } });
  const registry = createRegistry(), factory = contextFactory(services, project);
  try {
    await registry.invoke("render_glb", {}, ref => factory({ def: registry.get("render_glb")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    const receipt = JSON.parse(await readFile(join(project.dir, BOARD_MODEL_REVISION_PATH), "utf8"));
    expect(downloads).toBe(1);
    expect(receipt.dependencySnapshot.external).toHaveLength(1);
    expect(receipt.dependencySnapshot.revision).toBe((await snapshotProjectDependencies(project.dir)).revision);
    await Bun.write(cachedStockModel(declared, stockModelCacheRoot())!, "changed cache object");
    expect((await snapshotProjectDependencies(project.dir)).revision).not.toBe(receipt.dependencySnapshot.revision);
  } finally {
    if (previousHome === undefined) delete process.env.FABDESK_HOME; else process.env.FABDESK_HOME = previousHome;
    if (previousModels === undefined) delete process.env.KICAD9_3DMODEL_DIR; else process.env.KICAD9_3DMODEL_DIR = previousModels;
    await rm(cacheHome, { recursive: true, force: true });
    await rm(project.dir, { recursive: true, force: true });
  }
});

for (const mode of ["network-failure", "source-edit"] as const) test(`model preparation ${mode} preserves previous artifacts`, async () => {
  const project = await tempProject("model-preparation-race"), board = join(project.dir, "board.kicad_pcb"), output = join(project.dir, "renders/board.glb");
  await Bun.write(board, "(kicad_pcb)"); await Bun.write(output, "previous model");
  await Bun.write(join(project.dir, BOARD_MODEL_REVISION_PATH), "previous receipt");
  const base = mockServices([project]); let exports = 0;
  const services = mockServices([project], { kicad: { ...base.kicad,
    prepareModels: async () => { if (mode === "network-failure") throw Error("offline"); await Bun.write(board, "(kicad_pcb changed)"); return { warnings: [] }; },
    exportGlb: async () => { exports++; return { fused: false, warnings: [] }; },
  } });
  const registry = createRegistry(), factory = contextFactory(services, project);
  try {
    await expect(registry.invoke("render_glb", {}, ref => factory({ def: registry.get("render_glb")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow();
    expect(exports).toBe(0); expect(await readFile(output, "utf8")).toBe("previous model");
    expect(await readFile(join(project.dir, BOARD_MODEL_REVISION_PATH), "utf8")).toBe("previous receipt");
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});
