import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKicadCli, type KicadCli } from "../src/cli";
import {
  assembleMechanicalSection,
  collectMechanical,
  findKicadCli,
  MECHANICAL_CACHE_LIMIT,
  MechanicalMemo,
  mechanicalMemo,
  measureGlb,
  placeFootprints,
  readSavedBoardModels,
  resolveModelPath,
  type MechanicalSection,
} from "../src/index";

const FIXTURE = join(import.meta.dir, "fixtures", "mechanical");
const temporary: string[] = [];
afterAll(async () => {
  for (const dir of temporary) await rm(dir, { recursive: true, force: true });
});

async function fixtureCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-mechanical-"));
  temporary.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  // Real export uses the stable KiCad placement format. Keep board.kicad_pcb in
  // FIXTURE unchanged for the separate 10.99 transform-parser coverage.
  await cp(join(FIXTURE, "runtime-board.kicad_pcb"), join(dir, "board.kicad_pcb"));
  return dir;
}

/** Minimal GLB writer: one assembly root, named children, one float VEC3 POSITION mesh. */
function glb(
  children: Array<{ name: string; translation?: number[]; rotation?: number[] }>,
  vertices: number[][],
): Uint8Array {
  const positions = new Float32Array(vertices.flat());
  const json = {
    asset: { version: "2.0", generator: "test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { children: children.map((_, i) => i + 1) },
      ...children.map((c) => ({
        name: c.name,
        ...(c.translation ? { translation: c.translation } : {}),
        ...(c.rotation ? { rotation: c.rotation } : {}),
        mesh: 0,
      })),
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length, type: "VEC3" }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ byteLength: positions.byteLength }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const bin = new Uint8Array(positions.buffer);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonBytes.length, bin.length, true);
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true);
  out.set(bin, 28 + jsonBytes.length);
  return out;
}

describe("saved-native model references", () => {
  test("reads v10 transform placement, side, hidden, offset, scale and multiple models", async () => {
    const footprints = readSavedBoardModels(
      await readFile(join(FIXTURE, "board.kicad_pcb"), "utf8"),
    );
    const byRef = new Map(footprints.map((fp) => [fp.ref, fp]));
    expect(footprints).toHaveLength(13);
    expect(byRef.get("U3")).toMatchObject({
      side: "bottom",
      placement: { x: 130, y: 100, rotationDeg: 30, format: "transform" },
    });
    expect(byRef.get("U2")!.placement!.rotationDeg).toBe(90);
    expect(byRef.get("U4")!.models).toHaveLength(2);
    expect(byRef.get("U4")!.models[1]).toMatchObject({
      offset: { x: 1, y: 0, z: 1.2 },
      scale: { x: 1, y: 1, z: 2 },
      rotate: { x: 0, y: 0, z: 90 },
    });
    expect(byRef.get("U8")!.models).toEqual([]);
    expect(byRef.get("U11")!.models[0]!.hidden).toBe(true);
  });

  test("reads legacy (at x y r) placement", () => {
    const [fp] = readSavedBoardModels(
      '(kicad_pcb (footprint "a:b" (layer "B.Cu") (at 1 2 45) (property "Reference" "Q1") (model "x.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))))',
    );
    expect(fp).toMatchObject({
      ref: "Q1",
      side: "bottom",
      placement: { x: 1, y: 2, rotationDeg: 45, format: "at" },
    });
  });

  test("resolves KIPRJMOD, environment variables and reports undefined ones", () => {
    expect(resolveModelPath("${KIPRJMOD}/models/box.step", FIXTURE)).toMatchObject({
      status: "resolved",
      path: join(FIXTURE, "models/box.step"),
    });
    expect(resolveModelPath("models/nope.step", FIXTURE)).toMatchObject({
      status: "file-not-found",
    });
    expect(
      resolveModelPath("${LIB3D}/box.step", FIXTURE, { LIB3D: join(FIXTURE, "models") }),
    ).toMatchObject({ status: "resolved" });
    expect(resolveModelPath("${UNSET_3D_DIR}/x.step", FIXTURE, {})).toMatchObject({
      status: "unresolved-variable",
      unresolvedVariables: ["UNSET_3D_DIR"],
    });
  });
});

describe("GLB measurement", () => {
  test("converts glTF metres/Y-up to KiCad board mm with Z up and Y down", () => {
    // A unit-metre-scaled 2x4x1 mm box in glTF axes: x∈[-1,1] mm, y(up)∈[0,1] mm, z∈[-2,2] mm.
    const box = [
      [-0.001, 0, -0.002],
      [0.001, 0.001, 0.002],
    ];
    // Quarter turn about glTF +Y (board Z): KiCad's rot 90 export of the fixture used this rotation.
    const { roots } = measureGlb(
      glb(
        [
          { name: "R1", translation: [0.01, 0.0016, 0.02] },
          {
            name: "R2",
            translation: [0.03, 0.0016, 0.02],
            rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
          },
        ],
        box,
      ),
    );
    expect(roots[0]!.name).toBe("R1");
    const r1 = roots[0]!.bounds!;
    expect(
      [r1.minX, r1.maxX, r1.minY, r1.maxY, r1.minZ, r1.maxZ].map((v) => +v.toFixed(4)),
    ).toEqual([9, 11, 18, 22, 1.6, 2.6]);
    const r2 = roots[1]!.bounds!;
    expect([r2.minX, r2.maxX, r2.minY, r2.maxY].map((v) => +v.toFixed(4))).toEqual([
      28, 32, 19, 21,
    ]);
    expect(roots[1]!.origin.z).toBeCloseTo(1.6, 6);
  });

  test("rejects non-GLB bytes", () => {
    expect(() => measureGlb(new TextEncoder().encode("not a glb file at all"))).toThrow(
      /binary glTF/,
    );
  });
});

describe("attribution semantics", () => {
  const cli = { path: "/fake/kicad-cli", version: "10.99.0" };
  const base = {
    projectDir: FIXTURE,
    pcbRevision: "r",
    cli,
    exitCode: 0,
    diagnostics: [],
    outputLines: [],
    cache: { status: "disabled" as const, key: null },
  };
  const b = (x: number) => ({ minX: x, minY: 0, minZ: 1.6, maxX: x + 1, maxY: 1, maxZ: 2.6 });

  test("partial loading of a multi-model footprint is indeterminate, never guessed", () => {
    const board = `(kicad_pcb (footprint "a:b" (layer "F.Cu") (at 0 0) (property "Reference" "J1")
      (model "\${KIPRJMOD}/models/box.step") (model "\${KIPRJMOD}/models/junk.step")))`;
    const section = assembleMechanicalSection({
      ...base,
      boardText: board,
      glb: {
        generator: null,
        roots: [{ name: "J1", origin: { x: 0, y: 0, z: 1.6 }, bounds: b(0), vertices: 8 }],
      },
    });
    expect(section.footprints[0]!.status).toBe("partial");
    expect(section.footprints[0]!.models.map((m) => m.load.status)).toEqual([
      "indeterminate",
      "indeterminate",
    ]);
    expect(section.issues.map((i) => i.code)).toContain("model-attribution-indeterminate");
    expect(section.coverage["indeterminateModels"]).toBe(2);
  });

  test("duplicate references withhold geometry instead of attributing it", () => {
    const fp = (x: number) =>
      `(footprint "a:b" (layer "F.Cu") (at ${x} 0) (property "Reference" "REF**") (model "\${KIPRJMOD}/models/box.step"))`;
    const section = assembleMechanicalSection({
      ...base,
      boardText: `(kicad_pcb ${fp(0)} ${fp(5)})`,
      glb: {
        generator: null,
        roots: [
          { name: "REF**", origin: { x: 0, y: 0, z: 1.6 }, bounds: b(0), vertices: 8 },
          { name: "REF**", origin: { x: 5, y: 0, z: 1.6 }, bounds: b(5), vertices: 8 },
        ],
      },
    });
    expect(section.footprints.map((f) => f.status)).toEqual([
      "ambiguous-reference",
      "ambiguous-reference",
    ]);
    expect(section.coverage["footprintsWithBounds"]).toBe(0);
    expect(section.status).toBe("missing");
  });

  test("an empty board is inapplicable", () => {
    const section = assembleMechanicalSection({
      ...base,
      boardText: "(kicad_pcb)",
      glb: { generator: null, roots: [] },
    });
    expect(section.status).toBe("inapplicable");
  });
});

describe("process-local result cache", () => {
  const section = (maxZ: number) =>
    ({
      source: { cache: { status: "miss", key: "k" } },
      footprints: [{ ref: "U1", bounds: { maxZ } }],
    }) as unknown as MechanicalSection;
  const maxZ = (s: MechanicalSection | undefined) => (s?.footprints[0]!.bounds as any).maxZ;

  test("keeps a bounded number of entries, evicting the least recently used", () => {
    expect(MECHANICAL_CACHE_LIMIT).toBe(8);
    expect(mechanicalMemo.limit).toBe(MECHANICAL_CACHE_LIMIT);
    const memo = new MechanicalMemo(3);
    for (const k of ["a", "b", "c"]) memo.set(k, section(1));
    expect(memo.get("a")).toBeDefined(); // a becomes most recent; b is now oldest
    memo.set("d", section(1));
    expect(memo.size).toBe(3);
    expect(memo.get("b")).toBeUndefined();
    for (const k of ["a", "c", "d"]) expect(memo.get(k)).toBeDefined();
    memo.clear();
    expect(memo.size).toBe(0);
  });

  test("callers cannot mutate the stored section before or after a hit", () => {
    const memo = new MechanicalMemo(2);
    const produced = section(2.745);
    memo.set("k", produced);
    (produced.footprints[0]!.bounds as any).maxZ = 99.999;
    const hit = memo.get("k")!;
    expect(maxZ(hit)).toBe(2.745);
    (hit.footprints[0]!.bounds as any).maxZ = 99.999;
    hit.source.cache = { status: "hit", key: "k" };
    expect(maxZ(memo.get("k"))).toBe(2.745);
    expect(memo.get("k")!.source.cache.status).toBe("miss");
  });
});

describe("temporary GLB scratch", () => {
  /** A stand-in kicad-cli that writes an invalid GLB to its -o path, then optionally hangs. */
  async function fakeCli(dir: string, hang: boolean, signal?: AbortSignal): Promise<KicadCli> {
    const script = join(dir, "fixture-cli.ts");
    await writeFile(
      script,
      `await Bun.write(process.argv[process.argv.indexOf('-o') + 1], 'garbage'); ${hang ? "await Bun.sleep(30_000);" : ""}`,
    );
    return {
      path: process.execPath,
      version: "10.99.0",
      // Run the normal CLI subprocess/abort implementation through the trusted
      // Bun runtime, avoiding unsigned test executables on Windows.
      trace: ({ command, cwd }) =>
        runKicadCli(
          { path: process.execPath, version: "10.99.0" },
          [script, ...command.slice(1)],
          { cwd, ...(signal ? { signal } : {}) },
        ),
    };
  }

  test("is deleted when measurement fails and nothing is cached", async () => {
    const dir = await fixtureCopy();
    const scratchDir = join(dir, ".fabdesk", "cache", "mechanical");
    const before = mechanicalMemo.size;
    await expect(
      collectMechanical(await fakeCli(dir, false), {
        projectDir: dir,
        board: join(dir, "board.kicad_pcb"),
        scratchDir,
      }),
    ).rejects.toThrow();
    expect(await readdir(scratchDir)).toEqual([]);
    expect(mechanicalMemo.size).toBe(before);
  });

  test("is deleted when measurement is cancelled mid-export", async () => {
    const dir = await fixtureCopy();
    const scratchDir = join(dir, ".fabdesk", "cache", "mechanical");
    const controller = new AbortController();
    const pending = collectMechanical(await fakeCli(dir, true, controller.signal), {
      projectDir: dir,
      board: join(dir, "board.kicad_pcb"),
      scratchDir,
      signal: controller.signal,
    });
    const settled = pending.catch((error: unknown) => error);
    try {
      for (let i = 0; i < 100; i++) {
        const entries = await readdir(scratchDir).catch(() => [] as string[]);
        if (entries.some((e) => e.endsWith(".glb"))) break;
        await Bun.sleep(25);
      }
      expect((await readdir(scratchDir)).some((e) => e.endsWith(".glb"))).toBe(true);
    } finally {
      controller.abort();
      await settled;
    }
    expect(String(await settled)).toContain("aborted");
    expect(await readdir(scratchDir)).toEqual([]);
  });
});

// Real GLB measurements require KiCad 10; the runtime fixture uses its stable board format.
const cli = await findKicadCli();
const packaged = cli !== null && /^10\./.test(cli.version);

describe.skipIf(!packaged)("packaged kicad-cli mechanical truth", () => {
  // These integration cases launch real KiCad processes repeatedly (including cold exports).
  // Keep unit-test deadlines unchanged; allow the native assertions to finish under load.
  const nativeTest = (name: string, fn: () => Promise<void>) => test(name, fn, 30_000);
  let dir = "";
  let first: MechanicalSection;
  const collect = () =>
    collectMechanical(cli!, {
      projectDir: dir,
      board: join(dir, "board.kicad_pcb"),
      scratchDir: join(dir, ".fabdesk", "cache", "mechanical"),
    });
  const fp = (section: MechanicalSection, ref: string) =>
    section.footprints.find((f) => f.ref === ref)!;
  const bounds = (section: MechanicalSection, ref: string) => {
    const value = fp(section, ref).bounds;
    if (!("units" in value)) throw new Error(`${ref} has no bounds`);
    return [value.minX, value.maxX, value.minY, value.maxY, value.minZ, value.maxZ];
  };

  nativeTest("the fixture model is independently a 2 x 4 x 1.13 mm box in millimetres", async () => {
    const step = await readFile(join(FIXTURE, "models", "box.step"), "utf8");
    expect(step).toContain("SI_UNIT(.MILLI.,.METRE.)");
    const points = [...step.matchAll(/CARTESIAN_POINT\('[^']*',\(([^)]*)\)\)/g)].map((m) =>
      m[1]!.split(",").map(Number),
    );
    const axis = (i: number) => [
      Math.min(...points.map((p) => p[i]!)),
      Math.max(...points.map((p) => p[i]!)),
    ];
    expect([axis(0), axis(1), axis(2)]).toEqual([
      [-1, 1],
      [-2, 2],
      [0, 1.13],
    ]);
  });

  nativeTest("measures placement, sides, heights, coverage and overlap labelling", async () => {
    dir = await fixtureCopy();
    first = await collect();
    expect(first.source.cache.status).toBe("miss");
    expect(first.source.toolchain.kicadCli.version).toMatch(/^10\./);
    // Translation only.
    expect(bounds(first, "U1")).toEqual([109, 111, 98, 102, 1.615, 2.745]);
    // Rotation 90: the 2 x 4 footprint becomes 4 x 2.
    expect(bounds(first, "U2")).toEqual([118, 122, 99, 101, 1.615, 2.745]);
    // Bottom side, rotation 30: mirrored below the board; half extents 1·cos30+2·sin30, 1·sin30+2·cos30.
    expect(bounds(first, "U3")).toEqual([128.134, 131.866, 97.7679, 102.2321, -1.215, -0.085]);
    expect(fp(first, "U3").side).toBe("bottom");
    // Two models: the second offset (1, 0, 1.2), Z-scaled x2 and turned 90°.
    expect(bounds(first, "U4")).toEqual([149, 153, 93, 97, 1.615, 5.075]);
    expect(fp(first, "U4").models.map((m) => m.load.status)).toEqual(["loaded", "loaded"]);
    // KiCad model offset +Y moves the body towards board -Y.
    expect(bounds(first, "U12")).toEqual([134, 136, 92, 96, 1.615, 2.745]);
    // KiCad readVRML is compiled only for OCC_VERSION_HEX >= 0x070700:
    // https://docs.kicad.org/doxygen/step__pcb__model_8cpp_source.html
    // Older OCCT must expose the missing geometry honestly; no fixture is skipped.
    const occ = /Open CASCADE Technology (\d+)\.(\d+)/.exec(first.source.toolchain.glbGenerator ?? "");
    expect(occ).not.toBeNull();
    const nativeVrml = Number(occ![1]) > 7 || Number(occ![1]) === 7 && Number(occ![2]) >= 7;
    if (nativeVrml) expect(bounds(first, "U13")).toEqual([152.46, 157.54, 102.46, 107.54, 1.615, 6.695]);
    else {
      expect(fp(first, "U13").models[0]!.load).toMatchObject({ status: "unloadable", formatRecognized: true });
      expect(fp(first, "U13").bounds).toMatchObject({ status: "missing" });
    }

    expect(first.board.mountPlanes).toMatchObject({ top: { zMm: 1.615 }, bottom: { zMm: -0.085 } });
    expect(first.board.body).toMatchObject({
      minX: 100,
      maxX: 160,
      minY: 90,
      maxY: 110,
      provenance: "packaged-runtime-measured",
    });
    expect(fp(first, "U1").height).toMatchObject({ aboveTopMm: 1.13, belowBottomMm: 0 });
    expect(fp(first, "U4").height).toMatchObject({ aboveTopMm: 3.46 });
    expect(fp(first, "U3").height).toMatchObject({ aboveTopMm: 0, belowBottomMm: 1.13 });

    expect(fp(first, "U7").models[0]!.load.status).toBe("missing-file");
    expect(fp(first, "U8").status).toBe("no-model");
    expect(fp(first, "U9").models[0]!.load).toMatchObject({
      status: "unloadable",
      formatRecognized: true,
    });
    expect(fp(first, "U10").models[0]!.load).toMatchObject({
      status: "unloadable",
      formatRecognized: false,
    });
    expect(fp(first, "U11").status).toBe("hidden-models-only");
    for (const ref of ["U7", "U8", "U9", "U10", "U11"]) {
      expect(fp(first, ref).bounds).toMatchObject({ status: "missing" });
      expect(fp(first, ref).height).toMatchObject({ status: "missing" });
    }
    expect(first.coverage).toEqual({
      placedFootprints: 13,
      footprintsDeclaringModels: 12,
      footprintsWithoutModels: 1,
      declaredModels: 13,
      hiddenModels: 1,
      resolvedModels: 12,
      loadedModels: nativeVrml ? 9 : 8,
      missingModels: 1,
      unresolvedModels: 0,
      unloadableModels: nativeVrml ? 1 : 2,
      unsupportedModels: 1,
      indeterminateModels: 0,
      footprintsWithBounds: nativeVrml ? 8 : 7,
      footprintsWithHeight: nativeVrml ? 8 : 7,
    });
    expect(first.status).toBe("partial");
    expect(first.issues.map((i) => `${i.code}:${i.ref}`).sort()).toEqual([
      "missing-model-file:U7",
      "no-model-declared:U8",
      ...(!nativeVrml ? ["unloadable-model:U13"] : []),
      "unloadable-model:U9",
      "unsupported-model-format:U10",
    ]);
    expect(first.runtimeDiagnostics.join("\n")).toContain("Could not add 3D model for U7.");
    expect(first.assembly).toMatchObject({
      maxHeightAboveTopMm: nativeVrml ? { value: 5.08, ref: "U13" } : { value: 3.46, ref: "U4" },
      maxDepthBelowBottomMm: { value: 1.13, ref: "U3" },
      footprintsIncluded: nativeVrml ? 8 : 7,
    });
    // Only the intentionally overlapping pair; separated bodies and the board are not candidates.
    expect(first.interference.broadPhaseOverlapCandidates).toMatchObject({
      count: 1,
      pairs: [{ a: "U5", b: "U6", overlapMm: { x: 0.5, y: 4, z: 1.13 } }],
    });
    expect(first.interference.collision.status).toBe("unsupported");
    expect(JSON.stringify(first)).not.toMatch(/"collisions?"\s*:\s*\[/);
  });

  const scratch = () => join(dir, ".fabdesk", "cache", "mechanical");
  const invented = (section: MechanicalSection) => {
    const text = JSON.stringify(section);
    return text.includes("99.999") || text.includes("4242") || text.includes("evil");
  };

  nativeTest("unchanged content hits the process-local cache; hits cannot be poisoned", async () => {
    // Cache integrity must run even when a separate runtime-geometry assertion fails.
    dir = await fixtureCopy(); first = await collect();
    expect(await readdir(scratch())).toEqual([]); // temporary GLB removed after success
    const pristine = structuredClone(first);
    // Mutating the object a miss returned must not reach the cache.
    (fp(first, "U1").bounds as any).maxZ = 99.999;
    first.coverage.loadedModels = 4242;

    const warm = await collect();
    expect(warm.source.cache).toMatchObject({ status: "hit", key: pristine.source.cache.key });
    expect(warm.source.cache.reason).toContain("memory only");
    expect({ ...warm, source: { ...warm.source, cache: null } }).toEqual({
      ...pristine,
      source: { ...pristine.source, cache: null },
    });
    // Nor may mutating a hit.
    (fp(warm, "U1").bounds as any).maxZ = 99.999;
    warm.coverage.loadedModels = 4242;
    warm.status = "present";
    const again = await collect();
    expect(again.source.cache.status).toBe("hit");
    expect(bounds(again, "U1")).toEqual([109, 111, 98, 102, 1.615, 2.745]);
    expect(again.coverage.loadedModels).toBe(pristine.coverage.loadedModels);
    expect(again.status).toBe("partial");
    expect(await readdir(scratch())).toEqual([]);
    first = pristine;
  });

  nativeTest("project-local result JSON never influences returned evidence", async () => {
    dir = await fixtureCopy(); first = await collect();
    const key = first.source.cache.key!;
    const real = () => JSON.parse(JSON.stringify(first));
    const fabricated = real();
    (fabricated.footprints.find((f: any) => f.ref === "U1").bounds as any).maxZ = 99.999;
    fabricated.coverage.loadedModels = 4242;
    fabricated.status = "present";
    fabricated.issues = [];
    const matchingKey = {
      ...fabricated,
      source: { ...fabricated.source, cache: { status: "hit", key } },
    };
    const wrongContract = { ...fabricated, contract: { name: "evil", version: "9.9.9" } };
    const wrongCollector = {
      ...fabricated,
      source: { ...fabricated.source, collector: { name: "evil", version: "0" } },
    };
    const wrongToolchain = {
      ...fabricated,
      source: {
        ...fabricated.source,
        toolchain: { ...fabricated.source.toolchain, kicadCli: { path: "/evil", version: "0" } },
      },
    };
    const variants: Record<string, string> = {
      truncated: JSON.stringify(real()).slice(0, 200),
      minimal: JSON.stringify({ source: { pcbRevision: first.source.pcbRevision } }),
      "schema-valid fabricated": JSON.stringify(fabricated),
      "wrong contract": JSON.stringify(wrongContract),
      "wrong collector": JSON.stringify(wrongCollector),
      "wrong toolchain": JSON.stringify(wrongToolchain),
      "matching key": JSON.stringify(matchingKey),
    };
    const expectTruth = (section: MechanicalSection, status: "hit" | "miss", label: string) => {
      expect([label, section.source.cache.status]).toEqual([label, status]);
      expect([label, invented(section)]).toEqual([label, false]);
      expect(bounds(section, "U1")).toEqual([109, 111, 98, 102, 1.615, 2.745]);
      expect(section.coverage).toEqual(first.coverage);
      expect(section.contract).toEqual(first.contract);
      expect(section.source.collector).toEqual(first.source.collector);
      expect(section.source.toolchain).toEqual(first.source.toolchain);
      expect(section.status).toBe("partial");
    };
    for (const [label, text] of Object.entries(variants)) {
      await rm(scratch(), { recursive: true, force: true });
      await mkdir(scratch(), { recursive: true });
      await writeFile(join(scratch(), `${key}.json`), text);
      await writeFile(join(scratch(), "legacy.json"), text);
      // Warm process: served from memory, files unread.
      expectTruth(await collect(), "hit", label);
      // Cold process: re-measured, files still unread.
      mechanicalMemo.clear();
      expectTruth(await collect(), "miss", label);
      // Only the planted files remain; no GLB is left behind.
      expect((await readdir(scratch())).sort()).toEqual([`${key}.json`, "legacy.json"].sort());
      expect(await readFile(join(scratch(), `${key}.json`), "utf8")).toBe(text);
    }
  });

  nativeTest("placement-only and model-file-only changes miss", async () => {
    dir = await fixtureCopy(); first = await collect();
    const boardPath = join(dir, "board.kicad_pcb");
    const moved = placeFootprints(await readFile(boardPath, "utf8"), [
      { ref: "U1", x: 112, y: 100 },
    ]);
    await writeFile(boardPath, moved.text);
    const afterMove = await collect();
    expect(afterMove.source.cache.status).toBe("miss");
    expect(afterMove.source.pcbRevision).not.toBe(first.source.pcbRevision);
    expect(bounds(afterMove, "U1")).toEqual([111, 113, 98, 102, 1.615, 2.745]);

    // Only a model file changes: the unloadable file becomes a real body.
    await cp(join(dir, "models", "box.step"), join(dir, "models", "junk.step"));
    const afterModel = await collect();
    expect(afterModel.source.pcbRevision).toBe(afterMove.source.pcbRevision);
    expect(afterModel.source.cache.status).toBe("miss");
    expect(fp(afterModel, "U9").status).toBe("measured");
    expect(bounds(afterModel, "U9")).toEqual([119, 121, 103, 107, 1.615, 2.745]);
  });

  nativeTest("a model or substitution changing during export fails before evidence or cache", async () => {
    const isolated = await fixtureCopy();
    const scratchDir = join(isolated, ".fabdesk", "cache", "mechanical");
    const board = join(isolated, "board.kicad_pcb");
    const model = join(isolated, "models", "box.step");
    const substitution = join(isolated, "models", "cube.step");
    const flag = join(isolated, "swap-flag");
    const wrapped: KicadCli = {
      ...cli!,
      trace: async (_input, invoke) => {
        const op = await readFile(flag, "utf8").catch(() => "");
        if (op === "content")
          await writeFile(
            model,
            (await readFile(model, "utf8")).replace("(1.,-2.,1.13)", "(1.,-2.,7.13)"),
          );
        if (op === "disappear") await rm(model);
        if (op === "appear") await cp(model, substitution);
        return invoke();
      },
    };
    const run = () => collectMechanical(wrapped, { projectDir: isolated, board, scratchDir });
    const noGlb = async () =>
      expect((await readdir(scratchDir)).filter((name) => name.endsWith(".glb"))).toEqual([]);
    const u1 = [109, 111, 98, 102, 1.615, 2.745];

    const expectConcurrentChangeFails = async (op: string, restore: () => Promise<void>) => {
      mechanicalMemo.clear();
      const before = mechanicalMemo.size;
      await writeFile(flag, op);
      await expect(run()).rejects.toThrow(/changed during mechanical measurement/);
      expect(mechanicalMemo.size).toBe(before);
      await noGlb();
      await rm(flag, { force: true });
      await restore();
      const fresh = await run();
      expect(fresh.source.cache.status).toBe("miss");
      expect(bounds(fresh, "U1")).toEqual(u1);
      const hit = await run();
      expect(hit.source.cache).toMatchObject({ status: "hit", key: fresh.source.cache.key });
      expect(bounds(hit, "U1")).toEqual(u1);
      await noGlb();
      return fresh;
    };

    await expectConcurrentChangeFails("content", () =>
      cp(join(FIXTURE, "models", "box.step"), model),
    );
    const afterAppear = await expectConcurrentChangeFails("appear", () =>
      rm(substitution, { force: true }),
    );
    expect(fp(afterAppear, "U13").models[0]!.resolution).not.toHaveProperty("substitutedBy");
    await expectConcurrentChangeFails("disappear", () =>
      cp(join(FIXTURE, "models", "box.step"), model),
    );
  });
});
