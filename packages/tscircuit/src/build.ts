import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { CircuitRunner } from "@tscircuit/eval";
import { FileCacheEngine, withRegistryFetchCache } from "./cache";
import { asElements, type BuildError, type BuildOptions, type BuildResult } from "./types";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "renders", "exports", ".fabdesk"]);
/** Generated files that must never be fed back into the evaluator. */
const SKIP_FILES = new Set(["circuit.json", "circuit.routed.json"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;

/** Collects the project's source files (relative, forward-slash keys) for @tscircuit/eval's fsMap. */
export async function collectFsMap(projectDir: string): Promise<Record<string, string>> {
  const fsMap: Record<string, string> = {};
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= MAX_FILES) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot === -1 || !SOURCE_EXTENSIONS.has(entry.name.slice(dot))) continue;
      if (SKIP_FILES.has(entry.name) || entry.name.endsWith(".circuit.json")) continue;
      const info = await stat(abs);
      if (info.size > MAX_FILE_BYTES) continue;
      fsMap[relative(projectDir, abs).split(sep).join("/")] = await Bun.file(abs).text();
      count++;
    }
  };
  await walk(projectDir);
  return fsMap;
}

function parseThrownError(err: unknown, entrypoint: string): BuildError {
  const message = err instanceof Error ? err.message : String(err);
  const location =
    /\bat\s+(\d+):(\d+)\b/.exec(message) ??
    /\((\d+):(\d+)\)/.exec(message) ??
    /line\s+(\d+)(?::|,\s*col(?:umn)?\s*)(\d+)/i.exec(message);
  const file = /\bin\s+"([^"]+\.(?:tsx?|jsx?))"/.exec(message)?.[1] ?? entrypoint;
  const isTranspile = /transpil|syntax error|unexpected token|sucrase/i.test(message) || location !== null;
  return {
    type: isTranspile ? "transpile_error" : "eval_error",
    message,
    ...(location ? { file, line: Number(location[1]), column: Number(location[2]) } : {}),
  };
}

function elementMessage(el: Record<string, unknown>): string {
  const m = el.message;
  if (typeof m === "string") return m;
  const name = el.error_type ?? el.type;
  return typeof name === "string" ? name : JSON.stringify(el);
}

/** Summarises circuit-json into errors/warnings/element counts (also used on cached circuit.json). */
export function summarizeCircuitJson(circuitJson: unknown[]): Pick<BuildResult, "errors" | "warnings" | "elementCounts"> {
  const errors: BuildError[] = [];
  const warnings: string[] = [];
  const elementCounts: Record<string, number> = {};
  for (const el of asElements(circuitJson)) {
    elementCounts[el.type] = (elementCounts[el.type] ?? 0) + 1;
    if (el.type.endsWith("_error")) errors.push({ type: el.type, message: elementMessage(el) });
    else if (el.type.endsWith("_warning")) warnings.push(`${el.type}: ${elementMessage(el)}`);
  }
  return { errors, warnings, elementCounts };
}

/**
 * Evaluates `<projectDir>/<entrypoint>` with @tscircuit/eval, autorouting disabled
 * (`platform.routingDisabled`; verified to produce no `pcb_trace` elements and to skip core's
 * routing DRC checks), writes `<projectDir>/circuit.json` and returns a summary.
 */
export async function buildCircuit(opts: BuildOptions): Promise<BuildResult> {
  const started = performance.now();
  const entrypoint = opts.entrypoint ?? "circuit.tsx";
  const finish = (partial: Omit<BuildResult, "durationMs">): BuildResult => ({
    ...partial,
    durationMs: Math.round(performance.now() - started),
  });
  opts.signal?.throwIfAborted();

  const entryFile = Bun.file(join(opts.projectDir, entrypoint));
  if (!(await entryFile.exists())) {
    return finish({
      ok: false,
      circuitJson: [],
      errors: [{ type: "missing_entrypoint", message: `${entrypoint} not found in ${opts.projectDir}`, file: entrypoint }],
      warnings: [],
      elementCounts: {},
    });
  }
  const fsMap = await collectFsMap(opts.projectDir);
  const entrySource = fsMap[entrypoint] ?? (await entryFile.text());
  fsMap[entrypoint] = entrySource;
  // Files that build the circuit imperatively use `circuit.add(...)`; everything else is treated
  // as a module whose default export is the root component.
  const usesCircuitAdd = /\bcircuit\.add\s*\(/.test(entrySource);

  const runner = new CircuitRunner({
    platform: {
      routingDisabled: true,
      ...(opts.cacheDir ? { localCacheEngine: new FileCacheEngine(opts.cacheDir) } : {}),
    },
  });

  const run = async (): Promise<unknown[]> => {
    await runner.executeWithFsMap({
      fsMap,
      ...(usesCircuitAdd ? { entrypoint } : { mainComponentPath: entrypoint }),
    });
    await runner.renderUntilSettled();
    return runner.getCircuitJson();
  };

  const aborted = new Promise<never>((_, reject) => {
    if (!opts.signal) return;
    const onAbort = () => {
      void runner.kill().catch(() => undefined);
      reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("build aborted"));
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  });

  let circuitJson: unknown[];
  try {
    const job = opts.cacheDir ? withRegistryFetchCache(opts.cacheDir, run) : run();
    circuitJson = await Promise.race([job, aborted]);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return finish({ ok: false, circuitJson: [], errors: [parseThrownError(err, entrypoint)], warnings: [], elementCounts: {} });
  } finally {
    await runner.kill().catch(() => undefined);
  }

  const summary = summarizeCircuitJson(circuitJson);
  await Bun.write(join(opts.projectDir, "circuit.json"), JSON.stringify(circuitJson));
  return finish({ ok: summary.errors.length === 0, circuitJson, ...summary });
}

/** Reads `<projectDir>/circuit.json`; null when it does not exist. */
export async function readCircuitJson(projectDir: string): Promise<unknown[] | null> {
  const file = Bun.file(join(projectDir, "circuit.json"));
  if (!(await file.exists())) return null;
  const data: unknown = await file.json();
  if (!Array.isArray(data)) throw new Error(`${projectDir}/circuit.json is not a circuit-json array`);
  return data;
}
