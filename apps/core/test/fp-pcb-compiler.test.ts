import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FpPcbCompileJob, FpPcbCompileRequest } from "@fabdesk/protocol";
import { ToolError, type KicadImportSummary } from "@fabdesk/tools";
import {
  chooseCompiler,
  elementCounts,
  fpPcbBuildCircuit,
  hasCompileSources,
  NETLIST_JSON_FILE,
  type FpPcbCompileBridge,
} from "../src/fp-pcb-compiler";

const NETLIST = JSON.stringify({
  netlist: {
    components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" }],
    nets: [],
  },
  board: { widthMm: 20, heightMm: 10 },
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-fp-pcb-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

function bridge(
  outcome: Partial<FpPcbCompileJob> | ((req: FpPcbCompileRequest) => Partial<FpPcbCompileJob>),
) {
  const seen: { sessionPath: string | null; request: FpPcbCompileRequest }[] = [];
  const b: FpPcbCompileBridge = {
    sessionFor: async (path) => ({ id: "s1", state: "running", path }),
    compile: async (_id, request, follow) => {
      seen.push({ sessionPath: null, request });
      follow?.onProgress?.({ id: "j1", state: "importing", log: [] });
      const o = typeof outcome === "function" ? outcome(request) : outcome;
      return {
        id: "j1",
        state: "done",
        log: [],
        result: {
          ok: true,
          diagnostics: [],
          counts: { components: 1, nets: 0, footprintsAdded: 1, footprintsPlaced: 1 },
          durationMs: 5,
        },
        ...o,
      };
    },
  };
  return { b, seen };
}

const imported = [
  { type: "pcb_board", width: 20, height: 10 },
  { type: "source_component", name: "R1" },
  { type: "pcb_component" },
];
const importPcb = async () => ({ circuitJson: imported, report: {} as KicadImportSummary });

describe("chooseCompiler", () => {
  const src = (netlist: boolean, tsx: boolean, entrypoint?: string) => ({
    netlist,
    tsx,
    entrypoint,
  });
  test("prefers fp-pcb only when asked and a netlist exists", () => {
    expect(chooseCompiler("tscircuit", src(true, true))).toBe("tscircuit");
    expect(chooseCompiler("fp-pcb", src(true, true))).toBe("fp-pcb");
    expect(chooseCompiler("fp-pcb", src(false, true))).toBe("tscircuit");
    expect(chooseCompiler("fp-pcb", src(false, false))).toBe("tscircuit");
  });
  test("a *.netlist.json entrypoint always means fp-pcb", () => {
    expect(chooseCompiler("tscircuit", src(false, true, "alt.netlist.json"))).toBe("fp-pcb");
  });
  test("hasCompileSources looks at the right files", async () => {
    const dir = await project({ [NETLIST_JSON_FILE]: NETLIST });
    expect(await hasCompileSources(dir, undefined)).toEqual({
      netlist: true,
      tsx: false,
      entrypoint: undefined,
    });
    expect(await hasCompileSources(dir, "other.netlist.json")).toEqual({
      netlist: false,
      tsx: false,
      entrypoint: "other.netlist.json",
    });
  });
});

describe("fpPcbBuildCircuit", () => {
  test("compiles, imports the board back, and hands ownership to KiCad", async () => {
    const dir = await project({ [NETLIST_JSON_FILE]: NETLIST });
    const { b, seen } = bridge({});
    const progress: string[] = [];
    const r = await fpPcbBuildCircuit(
      { projectDir: dir, progress: (_f, note) => progress.push(note ?? "") },
      { bridge: () => b, importPcb },
    );

    expect(r.ok).toBe(true);
    expect(r.boardSource).toBe("kicad");
    expect(r.circuitJson).toEqual(imported);
    expect(r.elementCounts).toEqual({ pcb_board: 1, source_component: 1, pcb_component: 1 });
    expect(progress).toEqual(["session", "importing", "importing board"]);
    const req = seen[0]!.request;
    expect(req.source).toEqual({
      kind: "netlist-json",
      files: { [NETLIST_JSON_FILE]: NETLIST },
      entrypoint: NETLIST_JSON_FILE,
    });
    // No board.kicad_pro yet: the job is told where to create the project.
    expect(req.project?.path).toBe(join(dir, "board.kicad_pro"));
    expect(req.autoplace).toBe(true);
    expect(req.save).toBe(true);
  });

  test("opens the existing project when board.kicad_pro is present", async () => {
    const dir = await project({ [NETLIST_JSON_FILE]: NETLIST, "board.kicad_pro": "{}" });
    let opened: string | null = "unset";
    const b: FpPcbCompileBridge = {
      sessionFor: async (path) => {
        opened = path;
        return { id: "s1", state: "running", path };
      },
      compile: bridge({}).b.compile,
    };
    const r = await fpPcbBuildCircuit({ projectDir: dir }, { bridge: () => b, importPcb });
    expect(r.ok).toBe(true);
    expect(opened).toBe(join(dir, "board.kicad_pro"));
    expect(
      await (async () =>
        (await bridge({}).b.compile("s1", { source: { kind: "x", files: {}, entrypoint: "x" } }))
          .id)(),
    ).toBe("j1");
  });

  test("maps diagnostics to build errors and warnings with positions", async () => {
    const dir = await project({ [NETLIST_JSON_FILE]: NETLIST });
    const { b } = bridge({
      result: {
        ok: false,
        diagnostics: [
          {
            severity: "error",
            stage: "frontend",
            code: "bad_shape",
            file: NETLIST_JSON_FILE,
            line: 3,
            column: 9,
            message: "/netlist/nets: must be an array",
          },
          {
            severity: "warning",
            stage: "netlist",
            code: "missing_footprint",
            message: "R1 has no footprint",
          },
        ],
        counts: { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 },
        durationMs: 2,
      },
    });
    const r = await fpPcbBuildCircuit({ projectDir: dir }, { bridge: () => b, importPcb });
    expect(r.ok).toBe(false);
    expect(r.circuitJson).toEqual([]);
    expect(r.boardSource).toBeUndefined();
    expect(r.errors).toEqual([
      {
        message: "/netlist/nets: must be an array",
        type: "bad_shape",
        file: NETLIST_JSON_FILE,
        line: 3,
        column: 9,
      },
    ]);
    expect(r.warnings).toEqual([{ message: "R1 has no footprint", type: "missing_footprint" }]);
  });

  test("an infrastructure failure is a single build error, not a throw", async () => {
    const dir = await project({ [NETLIST_JSON_FILE]: NETLIST });
    const { b } = bridge({ state: "failed", error: "kicad-cli exited", result: undefined });
    const r = await fpPcbBuildCircuit({ projectDir: dir }, { bridge: () => b, importPcb });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ type: "compile_job_failed", message: "kicad-cli exited" });
  });

  test("a cancelled job rejects with cancelled", async () => {
    const dir = await project({ [NETLIST_JSON_FILE]: NETLIST });
    const { b } = bridge({ state: "cancelled", result: undefined });
    await expect(
      fpPcbBuildCircuit({ projectDir: dir }, { bridge: () => b, importPcb }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  test("a board that will not import back is a build error", async () => {
    const dir = await project({ [NETLIST_JSON_FILE]: NETLIST });
    const { b } = bridge({});
    const r = await fpPcbBuildCircuit(
      { projectDir: dir },
      {
        bridge: () => b,
        importPcb: async () => {
          throw new Error("net collision");
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({
      type: "board_import_failed",
      message: expect.stringContaining("net collision"),
    });
  });

  test("missing netlist is a build error naming the file; no bridge is unavailable", async () => {
    const dir = await project({});
    const r = await fpPcbBuildCircuit({ projectDir: dir }, { bridge: () => null, importPcb });
    expect(r.errors[0]).toMatchObject({ type: "missing_entrypoint", file: NETLIST_JSON_FILE });

    const withNetlist = await project({ [NETLIST_JSON_FILE]: NETLIST });
    const err = await fpPcbBuildCircuit(
      { projectDir: withNetlist },
      { bridge: () => null, importPcb },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("unavailable");
  });

  test("elementCounts ignores elements without a type", () => {
    expect(
      elementCounts([{ type: "a" }, { type: "a" }, { x: 1 }, null as unknown as object]),
    ).toEqual({ a: 2 });
  });
});
