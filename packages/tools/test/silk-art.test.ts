import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encodePng } from "@fabdesk/board-art";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

function markPng(): Uint8Array {
  const w = 24;
  const h = 24;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ink = x > 4 && x < 10 && y > 4 && y < 20 || y > 10 && y < 14 && x > 4 && x < 20;
      const i = (y * w + x) * 4;
      const v = ink ? 20 : 240;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width: w, height: h, data });
}

describe("silk_art", () => {
  test("writes a KiCad board, gerbers and a zip from a sketch", async () => {
    const project = await tempProject("art");
    const sketches = join(project.dir, "sketches");
    await mkdir(sketches, { recursive: true });
    await Bun.write(join(sketches, "logo.png"), markPng());
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const reg = createRegistry();
    const out = await reg.invoke(
      "silk_art",
      { style: "poster", widthMm: 40, heightMm: 30, color: "black", outline: "rectangle" },
      (ref) =>
        factory({
          def: reg.get("silk_art")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("No AI credit spent");
    const json = out.json as { primitives: number; files: { zip: string; gerbers: string[] } };
    expect(json.primitives).toBeGreaterThan(0);
    expect(await Bun.file(join(project.dir, "board.kicad_pcb")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, "exports/fabrication.zip")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, "exports/gerbers/board-F_Silkscreen.gbr")).exists()).toBe(true);
    const silk = await Bun.file(join(project.dir, "exports/gerbers/board-F_Silkscreen.gbr")).text();
    expect(silk).toContain("%MOMM*%");
    expect(silk.trim().endsWith("M02*")).toBe(true);
    expect(project.manifest().board.widthMm).toBe(40);
    expect(out.images?.[0]?.mime).toBe("image/svg+xml");
  });

  test("rejects a missing image", async () => {
    const project = await tempProject("empty");
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const reg = createRegistry();
    await expect(
      reg.invoke("silk_art", {}, (ref) =>
        factory({
          def: reg.get("silk_art")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toMatchObject({ code: "precondition" });
  });
});
