import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { componentModelEnvironment } from "../src/cli";
import { resolveModelPath } from "../src/mechanical";

const temporary: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "fabdesk-stock-models-"));
  temporary.push(root);
  return root;
}
function library(path: string) {
  mkdirSync(join(path, "Connector.3dshapes"), { recursive: true });
  writeFileSync(join(path, "Connector.3dshapes", "USB.step"), "stock model fixture");
  return path;
}
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reuse component model libraries", () => {
  for (const relative of [
    "share/kicad/3dmodels",
    "KiCad.app/Contents/SharedSupport/3dmodels",
    "Contents/SharedSupport/3dmodels",
    "kicad-cli/share/kicad/3dmodels",
    "kicad-cli/KiCad.app/Contents/SharedSupport/3dmodels",
  ]) {
    test(`finds bundled ${relative} without manual model variables`, () => {
      const root = workspace(), models = library(join(root, relative));
      const env = componentModelEnvironment({ FABDESK_BUNDLED_KICAD: root });
      for (const version of [6, 7, 8, 9, 10, 11]) expect(env[`KICAD${version}_3DMODEL_DIR`]).toBe(models);
      expect(resolveModelPath("${KICAD9_3DMODEL_DIR}/Connector.3dshapes/USB.step", root, env).path)
        .toBe(join(models, "Connector.3dshapes", "USB.step"));
    });
  }

  test("reuses the PCB backend library when the renderer bundle has none", () => {
    const root = workspace(), models = library(join(root, "pcb/kicad/share/kicad/3dmodels"));
    expect(componentModelEnvironment({ FABDESK_RESOURCES: root }).KICAD10_3DMODEL_DIR).toBe(models);
  });

  test("prefers the existing renderer bundle over a second backend library", () => {
    const root = workspace(), models = library(join(root, "kicad/share/kicad/3dmodels"));
    library(join(root, "pcb/kicad/share/kicad/3dmodels"));
    expect(componentModelEnvironment({ FABDESK_RESOURCES: root }).KICAD10_3DMODEL_DIR).toBe(models);
  });

  test("honors the backend's declared macOS stock-data root", () => {
    const root = workspace(), stock = join(root, "KiCad.app/Contents/SharedSupport");
    const models = library(join(stock, "3dmodels"));
    expect(componentModelEnvironment({ KICAD_STOCK_DATA_HOME: stock }).KICAD10_3DMODEL_DIR).toBe(models);
  });

  for (const [cli, relative] of [
    ["bin/kicad-cli.exe", "share/kicad/3dmodels"],
    ["kicad-cli", "share/kicad/3dmodels"],
    ["KiCad.app/Contents/MacOS/kicad-cli", "KiCad.app/Contents/SharedSupport/3dmodels"],
  ] as const) {
    test(`reuses models beside selected CLI ${cli}`, () => {
      const root = workspace(), models = library(join(root, relative));
      expect(componentModelEnvironment({}, join(root, cli)).KICAD10_3DMODEL_DIR).toBe(models);
    });
  }

  test.skipIf(process.platform !== "win32")("discovers an existing per-user Windows KiCad library", () => {
    const root = workspace();
    const models = library(join(root, "Programs/KiCad/10.0/share/kicad/3dmodels"));
    expect(componentModelEnvironment({ LOCALAPPDATA: root }).KICAD10_3DMODEL_DIR).toBe(models);
  });

  test("keeps explicit version overrides and project-local models unchanged", () => {
    const root = workspace(), models = library(join(root, "stock"));
    const custom = join(root, "project/models/USB.step");
    mkdirSync(dirname(custom), { recursive: true });
    writeFileSync(custom, "custom connector geometry");
    const input = { FABDESK_KICAD_MODELS: models, KICAD9_3DMODEL_DIR: join(root, "explicit-missing"), CUSTOM_LIBRARY: "keep" };
    const env = componentModelEnvironment(input);
    expect(env.KICAD9_3DMODEL_DIR).toBe(input.KICAD9_3DMODEL_DIR);
    expect(env.KICAD10_3DMODEL_DIR).toBe(models);
    expect(env.CUSTOM_LIBRARY).toBe("keep");
    expect(input).not.toHaveProperty("KICAD10_3DMODEL_DIR");
    expect(resolveModelPath("${KIPRJMOD}/models/USB.step", join(root, "project"), env).path).toBe(custom);
    expect(readFileSync(custom, "utf8")).toBe("custom connector geometry");
    expect(resolveModelPath("${KICAD9_3DMODEL_DIR}/Connector.3dshapes/USB.step", root, env).status).toBe("file-not-found");
  });

  test("reports an absent exact model instead of substituting a different connector", () => {
    const root = workspace(), models = library(join(root, "share/kicad/3dmodels"));
    const env = componentModelEnvironment({ FABDESK_BUNDLED_KICAD: root });
    expect(resolveModelPath("${KICAD10_3DMODEL_DIR}/Connector.3dshapes/USB-C.step", root, env))
      .toMatchObject({ status: "file-not-found", path: join(models, "Connector.3dshapes", "USB-C.step"), substitutionCandidates: [] });
  });
});
