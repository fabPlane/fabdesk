import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeContext } from "../src";
import { displayCoverage, renderPcbDisplay } from "../src/tools/pcb-display";
import { mockServices, tempProject } from "./mock-services";

test("coverage uses loaded nodes, including multiple models and absent references", () => {
  const pcb = `(kicad_pcb
    (footprint "one" (property "Reference" "U1") (model "a.step"))
    (footprint "two" (property "Reference" "U2") (model "a.step") (model "b.step"))
    (footprint "none" (property "Reference" "J1"))
    (footprint "omitted" (property "Reference" "U3") (attr dnp)))`;
  const node = (name: string) => ({
    name,
    vertices: 3,
    origin: { x: 0, y: 0, z: 0 },
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
  });
  expect(displayCoverage(pcb, [node("U1"), node("U2")])).toEqual({
    total: 3,
    loaded: 1,
    missing: ["U2", "J1"],
  });
});

test("display export rejects stale PCB before export and changed PCB during export", async () => {
  const project = await tempProject("display"),
    services = mockServices([project]);
  const pcb = "(kicad_pcb (general (thickness 1.6)))";
  const path = join(project.dir, "board.kicad_pcb");
  await writeFile(path, pcb);
  const revision = createHash("sha256").update(pcb).digest("hex");
  let invoked = false;
  services.kicad.exportGlb = async (_cli, opts) => {
    invoked = true;
    expect(opts.mechanical).toBe(true);
    await writeFile(opts.output, "partial output");
    await writeFile(path, pcb + "\n");
    return { fused: false, warnings: [] };
  };
  const ctx = makeContext({ services, project });
  await expect(renderPcbDisplay(ctx, "board.kicad_pcb", "0".repeat(64))).rejects.toThrow(
    "PCB changed",
  );
  expect(invoked).toBe(false);
  await expect(renderPcbDisplay(ctx, "../escape.kicad_pcb", revision)).rejects.toThrow();
  await expect(renderPcbDisplay(ctx, "board.kicad_pcb", revision)).rejects.toThrow("during export");
  expect(await readdir(join(project.dir, "renders/pcb-models"))).toEqual([]);
  expect(await readFile(path, "utf8")).toBe(pcb + "\n");
});
