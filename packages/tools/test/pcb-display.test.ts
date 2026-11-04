import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeContext } from "../src";
import {
  displayCoverage,
  renderPcbDisplay,
  pcbCreatorVersion,
  pcbModelReadiness,
} from "../src/tools/pcb-display";
import { kicadVersionAtLeast } from "@fabdesk/kicad";
import { mockServices, tempProject } from "./mock-services";

test("setup version comparison handles nightly and stable versions without patch false alarms", () => {
  expect(pcbCreatorVersion('(kicad_pcb\n (version 20260901)\n (generator_version "10.99")')).toBe(
    "10.99",
  );
  expect(pcbCreatorVersion("(kicad_pcb (version 20260901))")).toBeNull();
  expect(kicadVersionAtLeast("10.0.0", "10.0.5")).toBe(true);
  expect(kicadVersionAtLeast("10.0.1", "10.99")).toBe(false);
  expect(kicadVersionAtLeast("11.0.0", "10.99")).toBe(true);
  expect(kicadVersionAtLeast("unknown", "10.99")).toBe(false);
});
test("readiness is read-only and rejects paths outside the project", async () => {
  const project = await tempProject("readiness"),
    services = mockServices([project]);
  services.kicad.resolveCli = async () => ({ path: "test-cli", version: "10.99" });
  const text = '(kicad_pcb\n (generator_version "10.0")\n)';
  await writeFile(join(project.dir, "board.kicad_pcb"), text);
  const ctx = makeContext({ services, project });
  const result = await pcbModelReadiness(ctx, ["board.kicad_pcb"]);
  expect(result.json).toMatchObject({
    needsSetup: false,
    suggested: null,
    boards: [{ path: "board.kicad_pcb", savedWith: "10.0", newer: false }],
  });
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(text);
  await expect(pcbModelReadiness(ctx, ["../escape.kicad_pcb"])).rejects.toThrow();
});

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
  expect(displayCoverage(pcb, [node("U1"), node("U2")])).toMatchObject({
    total: 3,
    loaded: 1,
    missing: ["U2", "J1"],
    details: [
      { ref: "U2", reason: "partial", models: ["a.step", "b.step"] },
      { ref: "J1", reason: "unassigned", models: [] },
    ],
  });
});
test("bare mounting holes and fiducials are not missing component bodies", () => {
  expect(
    displayCoverage(
      '(kicad_pcb (footprint "MountingHole:3mm" (property "Reference" "H1")) (footprint "Fiducial" (property "Reference" "FID1")))',
      [],
    ),
  ).toEqual({ total: 0, loaded: 0, missing: [], details: [] });
});

test("hidden-only and unloaded linked models never count as loaded geometry", () => {
  const result = displayCoverage(
    `(kicad_pcb
    (footprint "HiddenConnector" (property "Reference" "J1") (model "hidden.step" (hide yes)))
    (footprint "MissingChip" (property "Reference" "U1") (model "absent.step"))
    (footprint "NoReference" (model "a.step")))`,
    [],
  );
  expect(result.loaded).toBe(0);
  expect(result.missing).toEqual(["J1", "U1", "NoReference"]);
  expect(result.details.map((d) => d.reason)).toEqual(["hidden", "not-loaded", "not-loaded"]);
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
