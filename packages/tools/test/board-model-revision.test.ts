import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { BOARD_MODEL_REVISION_PATH, BoardModelRevision } from "@fabdesk/protocol";
import { createRegistry } from "../src";
import { pcbPreviewFileHash } from "../src/pcb-preview-revision";
import { contextFactory, mockServices, tempProject } from "./mock-services";

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
