import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { BOARD_LAYERS_PATH, BoardLayers } from "@fabdesk/protocol";
import { boardPreviewLayers } from "@fabdesk/kicad";
import { createRegistry } from "../src";
import { pcbPreviewFileHash } from "../src/pcb-preview-revision";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const pcb = '(kicad_pcb (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) (49 "F.Fab" user)) (footprint "ignore (layers)" (layer "F.Cu")))';
test("layer stack comes from the board, including internal copper and excluding fabrication annotations", () => {
  expect(boardPreviewLayers(pcb)).toEqual(["F.Cu", "In1.Cu", "B.Cu", "Edge.Cuts"]);
});
for (const change of [false, true]) test(`layer preparation ${change ? "retains the previous preview when source changes" : "publishes all layers against one immutable source"}`, async () => {
  const project = await tempProject("board-layers");
  try {
    const path = join(project.dir, "board.kicad_pcb"), output = join(project.dir, BOARD_LAYERS_PATH);
    await Bun.write(path, pcb); await Bun.write(output, "previous");
    const expectedSourceSha256 = await pcbPreviewFileHash(path);
    const base = mockServices([project]);
    const seen: string[] = [];
    const services = mockServices([project], { kicad: { ...base.kicad, exportPcbSvg: async (_cli, opts) => {
      seen.push(opts.layers![0]!);
      expect(await readFile(opts.board, "utf8")).toBe(pcb);
      await Bun.write(opts.output, `<svg viewBox="0 0 10 10"><path id="${opts.layers![0]}" /></svg>`);
      if (change) await Bun.write(path, pcb + "\n");
    } } });
    const registry = createRegistry(), factory = contextFactory(services, project);
    const run = () => registry.invoke("render_board_layers", { expectedSourceSha256 }, ref => factory({ def: registry.get("render_board_layers")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    if (change) { await expect(run()).rejects.toThrow("PCB changed while preparing layers"); expect(await readFile(output, "utf8")).toBe("previous"); }
    else { await run(); const saved = BoardLayers.parse(JSON.parse(await readFile(output, "utf8"))); expect(saved.sourceSha256).toBe(expectedSourceSha256); expect(saved.layers.map(l => l.name)).toEqual(seen); expect(seen).toHaveLength(4); }
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});
