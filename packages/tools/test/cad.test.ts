import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
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
      "cad_kernels",
      "cad_build_part",
      "cad_combine_parts",
      "cad_enclosure",
      "cad_fit",
    ]);
    expect(registry.get("cad_python")!.annotations.openWorldHint).toBe(true);
    expect(toolsMarkdown(registry)).toContain("### cad — mechanical model (OpenCascade");
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
    expect(out.text).toContain("OpenCascade / FreeCAD");
    expect(cad.calls).toEqual(['add Part::Box {"Length":"40 mm"}', "recompute", "save"]);

    await expect(
      invoke("cad_add_object", { type: "Part::Box", name: "Bad", kernel: "smlib" }),
    ).rejects.toThrow(/cad_build_part/);

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

const ENCLOSURE_BOARD = `(kicad_pcb
  (version 20260831)
  (general (thickness 1.6))
  (gr_rect (start 0 0) (end 40 20) (layer "Edge.Cuts"))
  (footprint "MountingHole:MountingHole_2.2mm"
    (layer "F.Cu") (at 3 3)
    (property "Reference" "H1" (at 0 0) (layer "F.SilkS"))
    (pad "" npth circle (at 0 0) (size 2.2 2.2) (drill 2.2) (layers "*.Cu" "*.Mask")))
  (footprint "Connector_USB:USB_C_Receptacle"
    (layer "F.Cu") (at 20 0)
    (property "Reference" "J1" (at 0 0) (layer "F.SilkS"))
    (fp_rect (start -4 -3) (end 4 3) (layer "F.CrtYd"))
    (pad "A1" smd rect (at 0 0) (size 0.3 1.5) (layers "F.Cu")))
)
`;

describe("cad_enclosure", () => {
  test("3D preview does not write files or touch FreeCAD; apply rejects a changed board", async () => {
    const cad = fakeCad();
    const { invoke, project } = await setup(cad);
    await writeFile(join(project.dir, "board.kicad_pcb"), ENCLOSURE_BOARD);
    await writeFile(join(project.dir, "enclosure.json"), "existing specification");
    const preview = await invoke("cad_enclosure", { action: "preview", wallMm: 3, clearanceMm: 2 });
    const json = preview.json as {
      previewOnly: boolean;
      pcbRevision: string;
      meshes: { base: string; lid: string };
      params: { wallMm: number };
    };
    expect(json.previewOnly).toBe(true);
    expect(json.meshes.base).toStartWith("solid fabplane_enclosure_base");
    expect(json.meshes.lid).toContain("facet normal");
    expect(json.params.wallMm).toBe(3);
    expect(await readFile(join(project.dir, "enclosure.json"), "utf8")).toBe(
      "existing specification",
    );
    await expect(readFile(join(project.dir, "exports", "enclosure.stl"))).rejects.toThrow();
    expect(cad.calls).toHaveLength(0);
    await writeFile(
      join(project.dir, "board.kicad_pcb"),
      ENCLOSURE_BOARD.replace("(end 40 20)", "(end 45 20)"),
    );
    await expect(
      invoke("cad_enclosure", { action: "generate", expectedBoardRevision: json.pcbRevision }),
    ).rejects.toThrow(/board changed/);
    expect(await readFile(join(project.dir, "enclosure.json"), "utf8")).toBe(
      "existing specification",
    );
  });
  test("generates STL/STEP without FreeCAD and checks alignment after a board move", async () => {
    const { invoke, project } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), ENCLOSURE_BOARD);
    const generated = await invoke("cad_enclosure", { action: "generate", applyToCad: false });
    expect(generated.text).toContain("in sync");
    expect(generated.text).toContain("enclosure.stl");
    const json = generated.json as { stl: string; step: string; alignment: { ok: boolean } };
    expect(json.alignment.ok).toBe(true);
    expect(await readFile(join(project.dir, json.stl), "utf8")).toStartWith(
      "solid fabplane_enclosure_base",
    );
    expect(await readFile(join(project.dir, json.step), "utf8")).toContain("ISO-10303-21;");

    const status = await invoke("cad_enclosure", { action: "status" });
    expect((status.json as { alignment: { stale: boolean } }).alignment.stale).toBe(false);

    await writeFile(
      join(project.dir, "board.kicad_pcb"),
      ENCLOSURE_BOARD.replace("(at 20 0)", "(at 28 0)"),
    );
    const check = await invoke("cad_enclosure", { action: "check" });
    expect(check.isError).toBe(true);
    expect(check.text).toContain("stale");
    expect((check.json as { alignment: { ok: boolean } }).alignment.ok).toBe(false);

    const again = await invoke("cad_enclosure", { action: "generate", applyToCad: false });
    expect(again.isError).toBeUndefined();
    expect(
      (again.json as { cutouts: Array<{ ref: string; center: { x: number } }> }).cutouts[0]!.center
        .x,
    ).toBe(28);
  });

  test("mirrors primitives into FreeCAD when a CAD service is present", async () => {
    const cad = fakeCad();
    const { invoke, project } = await setup(cad);
    await writeFile(join(project.dir, "board.kicad_pcb"), ENCLOSURE_BOARD);
    const out = await invoke("cad_enclosure", { action: "generate" });
    expect((out.json as { appliedToCad: boolean }).appliedToCad).toBe(true);
    expect(cad.calls.some((c) => c.startsWith("add App::DocumentObjectGroup"))).toBe(true);
    expect(cad.calls.some((c) => c.startsWith("add Part::Box"))).toBe(true);
    expect(cad.calls.some((c) => c.startsWith("python ") && c.includes("face.extrude") && c.includes("profile['rings']"))).toBe(true);
    const spec = JSON.parse(await readFile(join(project.dir, "enclosure.json"), "utf8")) as {
      standoffs: Array<{ innerDiameterMm: number; outerDiameterMm: number }>;
    };
    expect(spec.standoffs.length).toBeGreaterThan(0);
    const cylinders = cad.calls.filter((c) => c.startsWith("add Part::Cylinder"));
    const cuts = cad.calls.filter((c) => c.startsWith("add Part::Cut"));
    expect(cylinders).toHaveLength(2 * spec.standoffs.length);
    expect(cuts).toHaveLength(spec.standoffs.length);
    for (const st of spec.standoffs) {
      expect(cylinders.some((c) => c.includes(`"Radius":${st.outerDiameterMm / 2},`))).toBe(true);
      expect(cylinders.some((c) => c.includes(`"Radius":${st.innerDiameterMm / 2},`))).toBe(true);
    }
    expect(cuts[0]).toContain('"Base":{"$type":"Object","doc":"Model","name":"EnclosureStandoff_');
    expect(cuts[0]).toMatch(
      /"Tool":\{"\$type":"Object","doc":"Model","name":"EnclosureStandoff_\w+_Bore"\}/,
    );
    expect(cad.calls).toContain("recompute");
    expect(cad.calls).toContain("save");
  });

  test("v2 writes offset, vents, snap-fits, preview and STL/STEP", async () => {
    const { invoke, project } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), ENCLOSURE_BOARD);
    const generated = await invoke("cad_enclosure", {
      action: "generate",
      applyToCad: false,
      outlineOffsetMm: 2,
      clearanceMm: 1.5,
      ventPattern: "grid",
      ventFaces: "lid",
      snapFit: true,
      snapCount: 2,
    });
    const json = generated.json as {
      preview: string;
      stl: string;
      step: string;
      previewSvg: string;
      vents: number;
      clips: number;
      params: {
        outlineOffsetMm: number;
        clearanceMm: number;
        ventPattern: string;
        snapFit: boolean;
      };
      outerMm: { width: number };
    };
    expect(json.params.outlineOffsetMm).toBe(2);
    expect(json.params.clearanceMm).toBe(1.5);
    expect(json.params.ventPattern).toBe("grid");
    expect(json.params.snapFit).toBe(true);
    expect(json.vents).toBeGreaterThan(0);
    expect(json.clips).toBeGreaterThan(0);
    expect(json.previewSvg).toContain("enclosure-preview-svg");
    expect(generated.text).toContain("snap-fit");
    const preview = await readFile(join(project.dir, json.preview), "utf8");
    expect(preview).toContain("<svg");
    expect(await readFile(join(project.dir, json.stl), "utf8")).toStartWith(
      "solid fabplane_enclosure_base",
    );
    expect(await readFile(join(project.dir, json.step), "utf8")).toContain("ISO-10303-21;");
    expect(json.outerMm.width).toBeCloseTo(40 + 2 * (1.5 + 2) + 2 * 2, 4);
    const status = await invoke("cad_enclosure", { action: "status" });
    expect((status.json as { preview?: string; previewSvg?: string }).preview).toBe(json.preview);
    expect((status.json as { previewSvg?: string }).previewSvg).toBeUndefined();
  });

  test("status without a spec lists board features", async () => {
    const { invoke, project } = await setup();
    await writeFile(join(project.dir, "board.kicad_pcb"), ENCLOSURE_BOARD);
    const out = await invoke("cad_enclosure", { action: "status" });
    expect(out.text).toContain("No enclosure yet");
    expect((out.json as { exists: boolean; features: { holes: number } }).features.holes).toBe(1);
  });

  test("status on a project without a board is not an error", async () => {
    const { invoke } = await setup();
    const out = await invoke("cad_enclosure", { action: "status" });
    expect(out.isError).toBeUndefined();
    expect(out.text).toMatch(/no board\.kicad_pcb/i);
    expect((out.json as { exists: boolean; noBoard: boolean }).exists).toBe(false);
    expect((out.json as { noBoard: boolean }).noBoard).toBe(true);
  });
});
