import { describe, expect, test } from "bun:test";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const SAMPLE = join(import.meta.dir, "../../kicad/test/fixtures/stencil-sample.kicad_pcb");

describe("export_laser_stencil", () => {
  test("writes LightBurn job, SVG and DXF from the mylar-uv preset", async () => {
    const reg = createRegistry();
    const project = await tempProject("laser-stencil");
    await cp(SAMPLE, join(project.dir, "board.kicad_pcb"));
    const factory = contextFactory(mockServices([project]), project);
    const out = await reg.invoke("export_laser_stencil", {}, (ref) =>
      factory({
        def: reg.get("export_laser_stencil")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("2 aperture");
    expect(out.text).toContain("Mylar");
    expect(out.text).toContain("Starting-point");
    const json = out.json as { apertureCount: number; path: string; files: string[]; preset: string };
    expect(json.preset).toBe("mylar-uv");
    expect(json.apertureCount).toBe(2);
    expect(json.path).toContain("F-Paste-laser.lbrn2");
    expect(await Bun.file(join(project.dir, "exports/stencil/F-Paste-laser.lbrn2")).exists()).toBe(true);
    const svg = await Bun.file(join(project.dir, "exports/stencil/F-Paste-laser.svg")).text();
    expect(svg).toContain("mm");
    expect(svg).toContain("APERTURES");
    expect(await Bun.file(join(project.dir, "exports/stencil/F-Paste-laser.dxf")).exists()).toBe(true);
    const notes = await Bun.file(join(project.dir, "exports/stencil/F-Paste-laser-notes.md")).text();
    expect(notes).toContain("starting points");
    expect(notes).not.toContain("Four holes sit");
  });

  test("kapton and stainless presets plus a custom shrink override", async () => {
    const reg = createRegistry();
    const project = await tempProject("laser-stencil-ss");
    await cp(SAMPLE, join(project.dir, "board.kicad_pcb"));
    const factory = contextFactory(mockServices([project]), project);
    const kapton = await reg.invoke("export_laser_stencil", { preset: "kapton" }, (ref) =>
      factory({
        def: reg.get("export_laser_stencil")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(kapton.isError).toBeFalsy();
    expect((kapton.json as { preset: string }).preset).toBe("kapton");
    const out = await reg.invoke(
      "export_laser_stencil",
      { preset: "stainless-0.1", apertureOffsetMm: 0.08, powerPct: 90 },
      (ref) =>
        factory({
          def: reg.get("export_laser_stencil")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(out.isError).toBeFalsy();
    const json = out.json as {
      preset: string;
      apertureOffsetMm: number;
      apertureCount: number;
      job: { powerPct: number };
    };
    expect(json.preset).toBe("stainless-0.1");
    expect(json.apertureOffsetMm).toBe(0.08);
    expect(json.job.powerPct).toBe(90);
    expect(json.apertureCount).toBe(2);
  });

  test("maps an oversized alignment hole to invalid_args", async () => {
    const reg = createRegistry();
    const project = await tempProject("laser-stencil-hole");
    await cp(SAMPLE, join(project.dir, "board.kicad_pcb"));
    const factory = contextFactory(mockServices([project]), project);
    await expect(
      reg.invoke("export_laser_stencil", { alignmentHoleMm: 10 }, (ref) =>
        factory({
          def: reg.get("export_laser_stencil")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toMatchObject({ name: "ToolError", code: "invalid_args" });
  });

  test("fails without a board", async () => {
    const reg = createRegistry();
    const project = await tempProject("noboard-laser");
    const factory = contextFactory(mockServices([project]), project);
    await expect(
      reg.invoke("export_laser_stencil", {}, (ref) =>
        factory({
          def: reg.get("export_laser_stencil")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toThrow(/board.kicad_pcb not found/);
  });
});
