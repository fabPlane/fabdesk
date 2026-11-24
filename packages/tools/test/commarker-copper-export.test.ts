import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeContext, ToolRegistry } from "../src/registry";
import { export_commarker_copper } from "../src/tools/export";
import { mockServices, tempProject } from "./mock-services";

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const sample = join(import.meta.dir, "../../../docs/examples/omni-x-copper-coupon.kicad_pcb");

test("publishes revision-bound SVG and receipt for the selected PCB, preserves the previous export after a racing edit", async () => {
  const project = await tempProject("commarker");
  const boardPath = join(project.dir, "board.kicad_pcb");
  try {
    await cp(sample, boardPath);
    const source = await readFile(boardPath);
    const digest = hash(source);
    const selection = { sourceId: "io", manifestSha256: "b".repeat(64) };
    const services = mockServices([project]);
    const registry = new ToolRegistry([export_commarker_copper]);
    const run = (expectedSourceSha256: string) => registry.invoke("export_commarker_copper",
      { project: project.id, board: selection, expectedSourceSha256 },
      () => makeContext({ services, project, board: selection, runInScope: op => op() }));
    const native = process.env["FABPLANE_KICAD_CLI"];
    if (native) {
      services.kicad.resolveCli = async () => ({ path: native, version: "10.99.0" });
      services.kicad.copperRemovalArtwork = (await import("@fabdesk/kicad")).copperRemovalArtwork;
    }
    const first = await run(digest);
    const relativePath = `exports/commarker/copper-${digest}.svg`, path = join(project.dir, relativePath);
    const svg = await readFile(path);
    expect(first.json).toMatchObject({ relativePath, path, sourceSha256: digest, svgSha256: hash(svg), widthMm: 20, heightMm: 12 });
    expect(await Bun.file(`${path}.revision.json`).json()).toMatchObject({
      artifact: relativePath, artifactSha256: hash(svg), board: selection, inputs: [{ path: "board.kicad_pcb", sha256: digest }],
    });
    const original = services.kicad.copperRemovalArtwork;
    services.kicad.copperRemovalArtwork = async (...args) => {
      await writeFile(boardPath, Buffer.concat([source, Buffer.from("\n")]));
      return original(...args);
    };
    await expect(run(digest)).rejects.toThrow("PCB changed while exporting");
    await expect(run(digest)).rejects.toThrow("PCB changed before export");
    expect(await readFile(path)).toEqual(svg);
    expect(await readdir(join(project.dir, "exports/commarker"))).toHaveLength(2);
  } finally {
    await rm(project.dir, { recursive: true, force: true });
  }
});
