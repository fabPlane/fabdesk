import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { PCB_PREVIEW_REVISION_PATH, PcbPreviewRevision } from "@fabdesk/protocol";
import { createRegistry } from "../src";
import { pcbPreviewFileHash } from "../src/pcb-preview-revision";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function fixture(changeWhileRendering = false) {
  const project = await tempProject("pcb-preview-revision");
  await Bun.write(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
  const base = mockServices([project]);
  const services = mockServices([project], { kicad: { ...base.kicad, exportPcbSvg: async (_cli, options) => {
    await Bun.write(options.output, '<svg viewBox="0 0 10 10"></svg>');
    if (changeWhileRendering) await Bun.write(join(project.dir, "board.kicad_pcb"), "(kicad_pcb changed)");
  } } });
  const registry = createRegistry(), factory = contextFactory(services, project);
  const run = (args: Record<string, unknown> = {}) => registry.invoke("render_pcb_svg", args, (ref) => factory({ def: registry.get("render_pcb_svg")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
  return { project, run };
}
test("PCB rendering writes an atomic receipt bound to the source and final SVG bytes", async () => {
  const { project, run } = await fixture();
  try {
    await run();
    const receipt = PcbPreviewRevision.parse(JSON.parse(await readFile(join(project.dir, PCB_PREVIEW_REVISION_PATH), "utf8")));
    expect(receipt.sourceSha256).toBe(await pcbPreviewFileHash(join(project.dir, "board.kicad_pcb")));
    expect(receipt.artifactSha256).toBe(await pcbPreviewFileHash(join(project.dir, "renders/pcb.svg")));
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});
test("a PCB edited during generation cannot receive a fresh receipt", async () => {
  const { project, run } = await fixture(true);
  try {
    await Bun.write(join(project.dir, "renders/pcb.svg"), "previous SVG");
    await expect(run()).rejects.toThrow("PCB changed while rendering");
    expect(await Bun.file(join(project.dir, PCB_PREVIEW_REVISION_PATH)).exists()).toBe(false);
    expect(await readFile(join(project.dir, "renders/pcb.svg"), "utf8")).toBe("previous SVG");
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});

test("queued previews reject changed saved bytes and retain both prior artifact and receipt", async () => {
  const { project, run } = await fixture();
  try {
    await run();
    const hash = await pcbPreviewFileHash(join(project.dir, "board.kicad_pcb"));
    const svg = await readFile(join(project.dir, "renders/pcb.svg"), "utf8"), receipt = await readFile(join(project.dir, PCB_PREVIEW_REVISION_PATH), "utf8");
    await Bun.write(join(project.dir, "board.kicad_pcb"), "(kicad_pcb changed)");
    await expect(run({ expectedSourceSha256: hash })).rejects.toThrow("PCB changed before preview rendering");
    expect(await readFile(join(project.dir, "renders/pcb.svg"), "utf8")).toBe(svg);
    expect(await readFile(join(project.dir, PCB_PREVIEW_REVISION_PATH), "utf8")).toBe(receipt);
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});
