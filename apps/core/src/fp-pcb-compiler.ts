/**
 * The `fp-pcb` compiler behind `TscircuitService.buildCircuit`: a `circuit.netlist.json` goes to
 * a FabPlane PCB bridge as a compile job, KiCad writes `board.kicad_pcb`, and that board is
 * imported back into `circuit.json` so everything downstream of the build keeps working unchanged
 * until it is moved onto the bridge too.
 *
 *   circuit.netlist.json --[compile job]--> board.kicad_pcb --[importKicadPcb]--> circuit.json
 *
 * The result marks `boardSource: "kicad"`: the board is now the truth and `circuit.json` is a
 * lossy view of it, so `boardIsStale` must never trigger `circuit-json-to-kicad` over it.
 *
 * `chooseCompiler` decides per build. With the setting on `fp-pcb`, a project that has only a
 * `circuit.tsx` still compiles with tscircuit — the flag prefers the new path, it does not break
 * existing projects. Sim over an imported board is lossy (no `source_*` values beyond what the
 * importer derives); accepted until the sim tools move as well.
 */
import { join } from "node:path";
import type {
  FpPcbCompileJob,
  FpPcbCompileRequest,
  FpPcbDiagnostic,
  FpPcbSession,
} from "@fabdesk/protocol";
import {
  ToolError,
  type BuildError,
  type BuildOptions,
  type BuildResult,
  type CircuitJson,
  type KicadImportSummary,
} from "@fabdesk/tools";
import type { CompilerChoice } from "./config";

/** The `@fp-pcb/compile` frontend that reads `circuit.netlist.json` (its `NETLIST_JSON_KIND`). */
export const NETLIST_JSON_KIND = "netlist-json";
export const NETLIST_JSON_FILE = "circuit.netlist.json";
export const CIRCUIT_TSX_FILE = "circuit.tsx";
const BOARD_PRO = "board.kicad_pro";
const BOARD_PCB = "board.kicad_pcb";

/** The subset of `FpPcbBridgeClient` the compiler needs; small so tests can stub it. */
export interface FpPcbCompileBridge {
  sessionFor(path: string | null): Promise<FpPcbSession>;
  compile(
    sessionId: string,
    request: FpPcbCompileRequest,
    follow?: { signal?: AbortSignal; onProgress?: (job: FpPcbCompileJob) => void },
  ): Promise<FpPcbCompileJob>;
}

export type FpPcbCompilerDeps = {
  /** Null when no bridge is configured. */
  bridge: () => FpPcbCompileBridge | null;
  importPcb: (opts: {
    pcbPath: string;
    projectName?: string;
    strict?: boolean;
  }) => Promise<{ circuitJson: CircuitJson; report: KicadImportSummary }>;
  exists?: (path: string) => Promise<boolean>;
  readText?: (path: string) => Promise<string>;
};

export type CompileSources = { netlist: boolean; tsx: boolean; entrypoint: string | undefined };

export async function hasCompileSources(
  projectDir: string,
  entrypoint: string | undefined,
  exists = defaultExists,
): Promise<CompileSources> {
  return {
    netlist: await exists(
      join(projectDir, entrypoint && isNetlistEntry(entrypoint) ? entrypoint : NETLIST_JSON_FILE),
    ),
    tsx: await exists(
      join(projectDir, entrypoint && !isNetlistEntry(entrypoint) ? entrypoint : CIRCUIT_TSX_FILE),
    ),
    entrypoint,
  };
}

export function isNetlistEntry(entrypoint: string): boolean {
  return /\.netlist\.json$/i.test(entrypoint);
}

/**
 * `fp-pcb` when the setting asks for it and the project has a netlist (or the entrypoint names
 * one); tscircuit otherwise. An explicit netlist entrypoint always means fp-pcb, whatever the
 * setting — the author was specific.
 */
export function chooseCompiler(setting: CompilerChoice, sources: CompileSources): CompilerChoice {
  if (sources.entrypoint && isNetlistEntry(sources.entrypoint)) return "fp-pcb";
  if (setting === "fp-pcb" && sources.netlist) return "fp-pcb";
  return "tscircuit";
}

function toBuildError(d: FpPcbDiagnostic): BuildError {
  return {
    message: d.message,
    type: d.code ?? d.stage,
    ...(d.file ? { file: d.file } : {}),
    ...(d.line !== undefined ? { line: d.line } : {}),
    ...(d.column !== undefined ? { column: d.column } : {}),
  };
}

export function elementCounts(circuitJson: CircuitJson): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const el of circuitJson) {
    const type = (el as { type?: unknown })?.type;
    if (typeof type === "string") counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

const STAGE_FRACTION: Record<string, number> = {
  queued: 0.05,
  frontend: 0.1,
  validating: 0.15,
  checking: 0.25,
  outlining: 0.35,
  importing: 0.5,
  placing: 0.7,
  saving: 0.8,
};

export async function fpPcbBuildCircuit(
  opts: BuildOptions,
  deps: FpPcbCompilerDeps,
): Promise<BuildResult> {
  const started = performance.now();
  const exists = deps.exists ?? defaultExists;
  const readText = deps.readText ?? ((p: string) => Bun.file(p).text());
  const fail = (errors: BuildError[]): BuildResult => ({
    ok: false,
    circuitJson: [],
    errors,
    warnings: [],
    elementCounts: {},
    durationMs: Math.round(performance.now() - started),
  });

  const entrypoint =
    opts.entrypoint && isNetlistEntry(opts.entrypoint) ? opts.entrypoint : NETLIST_JSON_FILE;
  const entryPath = join(opts.projectDir, entrypoint);
  if (!(await exists(entryPath))) {
    return fail([
      {
        type: "missing_entrypoint",
        message: `${entrypoint} not found in ${opts.projectDir}`,
        file: entrypoint,
      },
    ]);
  }
  const bridge = deps.bridge();
  if (!bridge)
    throw new ToolError(
      "the fp-pcb compiler is selected but no FabPlane PCB bridge is configured (FABDESK_FP_PCB_BRIDGE_URL or the fpPcbBridgeUrl setting)",
      "unavailable",
    );

  const source = {
    kind: NETLIST_JSON_KIND,
    files: { [entrypoint]: await readText(entryPath) },
    entrypoint,
  };
  const proPath = join(opts.projectDir, BOARD_PRO);
  const haveProject = await exists(proPath);

  opts.progress?.(0.05, "session");
  const session = await bridge.sessionFor(haveProject ? proPath : null);
  const request: FpPcbCompileRequest = {
    source,
    ...(haveProject ? {} : { project: { path: proPath } }),
    autoplace: true,
    save: true,
    netlistPath: ".fabdesk/compile.net",
  };
  const job = await bridge.compile(session.id, request, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (j) => opts.progress?.(STAGE_FRACTION[j.state] ?? 0.5, j.state),
  });

  if (job.state === "cancelled") throw new ToolError("compile cancelled", "cancelled");
  if (!job.result)
    return fail([
      {
        type: "compile_job_failed",
        message: job.error ?? `compile job ${job.id} ended in state ${job.state} with no result`,
      },
    ]);
  const errors = job.result.diagnostics.filter((d) => d.severity === "error").map(toBuildError);
  const warnings = job.result.diagnostics.filter((d) => d.severity === "warning").map(toBuildError);
  if (!job.result.ok || errors.length) return { ...fail(errors), warnings };

  opts.progress?.(0.85, "importing board");
  let circuitJson: CircuitJson;
  try {
    ({ circuitJson } = await deps.importPcb({
      pcbPath: join(opts.projectDir, BOARD_PCB),
      projectName: "board",
      strict: true,
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...fail([
        {
          type: "board_import_failed",
          message: `compiled board could not be read back: ${message}`,
        },
      ]),
      warnings,
    };
  }
  opts.signal?.throwIfAborted();
  return {
    ok: true,
    circuitJson,
    errors: [],
    warnings,
    elementCounts: elementCounts(circuitJson),
    durationMs: Math.round(performance.now() - started),
    boardSource: "kicad",
  };
}

async function defaultExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}
