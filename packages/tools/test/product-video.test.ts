import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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
