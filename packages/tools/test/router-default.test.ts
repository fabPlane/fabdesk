import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createRegistry,
  JobTimeoutError,
  type RouteJobOptions,
  type RouteRunRecord,
  type RouteSummary,
} from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const summary = (): RouteSummary => ({
  tracks: 1,
  vias: 0,
  claimedVias: 0,
  routed: 1,
  total: 1,
  trackLengthNm: 1,
  elapsedMs: 1,
  wallMs: 1,
  timedOut: false,
  message: "complete",
  unrouted: [],
  log: [],
  geometry: [{ kind: "trace", id: "t", layer: 3, net: 1, points: [0, 0, 1, 1] }],
});

async function routeCase(
  pin: "capacity" | "freerouting" | "fab_router" | undefined,
  first:
    | "failure"
    | "failure-with-timeout-log"
    | "deadline"
    | "partial"
    | "timeout"
    | "unavailable"
    | "complete",
  explicit?: string,
  selective = false,
) {
  const original = await tempProject(`default-${first}-${pin ?? "auto"}`);
  const { router: _router, ...manifest } = original.manifest();
  const project = {
    ...original,
    manifest: () => ({ ...manifest, ...(pin ? { router: pin } : {}) }),
  };
  await writeFile(
    join(project.dir, "board.kicad_pcb"),
    '(kicad_pcb (net "N1") (property "test" "original"))',
  );
  await writeFile(join(project.dir, "board.kicad_pro"), "original-pro");
  const base = mockServices([project]);
  const calls: RouteJobOptions[] = [];
  const services = mockServices([project], {
    design: {
      ...base.design,
      status: async () => ({
        url: "mock",
        ok: true,
        routers: { freerouting: { ok: first !== "unavailable", reason: "jar missing" } },
      }),
      route: async (dir, opts, hooks) => {
        calls.push(opts);
        if (
          calls.length === 1 &&
          ["failure", "failure-with-timeout-log", "deadline"].includes(first)
        ) {
          await writeFile(join(dir, "board.kicad_pcb"), "failed-job-mutated-snapshot");
          if (first === "deadline")
            throw new JobTimeoutError("route exceeded its computation budget");
          if (first === "failure-with-timeout-log")
            throw new Error("Java crashed; network timeout in diagnostic log");
          throw new Error("Java crashed; no session written");
        }
        if (calls.length === 2) {
          expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toBe(
            '(kicad_pcb (net "N1") (property "test" "original"))',
          );
          expect(await readFile(join(dir, "board.kicad_pro"), "utf8")).toBe("original-pro");
        }
        hooks.onProgress?.({
          state: "routing",
          phase: "pass 3",
          pass: 3,
          routed: 1,
          total: 2,
          log: [],
        });
        await writeFile(
          join(dir, "board.kicad_pcb"),
          '(kicad_pcb (net "N1") (property "test" "candidate"))',
        );
        return {
          ...summary(),
          ...(first === "partial"
            ? { total: 2, unrouted: [{ net: "N2", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }] }
            : {}),
          timedOut: first === "timeout",
        };
      },
    },
  });
  const registry = createRegistry({ channel: "public" });
  const factory = contextFactory(services, project);
  const output = await registry.invoke(
    "route_run",
    {
      waitMs: 1000,
      applyPolicy: "manual",
      ...(explicit ? { router: explicit } : {}),
      ...(selective ? { onlyConnections: ["N1"] } : {}),
    },
    (ref) =>
      factory({
        def: registry.get("route_run")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  const record = (output.json as { run: RouteRunRecord }).run;
  return { calls, record, output, project };
}

test("new unpinned project uses Freerouting and persists pass progress", async () => {
  const { calls, record } = await routeCase(undefined, "complete");
  expect(calls.map((call) => call.router)).toEqual(["freerouting"]);
  expect(record.router).toBe("freerouting");
  expect(record.progress.pass).toBe(3);
  expect(record.attempts?.[0]?.outcome).toBe("completed");
  expect(calls[0]?.freerouting?.passes).toBe(100);
});
test("automatic failure restores original snapshot and records both attempts and producer", async () => {
  const { calls, record, output } = await routeCase(undefined, "failure");
  expect(calls.map((call) => call.router)).toEqual(["freerouting", "fab_router"]);
  expect(record.router).toBe("fab_router");
  expect(record.attempts?.map((attempt) => attempt.outcome)).toEqual(["failed", "completed"]);
  expect(output.text).toContain("Fallback: Freerouting failed: Java crashed");
});
test("explicit Freerouting fails without retrying a crash", async () => {
  const { calls, record } = await routeCase(undefined, "failure", "freerouting");
  expect(calls).toHaveLength(1);
  expect(record.state).toBe("failed");
});
test("a genuine crash mentioning timeout still falls back", async () => {
  const { calls, record } = await routeCase(undefined, "failure-with-timeout-log");
  expect(calls.map((call) => call.router)).toEqual(["freerouting", "fab_router"]);
  expect(record.attempts?.map((attempt) => attempt.outcome)).toEqual(["failed", "completed"]);
  expect(record.fallbackReason).toContain("network timeout");
});
test("a structured deadline does not fall back even without timeout words", async () => {
  const { calls, record } = await routeCase(undefined, "deadline");
  expect(calls).toHaveLength(1);
  expect(record.state).toBe("timed_out");
  expect(record.attempts?.[0]?.outcome).toBe("timed_out");
});
for (const first of ["partial", "timeout"] as const)
  test(`${first} Freerouting result does not trigger fallback`, async () => {
    const { calls, record } = await routeCase(undefined, first);
    expect(calls).toHaveLength(1);
    expect(record.router).toBe("freerouting");
    expect(record.fallbackReason).toBeNull();
  });
for (const explicit of [undefined, "freerouting"])
  test(`unavailable Freerouting falls back (${explicit ?? "auto"})`, async () => {
    const { calls, record } = await routeCase(undefined, "unavailable", explicit);
    expect(calls.map((call) => call.router)).toEqual(["fab_router"]);
    expect(record.attempts?.map((attempt) => attempt.outcome)).toEqual([
      "unavailable",
      "completed",
    ]);
    expect(record.fallbackReason).toContain("jar missing");
  });
test("existing capacity manifest keeps fab_router and is never migrated", async () => {
  const { calls, project } = await routeCase("capacity", "complete");
  expect(calls.map((call) => call.router)).toEqual(["fab_router"]);
  expect(project.manifest().router).toBe("capacity");
});
test("automatic selective routing uses fab_router with a truthful skipped attempt", async () => {
  const { calls, record } = await routeCase(undefined, "complete", undefined, true);
  expect(calls.map((call) => call.router)).toEqual(["fab_router"]);
  expect(record.attempts?.[0]?.outcome).toBe("skipped");
  expect(record.fallbackReason).toBe("Automatic selective reroutes use fab_router");
  expect(record.fallbackReason).not.toMatch(/FFC|DSN|evaluation|DRC/);
});
