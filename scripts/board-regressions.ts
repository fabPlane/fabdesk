#!/usr/bin/env bun
/** Real compile -> place -> pre-route DRC -> route -> post-route DRC regression runner. */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  casesForTier,
  evaluateCase,
  type DrcReport,
  type RegressionCase,
  type RegressionManifest,
  type RegressionTier,
  type RouteObservation,
} from "./lib/board-regression";

const ROOT = resolve(import.meta.dir, "..");
const CASES = join(ROOT, "docs", "router-cases");
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
};
const tier = (arg("tier") ?? "pr") as RegressionTier;
if (tier !== "pr" && tier !== "nightly") throw new Error("--tier must be pr or nightly");
const only = arg("case");
const output = resolve(arg("output") ?? join(ROOT, "artifacts", "board-regressions.json"));
const url = (process.env["FABDESK_URL"] ?? "http://127.0.0.1:47831").replace(/\/$/, "");
const token = process.env["FABDESK_TOKEN"];
if (!token) throw new Error("FABDESK_TOKEN is required");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

interface NetlistSource {
  netlist?: { components?: Array<{ footprint?: unknown }> };
  libraries?: Array<{ kind: string; nickname: string; uri: string }>;
}

async function loadNetlistSource(filename: string): Promise<NetlistSource> {
  const source = (await Bun.file(filename).json()) as NetlistSource;
  const footprintRoot = process.env["KICAD10_FOOTPRINT_DIR"];
  if (!footprintRoot) return source;
  const libraries = source.libraries ?? [];
  const declared = new Set(libraries.map((library) => library.nickname));
  const nicknames = new Set(
    (source.netlist?.components ?? [])
      .map((component) =>
        typeof component.footprint === "string" ? component.footprint.split(":", 1)[0] : undefined,
      )
      .filter((nickname): nickname is string => Boolean(nickname)),
  );
  source.libraries = [
    ...libraries,
    ...[...nicknames]
      .filter((nickname) => !declared.has(nickname))
      .map((nickname) => ({
        kind: "footprint",
        nickname,
        uri: join(footprintRoot, `${nickname}.pretty`),
      })),
  ];
  return source;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function tool(
  project: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const res = await fetch(`${url}/tools/${name}?sync=1`, {
    method: "POST",
    headers,
    body: JSON.stringify({ project, args }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok && res.status !== 422)
    throw new Error(`${name} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as { ok?: boolean; text?: string; error?: string; json?: unknown };
}

const readDrc = (project: string) =>
  request<DrcReport>("GET", `/projects/${project}/files/reports/drc.json`);

async function probeBridge(): Promise<void> {
  const doctor = await request<{
    routers?: Array<{ id?: string; present?: boolean; ready?: boolean; detail?: string }>;
  }>("GET", "/doctor", undefined, 4_000);
  const router =
    doctor.routers?.find((candidate) => candidate.id === "fp-pcb") ?? doctor.routers?.[0];
  if (!router?.ready)
    throw new Error(router?.detail ?? "doctor did not report a healthy PCB bridge");
}

async function monitorBridge(
  stop: Promise<void>,
  failures: string[],
  onFailure: () => void,
): Promise<void> {
  for (;;) {
    const stopped = await Promise.race([stop.then(() => true), Bun.sleep(5_000).then(() => false)]);
    if (stopped) return;
    try {
      await probeBridge();
    } catch (error) {
      failures.push(
        `bridge health probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      onFailure();
      return;
    }
  }
}

async function runCase(spec: RegressionCase) {
  const startedAt = new Date().toISOString();
  const project = await request<{ id: string; path: string }>("POST", "/projects", {
    name: `regression-${spec.id}-${Date.now().toString(36)}`,
  });
  const livenessFailures: string[] = [];
  try {
    await request(
      "PUT",
      `/projects/${project.id}/files/circuit.netlist.json`,
      await loadNetlistSource(join(CASES, spec.netlist)),
    );
    const build = await tool(project.id, "circuit_build", { fresh: true }, 120_000);
    if (build.ok === false || build.error)
      throw new Error(`build: ${build.error ?? build.text ?? "failed"}`);
    if (spec.placement) {
      const placements = await Bun.file(join(CASES, spec.placement)).json();
      const placed = await tool(project.id, "circuit_place", { placements }, 60_000);
      if (placed.ok === false || placed.error)
        throw new Error(`place: ${placed.error ?? placed.text ?? "failed"}`);
    }
    await tool(project.id, "verify_drc", {}, 60_000);
    const before = await readDrc(project.id);

    let stopMonitor = () => {};
    const stopped = new Promise<void>((resolveStop) => (stopMonitor = resolveStop));
    const routeAbort = new AbortController();
    const monitor = monitorBridge(stopped, livenessFailures, () => routeAbort.abort());
    let routeBody: { ok?: boolean; text?: string; error?: string; json?: unknown };
    const routeStarted = performance.now();
    try {
      routeBody = await tool(
        project.id,
        "route_run",
        { timeoutMs: spec.routeTimeoutMs },
        spec.hardTimeoutMs,
        routeAbort.signal,
      );
    } finally {
      stopMonitor();
      await monitor;
    }
    const wallMs = Math.round(performance.now() - routeStarted);
    const route = (routeBody.json ?? {}) as {
      timedOut?: boolean;
      open?: unknown[];
      stats?: { wallMs?: number };
    };
    const observation: RouteObservation = {
      timedOut: route.timedOut ?? /timed out/i.test(routeBody.error ?? routeBody.text ?? ""),
      unrouted: Array.isArray(route.open) ? route.open : [],
      ...(route.stats?.wallMs !== undefined ? { elapsedMs: route.stats.wallMs } : {}),
    };
    await tool(project.id, "verify_drc", {}, 60_000);
    const after = await readDrc(project.id);
    return {
      id: spec.id,
      quality: spec.quality,
      startedAt,
      wallMs,
      preRoute: before.counts,
      postRoute: after.counts,
      route: observation,
      ...evaluateCase(spec, before, after, observation, livenessFailures),
    };
  } catch (error) {
    return {
      id: spec.id,
      quality: spec.quality,
      startedAt,
      failures: [error instanceof Error ? error.message : String(error), ...livenessFailures],
      observations: [],
      introducedErrors: {},
    };
  } finally {
    await request("DELETE", `/projects/${project.id}?purge=1`, undefined, 30_000).catch((error) =>
      console.error(
        `${spec.id}: cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

const manifest = (await Bun.file(join(CASES, "manifest.json")).json()) as RegressionManifest;
let selected = casesForTier(manifest, tier);
if (only) selected = selected.filter((spec) => spec.id === only);
if (!selected.length)
  throw new Error(`no regression cases selected${only ? ` for --case ${only}` : ""}`);
console.log(`board regressions: ${tier} (${selected.map((spec) => spec.id).join(", ")})`);
const results = [];
for (const spec of selected) {
  console.log(`\n[${spec.id}] compile -> place -> pre-DRC -> route -> post-DRC`);
  const result = await runCase(spec);
  results.push(result);
  for (const observation of result.observations) console.log(`  observe: ${observation}`);
  for (const failure of result.failures) console.error(`  FAIL: ${failure}`);
  if (!result.failures.length)
    console.log(`  pass${"wallMs" in result ? ` (${result.wallMs} ms)` : ""}`);
}
const summary = {
  schema: 1,
  tier,
  generatedAt: new Date().toISOString(),
  passed: results.every((result) => result.failures.length === 0),
  results,
};
await mkdir(dirname(output), { recursive: true });
await Bun.write(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nreport: ${output}`);
process.exit(summary.passed ? 0 : 1);
