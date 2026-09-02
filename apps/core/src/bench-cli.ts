/**
 * `fabdesk-core bench route`: the route benchmark against a project directory without a running
 * daemon. Builds the same services the daemon would (real tscircuit + RouterHost worker) minus the
 * database, so numbers are comparable with `POST /bench/route`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectManifest, type RouteResult, type RouterWorkerMessage } from "@fabdesk/protocol";
import {
  PROJECT_FILES,
  benchRoute,
  formatBenchReport,
  writeJson,
  type BenchDeps,
  type BenchReport,
  type BenchRouteOptions,
  type ProjectHandle,
  type RouteRunRecord,
} from "@fabdesk/tools";
import { channel } from "./config";

export async function projectFromDir(dir: string): Promise<ProjectHandle> {
  const manifestPath = join(dir, PROJECT_FILES.manifest);
  let current = ProjectManifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  return {
    id: current.id,
    name: current.name,
    dir,
    manifest: () => current,
    async updateManifest(patch) {
      current = ProjectManifest.parse({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await writeJson(manifestPath, current);
      return current;
    },
  };
}

export async function runBenchCli(opts: {
  dir: string;
  bench: BenchRouteOptions;
  json?: string;
  onProgress?: (p: number, note?: string) => void;
  quiet?: boolean;
}): Promise<BenchReport> {
  const tsc = await import("@fabdesk/tscircuit");
  const { RouterHost, availableRouters } = await import("@fabdesk/router");
  const { routerHostOptions } = await import("./router-worker-url");
  const project = await projectFromDir(opts.dir);
  const host = new RouterHost(routerHostOptions());
  const runs = new Map<string, RouteRunRecord>();
  const services: BenchDeps["services"] = {
    channel: channel(),
    tscircuit: {
      buildCircuit: async () => {
        throw new Error("not available in bench");
      },
      runChecks: async () => ({ errors: [] }),
      queryCircuit: () => [],
      extractSimpleRouteJson: (cj, o) => tsc.extractSimpleRouteJson(cj, o ?? {}),
      connectionsForComponents: (cj, refs, o) => tsc.connectionsForComponents(cj, refs, o ?? {}),
      mergeTraces: (cj, traces, map) => tsc.mergeTraces(cj, traces, map),
      unrouteCircuit: (cj, conns) => tsc.unrouteCircuit(cj, conns),
      schematicSvg: () => "",
      pcbSvg: () => "",
    },
    router: {
      route: (
        request,
        { onMessage, signal }: { onMessage(m: RouterWorkerMessage): void; signal?: AbortSignal },
      ): Promise<RouteResult> => host.route(request, { onMessage, signal }),
      cancel: () => host.cancel(),
      available: () => availableRouters(),
    },
    bus: { emit: () => {} },
    routeRuns: {
      start: (r) =>
        runs.set(r.id, { ...r, status: "running", endedAt: null, result: null, error: null }),
      finish: (id, patch) => {
        const r = runs.get(id);
        if (r) runs.set(id, { ...r, ...patch, endedAt: new Date().toISOString() });
      },
      get: (id) => runs.get(id) ?? null,
      latest: () => null,
    },
  };
  try {
    const report = await benchRoute(
      { project, services, ...(opts.onProgress ? { progress: opts.onProgress } : {}) },
      opts.bench,
    );
    if (opts.json) await writeJson(opts.json, report);
    if (!opts.quiet) process.stderr.write(formatBenchReport(report) + "\n");
    return report;
  } finally {
    host.dispose();
  }
}
