import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildBoxGlb, buildBoxStl } from "@fabdesk/product-video";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

describe("render_product_video", () => {
  test("writes a GIF and poster from a fixture board + enclosure", async () => {
    const project = await tempProject("video");
    await mkdir(join(project.dir, "renders"), { recursive: true });
    await mkdir(join(project.dir, "exports"), { recursive: true });
    await writeFile(join(project.dir, "renders", "board.glb"), buildBoxGlb());
    await writeFile(join(project.dir, "exports", "enclosure.stl"), buildBoxStl());
    const registry = createRegistry();
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const out = await registry.invoke(
      "render_product_video",
      {
        preset: "orbit",
        durationSec: 2,
        fps: 8,
        formats: ["gif"],
        width: 160,
        height: 90,
        captions: true,
      },
      (ref) =>
        factory({
          def: registry.get("render_product_video")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("product-video.gif");
    const gif = join(project.dir, "exports", "product-video.gif");
    const poster = join(project.dir, "exports", "product-video-poster.png");
    expect(await Bun.file(gif).exists()).toBe(true);
    expect(await Bun.file(poster).exists()).toBe(true);
    expect(new TextDecoder().decode((await Bun.file(gif).arrayBuffer()).slice(0, 6))).toBe("GIF89a");
    const json = out.json as { frameCount: number; parts: Array<{ role: string }>; files: { gif?: string } };
    expect(json.frameCount).toBe(16);
    expect(json.parts.map((p) => p.role).sort()).toEqual(["board", "mechanical"]);
    expect(out.images?.some((img) => img.mime === "image/png")).toBe(true);
  });

  test("video refresh uses PCB bytes despite older timestamps and then reuses the guarded model receipt", async () => {
    const project = await tempProject("video-byte-freshness");
    await mkdir(join(project.dir, "renders"), { recursive: true });
    const model = buildBoxGlb(), hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    await writeFile(join(project.dir, "board.kicad_pcb"), "new-board");
    await utimes(join(project.dir, "board.kicad_pcb"), new Date(0), new Date(0));
    await writeFile(join(project.dir, "renders/board.glb"), model);
    await writeFile(join(project.dir, "renders/board.glb.revision.json"), JSON.stringify({ contract: "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact: "renders/board.glb", sourceSha256: hash("old-board"), artifactSha256: hash(model), generatedAt: new Date().toISOString(), dependencies: "unverified" }));
    const registry = createRegistry(), services = mockServices([project]), factory = contextFactory(services, project);
    let exports = 0;
    services.kicad.exportGlb = async (_cli, options) => { exports++; await writeFile(options.output, model); return { fused: false, warnings: [] }; };
    const invoke = () => registry.invoke("render_product_video", { formats: ["gif"], width: 80, height: 64, durationSec: 2, fps: 8 }, ref => factory({ def: registry.get("render_product_video")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect((await invoke()).isError).toBeFalsy();
    expect(exports).toBe(1);
    const receipt = JSON.parse(await readFile(join(project.dir, "renders/board.glb.revision.json"), "utf8"));
    expect(receipt.sourceSha256).toBe(hash("new-board"));
    expect(receipt.artifactSha256).toBe(hash(model));
    await invoke();
    expect(exports).toBe(1);
  });

  test("PCB changing during the reused GLB exporter preserves prior model and video", async () => {
    const project = await tempProject("video-changing-pcb");
    await mkdir(join(project.dir, "renders"), { recursive: true });
    await mkdir(join(project.dir, "exports"), { recursive: true });
    await writeFile(join(project.dir, "board.kicad_pcb"), "board-a");
    await writeFile(join(project.dir, "renders/board.glb"), "prior-model");
    await writeFile(join(project.dir, "exports/product-video.gif"), "prior-video");
    const registry = createRegistry(), services = mockServices([project]), factory = contextFactory(services, project);
    services.kicad.exportGlb = async (_cli, options) => { await writeFile(options.output, buildBoxGlb()); await writeFile(join(project.dir, "board.kicad_pcb"), "board-b"); return { fused: false, warnings: [] }; };
    await expect(registry.invoke("render_product_video", { formats: ["gif"], width: 80, height: 64, durationSec: 2, fps: 8 }, ref => factory({ def: registry.get("render_product_video")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow("PCB changed while exporting");
    expect(await readFile(join(project.dir, "renders/board.glb"), "utf8")).toBe("prior-model");
    expect(await readFile(join(project.dir, "exports/product-video.gif"), "utf8")).toBe("prior-video");
  });

  test("fails closed when the project has no meshes", async () => {
    const project = await tempProject("empty-video");
    const registry = createRegistry();
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    await expect(
      registry.invoke(
        "render_product_video",
        { formats: ["gif"], width: 80, height: 64, durationSec: 2, fps: 8 },
        (ref) =>
          factory({
            def: registry.get("render_product_video")!,
            projectRef: ref,
            signal: new AbortController().signal,
            progress: () => {},
          }),
      ),
    ).rejects.toThrow(/no 3D meshes/);
  });
});
