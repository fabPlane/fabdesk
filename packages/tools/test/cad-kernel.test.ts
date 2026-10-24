import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CadFeatureError,
  CadKernelUnavailableError,
  combineStepTexts,
  translateStepData,
  createCadKernelHost,
  createOpenCascadeKernel,
  createSmlibKernel,
  experimentalCadKernelsEnabled,
  probeSmlib,
  isStepText,
  maxStepEntityId,
  remapStepEntityIds,
  selectCadKernel,
  type CadPartSpec,
  type CadService,
} from "../src";
import { createFakeKernel } from "../src/cad-kernel/fake";
import { createRegistry, makeContext, type ProjectHandle } from "../src";
import { mockServices, tempProject } from "./mock-services";

const box: CadPartSpec["features"] = [{ kind: "box", lengthMm: 40, widthMm: 20, heightMm: 10 }];
const filleted: CadPartSpec["features"] = [
  { kind: "box", lengthMm: 40, widthMm: 20, heightMm: 10 },
  { kind: "fillet", radiusMm: 2, continuity: "G2" },
];

function spec(id: string, features: CadPartSpec["features"], extra: Partial<CadPartSpec> = {}): CadPartSpec {
  return { id, features, ...extra };
}

describe("kernel selection", () => {
  test("G2 and consumer surfaces prefer SMLib; machined boxes stay on OpenCascade", () => {
    const both: Array<"opencascade" | "smlib"> = ["opencascade", "smlib"];
    expect(selectCadKernel(spec("a", filleted), both).preferred).toBe("smlib");
    expect(selectCadKernel(spec("a", box, { hints: { machined: true } }), both).preferred).toBe(
      "opencascade",
    );
    expect(selectCadKernel(spec("a", box, { kernel: "smlib" }), both).preferred).toBe("smlib");
    expect(selectCadKernel(spec("a", filleted), ["opencascade"]).preferred).toBe("opencascade");
  });

  test("explicit kernel requests do not list fallbacks", () => {
    const both: Array<"opencascade" | "smlib"> = ["opencascade", "smlib"];
    expect(selectCadKernel(spec("a", box, { kernel: "opencascade" }), both).fallbacks).toEqual([]);
    expect(selectCadKernel(spec("a", box, { kernel: "smlib" }), both).fallbacks).toEqual([]);
  });
});

describe("STEP remapping", () => {
  test("shifts entity ids and leaves quoted hashes alone", () => {
    const data = `#1=PRODUCT('part-#1','p',$,(#2));\n#2=APPLICATION_CONTEXT('x');\n`;
    const remapped = remapStepEntityIds(data, 10);
    expect(remapped).toContain("#11=PRODUCT('part-#1'");
    expect(remapped).toContain("(#12)");
    expect(maxStepEntityId(remapped)).toBe(12);
  });

  test("translateStepData shifts CARTESIAN_POINT coordinates in 3D and 2D", async () => {
    const dir = join(import.meta.dir, "fixtures", "cad-kernel");
    const box = await readFile(join(dir, "box.step"), "utf8");
    const data = box.match(/DATA\s*;([\s\S]*?)ENDSEC\s*;/i)?.[1] ?? "";
    expect(data).toContain("CARTESIAN_POINT('',(0.,0.,0.))");
    const moved = translateStepData(data, { xMm: 60, yMm: 0, zMm: 0 });
    expect(moved).toContain("CARTESIAN_POINT('',(60.,0.,0.))");
    expect(moved).toContain("CARTESIAN_POINT('',(40.,-10.,-5.))");
    const twoD = "#1=CARTESIAN_POINT('p',(1.0,2.0));";
    expect(translateStepData(twoD, { xMm: 10, yMm: -3, zMm: 99 })).toBe(
      "#1=CARTESIAN_POINT('p',(11.,-1.));",
    );
  });

  test("combineStepTexts applies placement to geometry before merge", async () => {
    const dir = join(import.meta.dir, "fixtures", "cad-kernel");
    const a = await readFile(join(dir, "box.step"), "utf8");
    const b = await readFile(join(dir, "box.step"), "utf8");
    const merged = combineStepTexts(
      [
        { id: "left", text: a, xMm: 0, yMm: 0, zMm: 0 },
        { id: "right", text: b, xMm: 60, yMm: 0, zMm: 0 },
      ],
      { name: "pair" },
    );
    expect(merged).toContain("CARTESIAN_POINT('',(60.,0.,0.))");
    expect(merged).toContain("/* part right @ 60,0,0 mm */");
  });

  test("combines fixture STEP files into one ISO-10303-21 model", async () => {
    const dir = join(import.meta.dir, "fixtures", "cad-kernel");
    const a = await readFile(join(dir, "box.step"), "utf8");
    const b = await readFile(join(dir, "cyl.step"), "utf8");
    expect(isStepText(a)).toBe(true);
    const merged = combineStepTexts(
      [
        { id: "box", text: a },
        { id: "cyl", text: b },
      ],
      { name: "assembly" },
    );
    expect(merged).toStartWith("ISO-10303-21;");
    expect(merged).toContain("/* part box */");
    expect(merged).toContain("/* part cyl */");
    expect(merged.match(/#\d+\s*=/g)?.length).toBeGreaterThan(10);
    const ids = [...merged.matchAll(/#(\d+)\s*=/g)].map((m) => Number(m[1]));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("kernel contract (fake + OpenCascade adapter)", () => {
  test("fake kernel writes STEP and reports health", async () => {
    const k = createFakeKernel({ volumeMm3: 12 });
    const h = await k.health();
    expect(h.id).toBe("opencascade");
    expect(h.available).toBe(true);
    expect(h.capabilities.step).toBe(true);
    const dir = await tempDir();
    const dest = join(dir, "cad", "parts", "Lid.step");
    const built = await k.buildPart(spec("Lid", box), dest, dir);
    expect(built.format).toBe("step");
    expect(await readFile(dest, "utf8")).toContain("ISO-10303-21;");
  });

  test("OpenCascade kernel maps boxes through CadService and G2 fillets fail as a feature error", async () => {
    const calls: string[] = [];
    const cad = occtCad(calls);
    const k = createOpenCascadeKernel({ cad });
    const h = await k.health();
    expect(h.available).toBe(true);
    expect(h.capabilities.g2Fillets).toBe(false);
    const dir = await tempDir();
    const dest = join(dir, "cad", "parts", "Block.step");
    const built = await k.buildPart(spec("Block", box), dest, dir);
    expect(calls.some((c) => c.startsWith("add Part::Box"))).toBe(true);
    expect(built.kernel).toBe("opencascade");
    expect(await readFile(dest, "utf8")).toContain("ISO-10303-21;");
    await expect(k.buildPart(spec("Smooth", filleted), dest, dir)).rejects.toBeInstanceOf(
      CadFeatureError,
    );
  });

  test("OpenCascade uses the name FreeCAD assigns and exports the latest object", async () => {
    const calls: string[] = [];
    const cad = occtCad(calls);
    const k = createOpenCascadeKernel({ cad });
    const dir = await tempDir();
    const dest = join(dir, "cad", "parts", "Lid.step");
    await k.buildPart(spec("Lid", box), dest, dir);
    await k.buildPart(spec("Lid", box), dest, dir);
    expect(calls.some((c) => c.includes("export") && c.includes("Lid001"))).toBe(true);
  });

  test("unreachable FreeCAD is a kernel availability error, not a feature error", async () => {
    const cad = occtCad([]);
    cad.status = async () => ({
      bridgeUrl: "http://127.0.0.1:4030",
      reachable: false,
      detail: "bridge down",
      freecad: null,
      ui: false,
    });
    const k = createOpenCascadeKernel({ cad });
    const dir = await tempDir();
    const dest = join(dir, "cad", "parts", "X.step");
    await expect(k.buildPart(spec("X", box), dest, dir)).rejects.toBeInstanceOf(
      CadKernelUnavailableError,
    );
  });
});

describe("fallback and combination host", () => {
  test("retries the next kernel when a feature fails under auto", async () => {
    const project = await tempProject("kernels");
    const occt = createFakeKernel({ id: "opencascade", failFeature: "fillet" });
    const smlib = createFakeKernel({ id: "smlib", experimental: true, volumeMm3: 7770 });
    const host = createCadKernelHost({ kernels: [occt, smlib] });
    const { part } = await host.buildPart(
      project.dir,
      spec("Knob", [
        { kind: "box", lengthMm: 20, widthMm: 20, heightMm: 8 },
        { kind: "fillet", radiusMm: 1 },
      ]),
    );
    expect(part.kernel).toBe("smlib");
    expect(part.fallbacks).toEqual([
      expect.objectContaining({ from: "opencascade", to: "smlib", featureKind: "fillet" }),
    ]);
    expect(part.reason).toContain("fell back");
    const store = await host.store(project.dir);
    expect(store.parts.map((p) => p.id)).toEqual(["Knob"]);
  });

  test("explicit opencascade does not fall back when a feature fails", async () => {
    const project = await tempProject("explicit-occt");
    const occt = createFakeKernel({ id: "opencascade", failFeature: "fillet" });
    const smlib = createFakeKernel({ id: "smlib", experimental: true });
    const host = createCadKernelHost({ kernels: [occt, smlib] });
    await expect(
      host.buildPart(
        project.dir,
        spec(
          "Knob",
          [
            { kind: "box", lengthMm: 20, widthMm: 20, heightMm: 8 },
            { kind: "fillet", radiusMm: 1 },
          ],
          { kernel: "opencascade" },
        ),
      ),
    ).rejects.toBeInstanceOf(CadFeatureError);
  });

  test("explicit smlib when unavailable fails without silent OpenCascade fallback", async () => {
    const project = await tempProject("explicit-smlib-off");
    const occt = createFakeKernel({ id: "opencascade" });
    const smlib = createFakeKernel({ id: "smlib", experimental: true, available: false });
    const host = createCadKernelHost({ kernels: [occt, smlib] });
    await expect(
      host.buildPart(project.dir, spec("Block", box, { kernel: "smlib" })),
    ).rejects.toBeInstanceOf(CadKernelUnavailableError);
  });

  test("combines two parts into cad/assembly.step with placement at combine time", async () => {
    const project = await tempProject("asm");
    const host = createCadKernelHost({
      kernels: [createFakeKernel({ id: "opencascade" })],
    });
    await host.buildPart(project.dir, spec("A", box));
    await host.buildPart(project.dir, spec("B", box, { placement: { xMm: 60, yMm: 0, zMm: 0 } }));
    const { assembly } = await host.combine(project.dir);
    expect(assembly.partIds).toEqual(["A", "B"]);
    const text = await readFile(join(project.dir, assembly.step), "utf8");
    expect(text).toContain("ISO-10303-21;");
    expect(text).toContain("part A");
    expect(text).toContain("part B");
    expect(text).toContain("@ 60,0,0 mm");
  });
});

describe("SMLib experimental backend", () => {
  test("stays unavailable until the experimental flag is on", async () => {
    expect(experimentalCadKernelsEnabled({ FABDESK_EXPERIMENTAL_CAD_KERNELS: "1" })).toBe(true);
    const off = createSmlibKernel({ experimental: false });
    const h = await off.health();
    expect(h.available).toBe(false);
    expect(h.experimental).toBe(true);
    expect(h.detail).toContain("FABDESK_EXPERIMENTAL_CAD_KERNELS");
  });

  test("missing python is reported as unavailable without throwing from health", async () => {
    const env = { FABDESK_SMLIB_PYTHON: "/nonexistent/fabdesk-python-missing" };
    const probe = await probeSmlib(env, { force: true });
    expect(probe.kind).toBeNull();
    expect(probe.detail).toMatch(/not found|Python/i);
    const k = createSmlibKernel({ experimental: true, env });
    const h = await k.health();
    expect(h.available).toBe(false);
    const dir = await tempDir();
    const dest = join(dir, "cad", "parts", "Box.step");
    await expect(k.buildPart(spec("Box", box), dest, dir)).rejects.toBeInstanceOf(
      CadKernelUnavailableError,
    );
  });

  test("builds a real box and fuses two parts when smlibpy is installed", async () => {
    const k = createSmlibKernel({ experimental: true });
    const h = await k.health();
    if (!h.available) {
      console.warn(`skipping live SMLib test: ${h.detail}`);
      return;
    }
    const dir = await tempDir();
    await mkdir(join(dir, "cad", "parts"), { recursive: true });
    const a = join(dir, "cad", "parts", "Box.step");
    const built = await k.buildPart(spec("Box", box), a, dir);
    expect(built.volumeMm3).toBeCloseTo(8000, 0);
    expect(await readFile(a, "utf8")).toStartWith("ISO-10303-21;");
    const b = join(dir, "cad", "parts", "Pin.step");
    await k.buildPart(spec("Pin", [{ kind: "cylinder", radiusMm: 5, heightMm: 20 }]), b, dir);
    const dest = join(dir, "cad", "assembly.step");
    const combined = await k.combineSteps?.(
      [
        { id: "Box", step: a, xMm: 0, yMm: 0, zMm: 0 },
        { id: "Pin", step: b, xMm: 50, yMm: 0, zMm: 0 },
      ],
      dest,
      dir,
    );
    expect(combined?.step).toBe(dest);
    expect(await readFile(dest, "utf8")).toContain("ISO-10303-21;");
  });
});

describe("cad kernel tools", () => {
  test("cad_kernels, cad_build_part (with fallback) and cad_combine_parts", async () => {
    const project: ProjectHandle = await tempProject("cad-tools");
    const occt = createFakeKernel({ id: "opencascade", failFeature: "fillet" });
    const smlib = createFakeKernel({ id: "smlib", experimental: true });
    const services = mockServices([project], {
      cadKernels: createCadKernelHost({ kernels: [occt, smlib] }),
    });
    const registry = createRegistry();
    const invoke = (name: string, args: Record<string, unknown> = {}) =>
      registry.invoke(name, { project: project.id, ...args }, () =>
        makeContext({ services, project }),
      );

    const listed = await invoke("cad_kernels");
    expect(listed.text).toContain("opencascade");
    expect(listed.text).toContain("smlib");
    expect(listed.text).toContain("Parasolid");

    const built = await invoke("cad_build_part", {
      id: "Grip",
      features: [
        { kind: "box", lengthMm: 30, widthMm: 20, heightMm: 10 },
        { kind: "fillet", radiusMm: 2 },
      ],
    });
    expect(built.text).toContain("on smlib");
    expect(built.text).toContain("Switched");

    await expect(
      invoke("cad_build_part", {
        id: "Grip2",
        kernel: "opencascade",
        features: [
          { kind: "box", lengthMm: 30, widthMm: 20, heightMm: 10 },
          { kind: "fillet", radiusMm: 2 },
        ],
      }),
    ).rejects.toThrow(/fillet/);

    await invoke("cad_build_part", {
      id: "Block",
      features: box,
      hints: { machined: true },
    });
    const combined = await invoke("cad_combine_parts");
    expect(combined.text).toContain("cad/assembly.step");
    expect(await readFile(join(project.dir, "cad/assembly.step"), "utf8")).toContain("ISO-10303-21;");
  });
});

async function tempDir(): Promise<string> {
  const project = await tempProject("k");
  return project.dir;
}

function occtCad(calls: string[]): CadService {
  const nameUse = new Map<string, number>();
  return {
    status: async () => ({
      bridgeUrl: "http://127.0.0.1:4030",
      reachable: true,
      detail: "mock",
      freecad: "FreeCADApiServer",
      ui: false,
    }),
    model: async (dir) => ({
      document: "Model",
      path: join(dir, "model.FCStd"),
      modified: false,
      objects: [],
      undo: [],
      redo: [],
    }),
    properties: async () => [],
    addObject: async (_dir, input) => {
      calls.push(`add ${input.type} ${JSON.stringify(input.properties ?? {})}`);
      const base = input.name ?? "Box";
      const n = nameUse.get(base) ?? 0;
      nameUse.set(base, n + 1);
      const resolved = n === 0 ? base : `${base}${String(n).padStart(3, "0")}`;
      return {
        name: resolved,
        label: input.label ?? "Box",
        type: input.type,
        status: "Touched",
        isError: false,
        visibility: true,
        children: [],
        parents: [],
      };
    },
    setProperties: async () => [],
    setExpression: async () => {},
    removeObject: async (_dir, name) => {
      calls.push(`remove ${name}`);
    },
    recompute: async () => {
      calls.push("recompute");
      return { recomputed: 1, errors: [] };
    },
    undo: async () => ({ undo: [], redo: [] }),
    save: async (dir) => {
      calls.push("save");
      return { path: join(dir, "model.FCStd") };
    },
    export: async (_dir, input) => {
      calls.push(`export ${input.format} ${(input.objects ?? []).join(",")}`);
      const body = [
        "ISO-10303-21;",
        "HEADER;",
        "FILE_DESCRIPTION(('occt test'),'2;1');",
        "FILE_NAME('box.step','',('fabPlane'),('fabPlane'),'test','fabPlane','');",
        "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
        "ENDSEC;",
        "DATA;",
        "#1=PRODUCT('Box','Box','',());",
        "ENDSEC;",
        "END-ISO-10303-21;",
        "",
      ].join("\n");
      return { data: new TextEncoder().encode(body), fileName: "Box.step", objects: input.objects ?? ["Box"] };
    },
    python: async (_dir, code) => {
      calls.push(`python ${code.slice(0, 40)}`);
      return { stdout: "", stderr: "" };
    },
    view: async () => ({
      bridgeUrl: "http://127.0.0.1:4030",
      session: "s",
      wsUrl: "ws://127.0.0.1:4030/ws",
      uiUrl: null,
      document: "Model",
    }),
    release: async () => {},
  };
}
