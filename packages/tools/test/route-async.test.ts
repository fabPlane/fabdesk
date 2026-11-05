import { NativeRevisionConflict } from "../src/registry";
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
  await writeFile(boardPath, '(kicad_pcb (net "N1") (property "test" "v1"))\n');
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
        await writeFile(
          join(dir, "board.kicad_pcb"),
          '(kicad_pcb (net "N1") (property "test" "v2"))\n',
        );
        return summary(delayMs);
      },
    },
  });
  const reg = createRegistry();
  const factory = contextFactory(services, project);
  const call = (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal = new AbortController().signal,
  ) =>
    reg.invoke(name, args, (ref) =>
      factory({
        def: reg.get(name)!,
        projectRef: ref,
        signal,
        progress: () => {},
      }),
    );
  return { project, boardPath, services, call };
}

describe("durable asynchronous routing", () => {
  test("no-progress application reason preserves the router diagnosis", async () => {
    const h = await harness("async-no-progress-detail");
    const diagnosis = "solver stopped stagnant; N1 remains open; partial copper discarded";
    h.services.design.route = async () => ({
      ...summary(1),
      tracks: 0,
      routed: 0,
      geometry: [],
      message: diagnosis,
      unrouted: [{ net: "N1", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }],
    });
    const response = await h.call("route_run", { router: "fab_router", waitMs: 0 });
    const run = await terminal(h.services, (response.json as { runId: string }).runId);
    expect(run.candidate.available).toBe(false);
    expect(run.application.state).toBe("not_available");
    expect(run.application.reason).toBe(diagnosis);
  });
  test("start returns promptly while progress and compact terminal status survive independent calls", async () => {
    const h = await harness("async-start", 180);
    const before = await hash(h.boardPath);
    const started = performance.now();
    const response = await h.call("route_run", {
      timeoutMs: 5_000,
      applyPolicy: "manual",
      waitMs: 0,
    });
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
    const response = await h.call("route_run", {
      timeoutMs: 5_000,
      applyPolicy: "auto",
      waitMs: 0,
    });
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

    const other = await tempProject("async-other-project"), reg = createRegistry(), otherFactory = contextFactory(h.services, other);
    await expect(reg.invoke("route_apply", { runId: firstId, expectedPcbRevision: before }, projectRef => otherFactory({ def: reg.get("route_apply")!, projectRef, signal: new AbortController().signal, progress: () => {} }))).rejects.toThrow("another project");
    expect(await hash(h.boardPath)).toBe(appliedRevision);

    await writeFile(h.boardPath, '(kicad_pcb (net "N1") (property "test" "v3"))\n');
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
    const response = await h.call("route_run", { timeoutMs: 5_000, waitMs: 0 });
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

  test("route apply refuses unsaved live work without release or rollback", async () => {
    const h = await harness("async-live-refusal", 60);
    const before = await hash(h.boardPath);
    const response = await h.call("route_run", { timeoutMs: 5_000, applyPolicy: "manual" });
    const runId = (response.json as { runId: string }).runId;
    await terminal(h.services, runId);
    let releases = 0;
    const release = h.services.design.release;
    h.services.design.release = async (dir) => {
      if (dir === h.project.dir) releases++;
      return release(dir);
    };
    h.services.design.withSavedFilesRecovery = async () => {
      throw new NativeRevisionConflict("live document has unsaved or unknown changes");
    };
    await expect(h.call("route_apply", { runId, expectedPcbRevision: before })).rejects.toThrow(
      "unsaved or unknown",
    );
    expect(releases).toBe(0);
    expect(await hash(h.boardPath)).toBe(before);
    expect(h.services.routeRuns.get(runId)?.application.reason).toContain("unsaved or unknown");
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

type InlineRun = {
  runId: string;
  state: string;
  run?: {
    id: string;
    state: string;
    heartbeatFreshnessMs: number;
    candidate: { available: boolean; sha256: string | null };
    application: { state: string; reason: string | null; resultingPcbRevision: string | null };
  };
  nextActions: Array<{ tool: string; runId: string; expectedPcbRevision?: string }>;
};

const withoutFreshness = (run: Record<string, unknown> | undefined) => {
  const { heartbeatFreshnessMs: _, ...rest } = run ?? {};
  return rest;
};

describe("route_run inline result", () => {
  test("a run finishing within the wait returns route_status's content for that run", async () => {
    const h = await harness("inline-terminal", 60);
    const before = await hash(h.boardPath);
    const response = await h.call("route_run", {
      timeoutMs: 5_000,
      applyPolicy: "manual",
      waitMs: 5_000,
    });
    const json = response.json as InlineRun;
    expect(json.state).toBe("completed");
    expect(json.run?.state).toBe("completed");
    expect(json.run?.candidate.available).toBe(true);
    expect(json.run?.application.state).toBe("manual");
    // A manual candidate is the only follow-up; status/cancel are not next actions for a finished run.
    expect(json.nextActions).toEqual([
      { tool: "route_apply", runId: json.runId, expectedPcbRevision: before },
    ]);
    const status = await h.call("route_status", { runId: json.runId });
    expect(response.text).toBe(status.text);
    expect(withoutFreshness((status.json as InlineRun).run)).toEqual(withoutFreshness(json.run));
    expect(await hash(h.boardPath)).toBe(before);
  });

  test("a run still going when the wait ends returns the running response", async () => {
    const h = await harness("inline-running", 600);
    const started = performance.now();
    const response = await h.call("route_run", {
      timeoutMs: 5_000,
      applyPolicy: "manual",
      waitMs: 100,
    });
    expect(performance.now() - started).toBeLessThan(500);
    const json = response.json as InlineRun & { run?: unknown };
    expect(json.state).toBe("running");
    expect(json.run).toBeUndefined();
    expect(json.nextActions).toEqual([
      { tool: "route_status", runId: json.runId },
      { tool: "route_cancel", runId: json.runId },
    ]);
    expect(response.text).toContain("computation continues independently");
    expect((await terminal(h.services, json.runId)).state).toBe("completed");
  });

  test("waitMs 0 returns the running response at once, as before", async () => {
    const h = await harness("inline-zero", 60);
    const response = await h.call("route_run", {
      timeoutMs: 5_000,
      applyPolicy: "manual",
      waitMs: 0,
    });
    const json = response.json as Record<string, unknown> & { runId: string };
    expect(Object.keys(json).filter((key) => key !== "_contract")).toEqual([
      "runId",
      "state",
      "router",
      "runtimeId",
      "startingPcbRevision",
      "requested",
      "applyPolicy",
      "nextActions",
    ]);
    expect(json["state"]).toBe("running");
    expect(response.text).toBe(
      `Route ${json.runId} (fab_router) running; computation continues independently. Use route_status with this runId or route_cancel with this exact runId.`,
    );
    await terminal(h.services, json.runId);
  });

  test("auto apply within the wait reports the application outcome", async () => {
    const applied = await harness("inline-auto-applied", 60);
    const appliedJson = (await applied.call("route_run", { timeoutMs: 5_000, waitMs: 5_000 }))
      .json as InlineRun;
    expect(appliedJson.state).toBe("completed");
    expect(appliedJson.run?.application.state).toBe("applied");
    expect(appliedJson.run?.application.resultingPcbRevision).toBe(await hash(applied.boardPath));
    expect(appliedJson.nextActions).toEqual([]);

    const stale = await harness("inline-auto-stale", 140);
    const edit = Bun.sleep(50).then(() => writeFile(stale.boardPath, "user-edit-during-route\n"));
    const staleResponse = await stale.call("route_run", { timeoutMs: 5_000, waitMs: 5_000 });
    await edit;
    const staleJson = staleResponse.json as InlineRun;
    expect(staleJson.state).toBe("completed");
    expect(staleJson.run?.application.state).toBe("stale");
    expect(staleJson.run?.application.reason).toBeTruthy();
    expect(staleResponse.text).toContain("apply stale");
    expect(staleJson.nextActions).toEqual([]);
  });

  test("aborting the request during the wait leaves the run going", async () => {
    const h = await harness("inline-abort", 300);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = performance.now();
    const response = await h.call(
      "route_run",
      { timeoutMs: 5_000, applyPolicy: "manual", waitMs: 10_000 },
      controller.signal,
    );
    expect(performance.now() - started).toBeLessThan(250);
    const json = response.json as InlineRun;
    expect(json.state).toBe("running");
    const done = await terminal(h.services, json.runId);
    expect(done.state).toBe("completed");
    expect(done.candidate.available).toBe(true);
  });
});
