import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MECHANICAL_DESIGN_PATH } from "@fabdesk/protocol";
import { createRegistry, makeContext, type CadService } from "../src";
import { mockServices, tempProject } from "./mock-services";

type PreviewPlan = { input: string; output: string; maxBytes: number };
// A single open triangle intentionally is not a printable solid. Viewing must still work.
function openTriangle() {
  const mesh = Buffer.alloc(134);
  mesh.writeUInt32LE(1, 80);
  [0, 0, 1, 0, 0, 0, 20, 0, 0, 0, 10, 0].forEach((v, i) => mesh.writeFloatLE(v, 84 + i * 4));
  return mesh;
}

async function setup() {
  const project = await tempProject("step-preview");
  const services = mockServices([project]);
  const registry = createRegistry();
  const calls: Array<{ directory: string; script: string; plan: PreviewPlan }> = [];
  const released: string[] = [];
  const source = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
  await writeFile(join(project.dir, "case.step"), source);
  services.cad = {
    status: async () => ({ reachable: true }),
    python: async (directory: string, script: string) => {
      const encoded = script.match(/^p = json.loads\((.+)\)$/m)![1]!;
      const plan = JSON.parse(JSON.parse(encoded)) as PreviewPlan;
      calls.push({ directory, script, plan });
      await writeFile(plan.output, openTriangle());
      // The real CadService creates this document only in the disposable session.
      await writeFile(join(directory, "model.FCStd"), "temporary document");
      return { stdout: "", stderr: "" };
    },
    release: async (directory: string) => {
      expect(
        await stat(directory).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      released.push(directory);
    },
  } as CadService;
  const invoke = (args: Record<string, unknown> = {}) =>
    registry.invoke(
      "cad_fit",
      { project: project.id, action: "model_preview", sourcePath: "case.step", ...args },
      () => makeContext({ services, project }),
    );
  return { project, services, calls, released, source, invoke };
}

test("STEP preview accepts an open surface, isolates its CAD session, and preserves source and project model", async () => {
  const { project, calls, released, source, invoke } = await setup();
  await writeFile(join(project.dir, "model.FCStd"), "existing project model");
  // An unrelated broken enclosure draft must not prevent model viewing.
  await mkdir(dirname(join(project.dir, MECHANICAL_DESIGN_PATH)), { recursive: true });
  await writeFile(join(project.dir, MECHANICAL_DESIGN_PATH), "broken draft");
  const result = (await invoke()).json as { mesh: string; format: string };
  expect(result.format).toBe("stl");
  expect(Buffer.from(result.mesh, "base64")).toEqual(openTriangle());
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.directory).not.toBe(project.dir);
  expect(dirname(call.directory)).toBe(join(project.dir, ".fabdesk/model-preview"));
  expect(dirname(call.plan.input)).toBe(call.directory);
  expect(dirname(call.plan.output)).toBe(call.directory);
  expect(call.script).toContain("Part.read(p['input'])");
  expect(call.script).toContain("MeshPart.meshFromShape");
  expect(call.script).not.toContain("addObject");
  expect(released).toEqual([call.directory]);
  expect(await readdir(join(project.dir, ".fabdesk/model-preview"))).toEqual([]);
  expect(await readFile(join(project.dir, "case.step"), "utf8")).toBe(source);
  expect(await readFile(join(project.dir, "model.FCStd"), "utf8")).toBe("existing project model");
  expect(await readFile(join(project.dir, MECHANICAL_DESIGN_PATH), "utf8")).toBe("broken draft");
});

test("STEP preview rejects missing, unsupported, absolute and escaping source paths before conversion", async () => {
  const { invoke, calls, project } = await setup();
  for (const sourcePath of [
    undefined,
    "case.stl",
    join(project.dir, "case.step"),
    "../outside.step",
  ])
    await expect(invoke({ sourcePath })).rejects.toThrow();
  await expect(invoke({ sourcePath: "missing.step" })).rejects.toThrow("could not be found");
  expect(calls).toHaveLength(0);
});

test("STEP preview reports the missing native bridge clearly and never creates a scratch session", async () => {
  const { invoke, services, calls, project } = await setup();
  delete services.cad;
  await expect(invoke()).rejects.toThrow("FreeCAD bridge");
  services.cad = {
    status: async () => {
      throw new Error("offline");
    },
  } as unknown as CadService;
  await expect(invoke()).rejects.toThrow("FreeCAD bridge");
  expect(calls).toHaveLength(0);
  expect(await readdir(project.dir)).not.toContain(".fabdesk");
});

test("STEP preview releases and cleans up a failed conversion without changing its source", async () => {
  const { project, services, released, source, invoke } = await setup();
  services.cad!.python = async () => ({
    stdout: "",
    stderr: "",
    exception: "STEP reader could not read this file",
  });
  await expect(invoke()).rejects.toThrow("STEP reader could not read this file");
  expect(released).toHaveLength(1);
  expect(await readdir(join(project.dir, ".fabdesk/model-preview"))).toEqual([]);
  expect(await readFile(join(project.dir, "case.step"), "utf8")).toBe(source);
});

test("STEP preview bounds both source and result size and rejects malformed or nonfinite meshes", async () => {
  const { project, services, calls, released, invoke } = await setup();
  await truncate(join(project.dir, "case.step"), 50 * 1024 * 1024 + 1);
  await expect(invoke()).rejects.toThrow("50 MB");
  expect(calls).toHaveLength(0);
  await writeFile(join(project.dir, "case.step"), "source fixture");
  const convert = services.cad!.python;
  for (const output of ["oversize", "broken", "nonfinite", "missing"] as const) {
    services.cad!.python = async (directory, script, mode) => {
      const result = await convert(directory, script, mode);
      const plan = calls.at(-1)!.plan;
      if (output === "oversize") await truncate(plan.output, 50 * 1024 * 1024 + 1);
      else if (output === "broken") await writeFile(plan.output, "not an STL");
      else if (output === "nonfinite") {
        const mesh = openTriangle();
        mesh.writeFloatLE(Number.NaN, 100);
        await writeFile(plan.output, mesh);
      } else {
        // A valid-size empty file must not be mistaken for a model.
        await truncate(plan.output, 0);
      }
      return result;
    };
    await expect(invoke()).rejects.toThrow(
      output === "oversize"
        ? "50 MB"
        : output === "nonfinite"
          ? "invalid coordinates"
          : "unreadable",
    );
    expect(await readdir(join(project.dir, ".fabdesk/model-preview"))).toEqual([]);
  }
  expect(released).toHaveLength(4);
});
