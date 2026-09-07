/**
 * `BoardSettings.source`: a board the FabPlane PCB compiler wrote is the truth. `boardIsStale`
 * must not ask for a regeneration from circuit.json, `kicad_convert` must refuse to overwrite it,
 * and `circuit_build` records the ownership the compiler reports.
 */
import { describe, expect, test } from "bun:test";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boardIsStale, circuit_build } from "../src/tools/core";
import { convertProject } from "../src/tools/kicad";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const ctxFor = async (
  services: ReturnType<typeof mockServices>,
  project: Awaited<ReturnType<typeof tempProject>>,
) =>
  contextFactory(services, project)({ signal: new AbortController().signal, progress: () => {} });

describe("board source", () => {
  test("a KiCad-owned board is never stale, however new circuit.json is", async () => {
    const project = await tempProject("owned");
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    await utimes(join(project.dir, "board.kicad_pcb"), new Date(0), new Date(0));
    await writeFile(join(project.dir, "circuit.json"), "[]");

    expect(await boardIsStale(project)).toBe(true);
    await project.updateManifest({ board: { ...project.manifest().board, source: "kicad" } });
    expect(await boardIsStale(project)).toBe(false);
  });

  test("a missing board is stale whoever owns it", async () => {
    const project = await tempProject("missing");
    await project.updateManifest({ board: { ...project.manifest().board, source: "kicad" } });
    expect(await boardIsStale(project)).toBe(true);
  });

  test("kicad_convert refuses to overwrite a KiCad-owned board", async () => {
    const project = await tempProject("convert");
    await project.updateManifest({ board: { ...project.manifest().board, source: "kicad" } });
    const ctx = await ctxFor(mockServices([project]), project);
    await expect(convertProject(ctx)).rejects.toMatchObject({
      code: "precondition",
      message: expect.stringContaining("source of truth"),
    });
  });

  test("circuit_build records the compiler's board ownership on success only", async () => {
    const project = await tempProject("build");
    const services = mockServices([project]);
    const base = services.tscircuit.buildCircuit;
    services.tscircuit.buildCircuit = async (o) => ({ ...(await base(o)), boardSource: "kicad" });

    await circuit_build.handler({}, await ctxFor(services, project));
    expect(project.manifest().board.source).toBe("kicad");

    await writeFile(join(project.dir, "circuit.tsx"), "BROKEN");
    services.tscircuit.buildCircuit = async (o) => ({
      ...(await base(o)),
      boardSource: "tscircuit",
    });
    await circuit_build.handler({}, await ctxFor(services, project));
    expect(project.manifest().board.source).toBe("kicad");
  });
});
