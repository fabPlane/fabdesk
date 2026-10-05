import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type CoreServices, type RouteSummary } from "../../src";
import { contextFactory, mockServices, tempProject } from "../mock-services";

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

const h = await harness("write-failure", 400);
h.services.design.route = async (dir, _opts, hooks) => {
  const rec = h.services.routeRuns.latest(h.project.id)!;
  const path = join(h.project.dir, rec.artifacts.runDir, "progress.json");
  await rm(path, { force: true });
  await mkdir(path); // Inject EISDIR after initial persistence.
  for (let i = 0; i < 64; i++) hooks.onProgress?.({ state: "routing", routed: i, total: 64 });
  await Bun.sleep(250); // Rejection happens while the bridge is still routing.
  await rm(path, { recursive: true });
  await writeFile(join(dir, "board.kicad_pcb"), "candidate-board-v2\n");
  return summary(250);
};
const response = await h.call("route_run", {
  timeoutMs: 5000,
  applyPolicy: "manual",
  waitMs: 5000,
});
const id = (response.json as { runId: string }).runId;
const done = await terminal(h.services, id);
const disk = JSON.parse(
  await readFile(join(h.project.dir, done.artifacts.runDir, "progress.json"), "utf8"),
);
if (done.state !== "completed" || disk.state !== "completed") throw new Error("route failed");
console.log(
  JSON.stringify({ state: done.state, diskState: disk.state, alive: true, progressFrames: 64 }),
);
