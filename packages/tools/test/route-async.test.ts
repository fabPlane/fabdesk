import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type CoreServices, type RouteSummary } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

async function terminal(services: CoreServices, id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const run = services.routeRuns.get(id);
    if (run && ["cancelled", "completed", "failed", "timed_out", "interrupted"].includes(run.state))
      return run;
    await Bun.sleep(5);
  }
  throw new Error(`route ${id} did not terminate`);
}

function summary(wallMs: number): RouteSummary {
  return {
    tracks: 1,
    vias: 0,
    claimedVias: 0,
    routed: 1,
    total: 1,
    trackLengthNm: 1_000_000,
    elapsedMs: wallMs,
    wallMs,
    timedOut: false,
    message: "controlled slow router complete",
    unrouted: [],
    geometry: [
      { kind: "trace", id: "slow-track", layer: 3, net: 1, points: [0, 0, 1, 1], width: 0.2 },
    ],
    log: ["controlled router entered pass 1", "controlled router completed"],
  };
}

async function harness(name: string, delayMs = 120) {
  const project = await tempProject(name);
  const boardPath = join(project.dir, "board.kicad_pcb");
  await writeFile(boardPath, "canonical-board-v1\n");
  await writeFile(join(project.dir, "board.kicad_pro"), "{}\n");
  const base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      route: async (dir, _opts, hooks) => {
        const steps = 6;
        for (let index = 0; index < steps; index++) {
          if (hooks.signal?.aborted) throw new Error("controlled router observed abort");
          await Bun.sleep(delayMs / steps);
          hooks.onProgress?.({
            state: "routing",
            phase: index < 3 ? "pass 1" : "pass 2",
            pass: index < 3 ? 1 : 2,
            routed: index,
            total: steps,
            violations: Math.max(0, 2 - index),
            log: [`frame ${index}`],
            message: `slow frame ${index}`,
          });
        }
        await writeFile(join(dir, "board.kicad_pcb"), "candidate-board-v2\n");
        return summary(delayMs);
      },
    },
  });
  const reg = createRegistry();
  const factory = contextFactory(services, project);
  const call = (name: string, args: Record<string, unknown>) =>
    reg.invoke(name, args, (ref) =>
      factory({
        def: reg.get(name)!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
  return { project, boardPath, services, call };
}

describe("durable asynchronous routing", () => {
  test("start returns promptly while progress and compact terminal status survive independent calls", async () => {
    const h = await harness("async-start", 180);
    const before = await hash(h.boardPath);
    const started = performance.now();
    const response = await h.call("route_run", { timeoutMs: 5_000, applyPolicy: "manual" });
    const startMs = performance.now() - started;
    const startBytes = Buffer.byteLength(JSON.stringify(response.json));
    expect(startMs).toBeLessThan(2_000);
    const runId = (response.json as { runId: string }).runId;
    expect(["queued", "running"]).toContain((response.json as { state: string }).state);
    await Bun.sleep(70);
    const mid = await h.call("route_status", { runId });
    const midRun = (
      mid.json as {
        run: {
          state: string;
          progress: { heartbeatAt: string; diagnostics: string[] };
          heartbeatFreshnessMs: number;
        };
      }
    ).run;
    expect(["running", "completed"]).toContain(midRun.state);
    expect(midRun.progress.diagnostics.length).toBeLessThanOrEqual(20);
    expect(midRun.heartbeatFreshnessMs).toBeLessThan(1_000);
    await terminal(h.services, runId);
    let done = h.services.routeRuns.get(runId)!;
    for (
      let attempt = 0;
      attempt < 100 && ["pending", "applying"].includes(done.application.state);
      attempt++
    ) {
      await Bun.sleep(5);
      done = h.services.routeRuns.get(runId)!;
    }
    const final = await h.call("route_status", { runId });
    const finalBytes = Buffer.byteLength(JSON.stringify(final.json));
    expect(done.state).toBe("completed");
    expect(done.candidate).toMatchObject({ available: true, reopenable: true });
    expect(done.application.state).toBe("manual");
    expect(await hash(h.boardPath)).toBe(before);
    expect(JSON.stringify(final.json)).not.toContain('"changedGeometry"');
    expect(finalBytes).toBeLessThan(20_000);
    expect(startBytes).toBeLessThan(4_000);
  });

  test("exact cancellation is idempotent and leaves canonical native bytes unchanged", async () => {
    const h = await harness("async-cancel", 600);
    const before = await hash(h.boardPath);
    const response = await h.call("route_run", { timeoutMs: 5_000, applyPolicy: "auto" });
    const runId = (response.json as { runId: string }).runId;
    await Bun.sleep(60);
    const first = await h.call("route_cancel", { runId });
    expect((first.json as { cancellation: string }).cancellation).toBe("requested");
    const second = await h.call("route_cancel", { runId });
    expect(["already_requested", "terminal"]).toContain(
      (second.json as { cancellation: string }).cancellation,
    );
    const done = await terminal(h.services, runId);
    expect(done.state).toBe("cancelled");
    expect(done.candidate.available).toBe(false);
    expect(await hash(h.boardPath)).toBe(before);
  });

  test("manual candidate applies atomically at the expected revision and stale apply does not mutate", async () => {
    const h = await harness("async-apply", 60);
    const before = await hash(h.boardPath);
    const first = await h.call("route_run", { timeoutMs: 5_000, applyPolicy: "manual" });
    const firstId = (first.json as { runId: string }).runId;
    const ready = await terminal(h.services, firstId);
    expect(await hash(h.boardPath)).toBe(before);
    const applied = await h.call("route_apply", { runId: firstId, expectedPcbRevision: before });
    const appliedRevision = (applied.json as { resultingPcbRevision: string }).resultingPcbRevision;
    expect(appliedRevision).toBe(ready.candidate.sha256);
    expect(await hash(h.boardPath)).toBe(appliedRevision);

    await writeFile(h.boardPath, "canonical-board-v3\n");
    const current = await hash(h.boardPath);
    const second = await h.call("route_run", { timeoutMs: 5_000, applyPolicy: "manual" });
    const secondId = (second.json as { runId: string }).runId;
    const secondReady = await terminal(h.services, secondId);
    await writeFile(h.boardPath, "concurrent-user-edit\n");
    const edited = await hash(h.boardPath);
    await expect(
      h.call("route_apply", { runId: secondId, expectedPcbRevision: current }),
    ).rejects.toThrow(/stale PCB revision/);
    expect(await hash(h.boardPath)).toBe(edited);
    expect(h.services.routeRuns.get(secondId)?.application.state).toBe("stale");
    expect(secondReady.candidate.available).toBe(true);
  });

  test("auto apply leaves a ready candidate unapplied when canonical revision changes", async () => {
    const h = await harness("async-auto-stale", 140);
    const response = await h.call("route_run", { timeoutMs: 5_000 });
    const runId = (response.json as { runId: string }).runId;
    await Bun.sleep(50);
    await writeFile(h.boardPath, "user-edit-during-route\n");
    const edited = await hash(h.boardPath);
    await terminal(h.services, runId);
    let done = h.services.routeRuns.get(runId)!;
    for (
      let attempt = 0;
      attempt < 100 && ["pending", "applying"].includes(done.application.state);
      attempt++
    ) {
      await Bun.sleep(5);
      done = h.services.routeRuns.get(runId)!;
    }
    expect(done.candidate.available).toBe(true);
    expect(done.application.state).toBe("stale");
    expect(await hash(h.boardPath)).toBe(edited);
  });

  test("atomic apply restores prior native bytes when reopen validation fails", async () => {
    const h = await harness("async-rollback", 60);
    const before = await hash(h.boardPath);
    const response = await h.call("route_run", { timeoutMs: 5_000, applyPolicy: "manual" });
    const runId = (response.json as { runId: string }).runId;
    await terminal(h.services, runId);
    const query = h.services.design.query;
    h.services.design.query = async (dir, select, filter) => {
      if (dir === h.project.dir && select === "nets")
        throw new Error("controlled reopen validation failure");
      return query(dir, select, filter);
    };
    await expect(h.call("route_apply", { runId, expectedPcbRevision: before })).rejects.toThrow(
      /controlled reopen validation failure/,
    );
    expect(await hash(h.boardPath)).toBe(before);
    expect(h.services.routeRuns.get(runId)?.application).toMatchObject({ state: "failed" });
    expect(h.services.routeRuns.get(runId)?.application.reason).toContain("prior board restored");
  });
});
