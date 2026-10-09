import { describe, expect, test } from "bun:test";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const SAMPLE = join(import.meta.dir, "../../kicad/test/fixtures/stencil-sample.kicad_pcb");

describe("export_stencil", () => {
  test("writes a binary STL and summary from the fixture board", async () => {
    const reg = createRegistry();
    const project = await tempProject("stencil");
    await cp(SAMPLE, join(project.dir, "board.kicad_pcb"));
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const out = await reg.invoke("export_stencil", {}, (ref) =>
      factory({
        def: reg.get("export_stencil")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("2 aperture");
    expect(out.text).toContain("pitch 0.40 mm");
    const json = out.json as { apertureCount: number; path: string; files: string[] };
    expect(json.apertureCount).toBe(2);
    expect(json.path).toContain("F-Paste.stl");
    const stl = new Uint8Array(await Bun.file(json.path).arrayBuffer());
    expect(stl.length).toBeGreaterThan(84);
    const count = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
    expect(stl.length).toBe(84 + count * 50);
    expect(await Bun.file(join(project.dir, "exports/stencil/F-Paste.md")).exists()).toBe(true);
  });

  test("fails without a board", async () => {
    const reg = createRegistry();
    const project = await tempProject("noboard");
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    await expect(
      reg.invoke("export_stencil", {}, (ref) =>
        factory({
          def: reg.get("export_stencil")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toThrow(/board.kicad_pcb not found/);
  });
});
