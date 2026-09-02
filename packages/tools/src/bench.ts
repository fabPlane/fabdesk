/**
 * Route benchmark: N repetitions of one routing problem through the same `RouterService`
 * (RouterHost worker) path `route_run` uses, with frames on the bus so the Route Cinema shows
 * them, and a report persisted under `<project>/.fabdesk/bench/<timestamp>.json`.
 *
 * Scenarios (both start from the project's circuit.json, the imported/built baseline):
 * - `full`: every routed connection is unrouted and the whole board is routed from scratch;
 *   copper pours stay as fixed netted obstacles.
 * - `repair`: only the connections attached to `repairRefs` (default: the nine corrected
 *   footprints of the B2.23.1 runbook) are unrouted and routed with `onlyConnections`; every
 *   other trace, via and pour stays as fixed copper. Plane nets (pours) are excluded from the
 *   scope and listed. This is a net-level repair, not the runbook's junction-splitting one.
 *
 * Run 1 is reported as `cold` (fresh worker, cold module cache), the rest as `warm`; medians
 * are reported separately. Thread count and load averages are recorded per the runbook.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { cpus, loadavg, platform, arch, totalmem } from "node:os";
import { join } from "node:path";
import type { RouteResult, RouterId, SimpleRouteJson, SimplifiedPcbTrace } from "@fabdesk/protocol";
import { PROJECT_FILES, readJsonOrNull, writeJson } from "./fs";
import { FrameSink } from "./frame-sink";
import type { ProjectHandle } from "./registry";
import type { CircuitJson, CoreServices, KicadImportSummary } from "./services";

export const DEFAULT_REPAIR_REFS = [
  "U701",
  "U702",
  "U704",
  "U707",
  "Q701",
  "D403",
  "D703",
  "U705",
  "U706",
] as const;

export interface BenchRouteOptions {
  router: RouterId;
  scenario: "full" | "repair";
  repeat: number;
  timeoutMs: number;
  /** Component references for the `repair` scenario. */
  repairRefs?: string[];
  minFrameIntervalMs?: number;
  /** `omit` drops pours from the obstacles: a diagnostic, flagged in the report. */
  copperPours?: "polygon" | "omit";
  /** `omit` drops every pre-routed trace/via/pour from the obstacles: a diagnostic, flagged in the report. */
  existingCopper?: "obstacles" | "omit";
  settings?: Record<string, unknown>;
  /** Free-form tag stored with the report. */
  label?: string;
  /** Skip the frames.jsonl persistence (frames still go to the bus). */
  persistFrames?: boolean;
}

export interface BenchRun {
  index: number;
  kind: "cold" | "warm";
  runId: string;
  status: "done" | "failed" | "timeout";
  wallMs: number;
  /** The adapter's own `stats.wallMs` (excludes worker spawn and message hops). */
  routerWallMs: number | null;
  frames: number;
  framesThrottled: number | null;
  framesConnection: number;
  frameBytes: number;
  maxFrameShapes: number;
  complete: number;
  open: number;
  openConnections: string[];
  timedOut: boolean;
  vias: number;
  segments: number;
  resultHash: string | null;
  cpu: { userMs: number; systemMs: number };
  rss: { beforeMb: number; afterMb: number };
  detail: string | null;
  error: string | null;
}

export interface BenchSummary {
  runs: number;
  wallMs: { median: number; min: number; max: number } | null;
  routerWallMs: { median: number; min: number; max: number } | null;
  complete: { median: number; min: number; max: number } | null;
  open: { median: number; min: number; max: number } | null;
  frames: { median: number; min: number; max: number } | null;
  failures: number;
  timeouts: number;
  /** Distinct result hashes: 1 means every run produced identical copper. */
  distinctResults: number;
}

export interface BenchReport {
  schema: 1;
  label: string | null;
  startedAt: string;
  endedAt: string;
  project: { id: string; name: string; dir: string };
  router: RouterId;
  routerProbe: { present: boolean; ready: boolean; version?: string; detail: string } | null;
  scenario: BenchRouteOptions["scenario"];
  repeat: number;
  timeoutMs: number;
  minFrameIntervalMs: number;
  copperPours: "polygon" | "omit";
  existingCopper: "obstacles" | "omit";
  settings: Record<string, unknown> | null;
  channel: string;
  machine: {
    platform: string;
    arch: string;
    cpus: number;
    cpuModel: string;
    totalMemMb: number;
    loadAvg: [number, number, number];
    bun: string;
  };
  input: {
    source: "circuit.json";
    elements: number;
    elementCounts: Record<string, number>;
    import: {
      sha256: string;
      file: string;
      kicadVersion: number | null;
      convertMs: number;
      totalMs: number;
      layers: number;
      failures: number;
    } | null;
    board: { layers: number; rules: Record<string, number> | null };
  };
  scope: {
    refs: string[];
    components: string[];
    missing: string[];
    connections: string[];
    nets: string[];
    excluded: Array<{ net: string; connection: string; reason: string }>;
    unroutedTraces: number;
    unroutedVias: number;
  } | null;
  srj: {
    layerCount: number;
    layerNames: string[];
    connections: number;
    connectionsRouted: number;
    endpoints: number;
    obstacles: number;
    copper: {
      traces: number;
      vias: number;
      pours: number;
      obstacles: number;
      unowned: number;
    } | null;
    bytes: number;
    extractMs: number;
    minTraceWidth: number;
  };
  runs: BenchRun[];
  summary: { cold: BenchSummary; warm: BenchSummary; all: BenchSummary };
  path: string | null;
}

export type BenchDeps = {
  project: ProjectHandle;
  services: Pick<CoreServices, "tscircuit" | "router" | "bus" | "routeRuns" | "channel">;
  signal?: AbortSignal;
  progress?: (p: number, note?: string) => void;
};

function stats(values: number[]): { median: number; min: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { median: round(median), min: round(sorted[0]!), max: round(sorted[sorted.length - 1]!) };
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

export function summarize(runs: BenchRun[]): BenchSummary {
  const ok = runs.filter((r) => r.status !== "failed");
  return {
    runs: runs.length,
    wallMs: stats(ok.map((r) => r.wallMs)),
    routerWallMs: stats(ok.map((r) => r.routerWallMs).filter((v): v is number => v !== null)),
    complete: stats(ok.map((r) => r.complete)),
    open: stats(ok.map((r) => r.open)),
    frames: stats(ok.map((r) => r.frames)),
    failures: runs.filter((r) => r.status === "failed").length,
    timeouts: runs.filter((r) => r.timedOut).length,
    distinctResults: new Set(ok.map((r) => r.resultHash).filter((h) => h !== null)).size,
  };
}

/** Order-independent digest of the routed copper (coordinates at 0.1 µm). */
export function resultHash(traces: readonly SimplifiedPcbTrace[]): string {
  const rows = traces
    .map(
      (t) =>
        `${t.connection_name ?? ""}|${t.route.map((p) => (p.route_type === "wire" ? `w${p.layer}:${q(p.x)},${q(p.y)},${q(p.width)}` : `v${p.from_layer}>${p.to_layer}:${q(p.x)},${q(p.y)}`)).join(";")}`,
    )
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

function q(v: number): number {
  return Math.round(v * 10_000);
}

export function benchTimestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export async function benchRoute(deps: BenchDeps, opts: BenchRouteOptions): Promise<BenchReport> {
  const { project, services } = deps;
  const progress = deps.progress ?? (() => {});
  const startedAt = new Date();
  if (opts.router === "freerouting" && services.channel !== "internal") {
    throw new Error(
      "the freerouting router is only available in internal builds (FABDESK_CHANNEL=internal)",
    );
  }
  const circuitJson = await readJsonOrNull<CircuitJson>(
    join(project.dir, PROJECT_FILES.circuitJson),
  );
  if (!circuitJson)
    throw new Error(
      "circuit.json not found: import a board (project_import_kicad) or build one first",
    );
  const importReport = await readJsonOrNull<KicadImportSummary>(
    join(project.dir, PROJECT_FILES.reports, "import.json"),
  );
  const manifest = project.manifest();
  const elementCounts: Record<string, number> = {};
  for (const e of circuitJson) {
    const t = (e as { type?: string }).type ?? "?";
    elementCounts[t] = (elementCounts[t] ?? 0) + 1;
  }
  const count = (cj: CircuitJson, type: string) =>
    cj.filter((e) => (e as { type?: string }).type === type).length;

  // Scenario input.
  progress(0.02, "preparing scenario");
  const refs = opts.repairRefs ?? [...DEFAULT_REPAIR_REFS];
  let scope: BenchReport["scope"] = null;
  let input: CircuitJson;
  let only: string[] | undefined;
  if (opts.scenario === "repair") {
    const s = services.tscircuit.connectionsForComponents(circuitJson, refs);
    if (s.connections.length === 0)
      throw new Error(
        `repair scope is empty: no connections attached to ${refs.join(", ")}${s.missing.length ? ` (missing: ${s.missing.join(", ")})` : ""}`,
      );
    input = services.tscircuit.unrouteCircuit(circuitJson, s.connections);
    only = s.connections;
    scope = {
      refs,
      ...s,
      unroutedTraces: count(circuitJson, "pcb_trace") - count(input, "pcb_trace"),
      unroutedVias: count(circuitJson, "pcb_via") - count(input, "pcb_via"),
    };
  } else {
    input = services.tscircuit.unrouteCircuit(circuitJson);
  }

  // SRJ.
  progress(0.05, "extracting SimpleRouteJson");
  const rules = manifest.board.rules;
  const extracted = services.tscircuit.extractSimpleRouteJson(input, {
    ...(rules?.traceWidthMm !== undefined ? { minTraceWidth: rules.traceWidthMm } : {}),
    ...(rules
      ? {
          rules: {
            ...(rules.clearanceMm !== undefined ? { clearanceMm: rules.clearanceMm } : {}),
            ...(rules.viaDrillMm !== undefined ? { viaDrillMm: rules.viaDrillMm } : {}),
            ...(rules.viaDiameterMm !== undefined ? { viaDiameterMm: rules.viaDiameterMm } : {}),
          },
        }
      : {}),
    copperPours: opts.copperPours ?? "polygon",
    existingCopper: opts.existingCopper ?? "obstacles",
  });
  const srj: SimpleRouteJson = extracted.srj;
  const routedNames = only
    ? srj.connections.filter((c) => only!.includes(c.name)).map((c) => c.name)
    : srj.connections.map((c) => c.name);
  if (routedNames.length === 0)
    throw new Error("nothing to route: the scenario selects no SRJ connections");
  const minFrameIntervalMs =
    opts.minFrameIntervalMs ??
    (srj.obstacles.length + srj.connections.length * 4 > 6000
      ? 200
      : srj.obstacles.length + srj.connections.length * 4 > 2000
        ? 100
        : 33);
  const layerNames = srj.layerNames ?? [];
  const probes = await services.router.available().catch(() => []);
  const probe = probes.find((p) => p.id === opts.router) ?? null;

  const benchDir = join(project.dir, ".fabdesk", "bench");
  await mkdir(benchDir, { recursive: true });
  const runs: BenchRun[] = [];
  const total = Math.max(1, opts.repeat);
  for (let i = 0; i < total; i += 1) {
    if (deps.signal?.aborted) throw new Error("bench cancelled");
    const runId = `bench_${Date.now().toString(36)}_${i}`;
    const runDir = join(project.dir, PROJECT_FILES.runs, runId);
    const persist = opts.persistFrames ?? true;
    if (persist) await mkdir(runDir, { recursive: true });
    const framesPath = persist ? join(runDir, "frames.jsonl") : null;
    let done = 0;
    const sink = new FrameSink(framesPath, services.bus, (m) => {
      if (m.kind === "frame" && m.event.kind === "connection") {
        done += 1;
        // js_autorouter reports a connection event per pass, so `done` can exceed the count to route.
        progress(
          0.1 + (0.85 * (i + Math.min(0.95, done / routedNames.length))) / total,
          `run ${i + 1}/${total}: ${Math.min(done, routedNames.length)}/${routedNames.length} connections${done > routedNames.length ? ` (${done} connection events)` : ""}`,
        );
      }
    });
    services.routeRuns.start({
      id: runId,
      projectId: project.id,
      router: opts.router,
      framesPath: framesPath ?? "",
      startedAt: new Date().toISOString(),
    });
    const cpu0 = process.cpuUsage();
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    let result: RouteResult | null = null;
    let error: string | null = null;
    try {
      result = await services.router.route(
        {
          runId,
          router: opts.router,
          srj,
          timeoutMs: opts.timeoutMs,
          minFrameIntervalMs,
          ...(only ? { onlyConnections: only } : {}),
          ...(opts.settings ? { settings: opts.settings } : {}),
        },
        { onMessage: sink.onMessage, ...(deps.signal ? { signal: deps.signal } : {}) },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const rss1 = process.memoryUsage().rss;
    await sink.close();
    if (result) {
      services.routeRuns.finish(runId, { status: "done", result, error: null });
      services.bus.emit({ ts: Date.now(), topic: "route.done", result });
      if (persist) await writeJson(join(runDir, "result.json"), result);
    } else {
      services.routeRuns.finish(runId, { status: "failed", result: null, error });
    }
    runs.push({
      index: i,
      kind: i === 0 ? "cold" : "warm",
      runId,
      status: result ? (result.timedOut ? "timeout" : "done") : "failed",
      wallMs: round(wallMs),
      routerWallMs: result ? round(result.stats.wallMs) : null,
      frames: sink.stats.frames,
      framesThrottled: result?.stats.framesThrottled ?? null,
      framesConnection: sink.stats.connections,
      frameBytes: sink.stats.bytes,
      maxFrameShapes: sink.stats.maxShapes,
      complete: result?.complete.length ?? 0,
      open: result?.open.length ?? 0,
      openConnections: result?.open.slice(0, 50) ?? [],
      timedOut: result?.timedOut ?? false,
      vias: result?.stats.vias ?? 0,
      segments: result?.stats.segments ?? 0,
      resultHash: result ? resultHash(result.traces) : null,
      cpu: { userMs: round(cpu.user / 1000), systemMs: round(cpu.system / 1000) },
      rss: { beforeMb: round(rss0 / 1048576), afterMb: round(rss1 / 1048576) },
      detail: result?.detail ?? null,
      error,
    });
    if (deps.signal?.aborted) break;
  }

  const first = cpus()[0];
  const report: BenchReport = {
    schema: 1,
    label: opts.label ?? null,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, dir: project.dir },
    router: opts.router,
    routerProbe: probe
      ? {
          present: probe.present,
          ready: probe.ready,
          ...(probe.version !== undefined ? { version: probe.version } : {}),
          detail: probe.detail,
        }
      : null,
    scenario: opts.scenario,
    repeat: total,
    timeoutMs: opts.timeoutMs,
    minFrameIntervalMs,
    copperPours: opts.copperPours ?? "polygon",
    existingCopper: opts.existingCopper ?? "obstacles",
    settings: opts.settings ?? null,
    channel: services.channel,
    machine: {
      platform: platform(),
      arch: arch(),
      cpus: cpus().length,
      cpuModel: first?.model ?? "unknown",
      totalMemMb: Math.round(totalmem() / 1048576),
      loadAvg: loadavg().map((v) => Math.round(v * 100) / 100) as [number, number, number],
      bun: typeof Bun !== "undefined" ? Bun.version : "n/a",
    },
    input: {
      source: "circuit.json",
      elements: circuitJson.length,
      elementCounts,
      import: importReport
        ? {
            sha256: importReport.source.sha256,
            file: importReport.source.file,
            kicadVersion: importReport.source.kicadVersion,
            convertMs: importReport.timings.convertMs,
            totalMs: importReport.timings.totalMs,
            layers: importReport.layers.copperCount,
            failures: importReport.failures.length,
          }
        : null,
      board: {
        layers: manifest.board.layers,
        rules: rules
          ? (Object.fromEntries(
              Object.entries(rules).filter(([, v]) => typeof v === "number"),
            ) as Record<string, number>)
          : null,
      },
    },
    scope,
    srj: {
      layerCount: srj.layerCount,
      layerNames,
      connections: srj.connections.length,
      connectionsRouted: routedNames.length,
      endpoints: srj.connections
        .filter((c) => routedNames.includes(c.name))
        .reduce((n, c) => n + c.pointsToConnect.length, 0),
      obstacles: srj.obstacles.length,
      copper: extracted.copper ?? null,
      bytes: JSON.stringify(srj).length,
      extractMs: round(extracted.extractMs ?? 0),
      minTraceWidth: srj.minTraceWidth,
    },
    runs,
    summary: {
      cold: summarize(runs.filter((r) => r.kind === "cold")),
      warm: summarize(runs.filter((r) => r.kind === "warm")),
      all: summarize(runs),
    },
    path: null,
  };
  const path = join(benchDir, `${benchTimestamp(startedAt)}.json`);
  report.path = path;
  await writeJson(path, report);
  progress(1, "done");
  return report;
}

/** One-screen text rendering for the CLI and tool output. */
export function formatBenchReport(r: BenchReport): string {
  const line = (s: BenchSummary, name: string) =>
    `${name.padEnd(5)} n=${s.runs} wall ${s.wallMs ? `${s.wallMs.median} ms (min ${s.wallMs.min}, max ${s.wallMs.max})` : "-"}  complete ${s.complete?.median ?? "-"}  open ${s.open?.median ?? "-"}  frames ${s.frames?.median ?? "-"}  failures ${s.failures} timeouts ${s.timeouts} distinct ${s.distinctResults}`;
  const out = [
    `bench route ${r.router} / ${r.scenario} x${r.repeat} (timeout ${r.timeoutMs} ms, frame gate ${r.minFrameIntervalMs} ms, pours ${r.copperPours}, existing copper ${r.existingCopper}) on ${r.project.name}`,
    `machine: ${r.machine.cpuModel} x${r.machine.cpus}, load ${r.machine.loadAvg.join("/")}, bun ${r.machine.bun}, channel ${r.channel}${r.routerProbe ? `, router ${r.routerProbe.detail}` : ""}`,
    r.input.import
      ? `import: ${r.input.import.file} sha256 ${r.input.import.sha256.slice(0, 12)}… convert ${r.input.import.convertMs} ms (total ${r.input.import.totalMs} ms), ${r.input.import.layers} layers`
      : "import: (built circuit, no import report)",
    `srj: ${r.srj.layerCount} layers [${r.srj.layerNames.join(",")}], ${r.srj.connections} connections (${r.srj.connectionsRouted} routed, ${r.srj.endpoints} endpoints), ${r.srj.obstacles} obstacles${r.srj.copper ? ` (${r.srj.copper.traces} traces/${r.srj.copper.vias} vias/${r.srj.copper.pours} pours as copper)` : ""}, ${Math.round(r.srj.bytes / 1024)} KB, extract ${r.srj.extractMs} ms`,
    ...(r.scope
      ? [
          `scope: ${r.scope.components.join(",")} -> ${r.scope.connections.length} connections / ${r.scope.nets.length} nets; excluded ${r.scope.excluded.length} (${[...new Set(r.scope.excluded.map((e) => e.net))].join(",")}); unrouted ${r.scope.unroutedTraces} traces, ${r.scope.unroutedVias} vias`,
        ]
      : []),
    ...r.runs.map(
      (run) =>
        `run ${run.index + 1} ${run.kind.padEnd(4)} ${run.status.padEnd(7)} wall ${String(run.wallMs).padStart(9)} ms  router ${String(run.routerWallMs ?? "-").padStart(9)} ms  cpu ${run.cpu.userMs + run.cpu.systemMs} ms  rss ${run.rss.beforeMb}->${run.rss.afterMb} MB  frames ${run.frames}${run.framesThrottled !== null ? `+${run.framesThrottled} throttled` : ""}  ${run.complete} complete / ${run.open} open  vias ${run.vias} seg ${run.segments}${run.resultHash ? ` #${run.resultHash.slice(0, 8)}` : ""}${run.error ? `  ERROR ${run.error}` : ""}`,
    ),
    line(r.summary.cold, "cold"),
    line(r.summary.warm, "warm"),
    line(r.summary.all, "all"),
    ...(r.runs.some((run) => run.detail)
      ? [`detail: ${r.runs.find((run) => run.detail)?.detail?.slice(0, 400)}`]
      : []),
    ...(r.path ? [`report: ${r.path}`] : []),
  ];
  return out.join("\n");
}
