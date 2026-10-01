import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRegistry,
  makeContext,
  toolsMarkdown,
  type CadObject,
  type CadService,
  type ProjectHandle,
  type ToolContext,
} from "../src";
import { mockServices, tempProject } from "./mock-services";

/** An in-memory stand-in for the FreeCAD session, recording what the tools asked for. */
function fakeCad() {
  const calls: string[] = [];
  const objects: CadObject[] = [];
  let pythonException: string | undefined;
  const cad: CadService & { calls: string[]; failPython(e: string): void } = {
    calls,
    failPython: (e) => {
      pythonException = e;
    },
    status: async () => ({
      bridgeUrl: "http://127.0.0.1:4030",
      reachable: true,
      detail: "1 session(s)",
      freecad: "FreeCADApiServer",
      ui: true,
    }),
    model: async (dir) => {
      calls.push("model");
      return {
        document: "Model",
        path: join(dir, "model.FCStd"),
        modified: false,
        objects,
        undo: [],
        redo: [],
      };
    },
    properties: async (_dir, object) => {
      calls.push(`properties ${object}`);
      return [
        {
          name: "Length",
          type: "App::PropertyLength",
          group: "Box",
          value: 40,
          unit: "mm",
          readOnly: false,
        },
      ];
    },
    addObject: async (_dir, input) => {
      calls.push(`add ${input.type} ${JSON.stringify(input.properties ?? {})}`);
      const o: CadObject = {
        name: input.name ?? "Box",
        label: input.label ?? input.name ?? "Box",
        type: input.type,
        status: "Touched",
        isError: false,
        visibility: true,
        children: [],
        parents: [],
      };
      objects.push(o);
      return o;
    },
    setProperties: async (_dir, object, values) => {
      calls.push(`set ${object} ${Object.keys(values).join(",")}`);
      return [];
    },
    setExpression: async (_dir, object, path, expression) => {
      calls.push(`expr ${object}.${path}=${expression}`);
    },
    removeObject: async (_dir, object, recursive) => {
      calls.push(`remove ${object} ${recursive}`);
    },
    recompute: async () => {
      calls.push("recompute");
      return { recomputed: objects.length, errors: [] };
    },
    undo: async (_dir, redo) => {
      calls.push(redo ? "redo" : "undo");
      return { undo: [], redo: ["Add Box"] };
    },
    save: async (dir) => {
      calls.push("save");
      return { path: join(dir, "model.FCStd") };
    },
    export: async (_dir, input) => {
      calls.push(`export ${input.format}`);
      return {
        data: new TextEncoder().encode("solid Box\nendsolid Box\n"),
        fileName: "Model.stl",
        objects: input.objects ?? ["Box"],
      };
    },
    python: async (_dir, code) => {
      calls.push(`python ${code}`);
      return {
        stdout: "hi\n",
        stderr: "",
        ...(pythonException ? { exception: pythonException } : { repr: "42" }),
      };
    },
    view: async () => ({
      bridgeUrl: "http://127.0.0.1:4030",
      session: "s1",
      wsUrl: "ws://127.0.0.1:4030/ws?session=s1",
      uiUrl: "http://127.0.0.1:4030/?ws=x",
      document: "Model",
    }),
    release: async () => {},
  };
  return cad;
}

async function setup(cad?: CadService) {
  const project: ProjectHandle = await tempProject("cad");
  const services = mockServices([project], cad ? { cad } : {});
  const registry = createRegistry();
  const ctx = (ref?: string): ToolContext =>
    makeContext({ services, project: ref ? project : null });
  const invoke = (name: string, args: Record<string, unknown> = {}) =>
    registry.invoke(name, { project: project.id, ...args }, (ref) => ctx(ref));
  return { registry, invoke, project };
}

describe("cad toolset", () => {
  test("registers under toolset cad and shows up in the AGENTS.md cheat-sheet", async () => {
    const { registry } = await setup();
    expect(registry.byToolset("cad").map((t) => t.name)).toEqual([
      "cad_status",
      "cad_model",
      "cad_properties",
      "cad_add_object",
      "cad_set_properties",
      "cad_remove_object",
      "cad_recompute",
      "cad_undo",
      "cad_export",
      "cad_python",
      "cad_view",
    ]);
    expect(registry.get("cad_python")!.annotations.openWorldHint).toBe(true);
    expect(toolsMarkdown(registry)).toContain("### cad — mechanical model in FreeCAD");
  });

  test("says how to get FreeCAD when the daemon has no CAD bridge", async () => {
    const { invoke } = await setup();
    await expect(invoke("cad_model")).rejects.toThrow(/dev:cad/);
  });

  test("editing tools recompute and save after the change", async () => {
    const cad = fakeCad();
    const { invoke } = await setup(cad);
    const out = await invoke("cad_add_object", {
      type: "Part::Box",
      name: "Lid",
      properties: { Length: "40 mm" },
    });
    expect(out.text).toContain("Added Lid (Part::Box");
    expect(cad.calls).toEqual(['add Part::Box {"Length":"40 mm"}', "recompute", "save"]);

    cad.calls.length = 0;
    await invoke("cad_set_properties", {
      object: "Lid",
      values: { Height: 2 },
      expressions: { Width: "Lid.Length / 2" },
    });
    expect(cad.calls).toEqual([
      "set Lid Height",
      "expr Lid.Width=Lid.Length / 2",
      "recompute",
      "save",
    ]);

    await expect(invoke("cad_set_properties", { object: "Lid" })).rejects.toThrow(/values/);
  });

  test("cad_model lists objects; cad_properties reads them", async () => {
    const cad = fakeCad();
    const { invoke } = await setup(cad);
    await invoke("cad_add_object", { type: "Part::Cylinder", name: "Boss" });
    const model = await invoke("cad_model");
    expect(model.text).toContain("| Boss | Boss | Part::Cylinder |");
    const props = await invoke("cad_properties", { object: "Boss" });
    expect(props.text).toContain("| Length | Box | Length | 40 |");
  });

  test("cad_export writes the file under exports/", async () => {
    const cad = fakeCad();
    const { invoke, project } = await setup(cad);
    const out = await invoke("cad_export", { format: "stl", name: "lid" });
    expect(out.text).toContain("exports/lid.stl");
    expect(await readFile(join(project.dir, "exports", "lid.stl"), "utf8")).toStartWith(
      "solid Box",
    );
    await expect(invoke("cad_export", { name: "../escape" })).rejects.toThrow();
  });

  test("cad_python reports output, and an exception as an error result", async () => {
    const cad = fakeCad();
    const { invoke } = await setup(cad);
    const ok = await invoke("cad_python", { code: "6*7" });
    expect(ok.text).toContain("=> 42");
    expect(ok.isError).toBeUndefined();
    cad.failPython("NameError: name 'x' is not defined");
    const bad = await invoke("cad_python", { code: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("NameError");
  });

  test("cad_view returns the web UI attached to the session", async () => {
    const { invoke } = await setup(fakeCad());
    const out = await invoke("cad_view");
    expect(out.text).toBe("CAD view: http://127.0.0.1:4030/?ws=x");
  });
});
