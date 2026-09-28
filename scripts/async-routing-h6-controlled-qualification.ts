/** Deterministic seconds-scale reproduction of the synchronous timeout class and H6 recovery. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../packages/tools/src";
import { contextFactory, mockServices, tempProject } from "../packages/tools/test/mock-services";

const delayMs = 350;
const project = await tempProject("h6-controlled-qualification");
const boardPath = join(project.dir, "board.kicad_pcb");
await writeFile(boardPath, "controlled-canonical-v1\n");
await writeFile(join(project.dir, "board.kicad_pro"), "{}\n");
const before = createHash("sha256")
  .update(await readFile(boardPath))
  .digest("hex");
const base = mockServices([project]);
const services = mockServices([project], {
  design: {
    ...base.design,
    route: async (dir, _opts, hooks) => {
      for (let step = 1; step <= 7; step++) {
        await Bun.sleep(delayMs / 7);
        hooks.signal?.throwIfAborted();
        hooks.onProgress?.({
          state: "routing",
          phase: step < 5 ? "pass 1" : "pass 2",
          pass: step < 5 ? 1 : 2,
          routed: step,
          total: 7,
          violations: 7 - step,
          log: [`controlled frame ${step}`],
        });
      }
      await writeFile(join(dir, "board.kicad_pcb"), "controlled-candidate-v2\n");
      return {
        tracks: 1,
        vias: 0,
        claimedVias: 0,
        routed: 7,
        total: 7,
        trackLengthNm: 1_000_000,
        elapsedMs: delayMs,
        wallMs: delayMs,
        timedOut: false,
        message: "controlled route complete",
        unrouted: [],
        geometry: [
          {
            kind: "trace" as const,
            id: "track",
            layer: 3,
            net: 1,
            points: [0, 0, 1, 1],
            width: 0.2,
          },
        ],
        log: ["controlled route complete"],
      };
    },
  },
});
const registry = createRegistry();
const factory = contextFactory(services, project);
async function call(name: string, args: Record<string, unknown>) {
  const started = performance.now();
  const output = await registry.invoke(name, args, (ref) =>
    factory({
      def: registry.get(name)!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
  return {
    output,
    ms: performance.now() - started,
    bytes: Buffer.byteLength(JSON.stringify(output.json)),
  };
}

const beforeClock = performance.now();
await Bun.sleep(delayMs); // Prior synchronous route_run kept this request open for the route lifetime.
const synchronousBoundaryMs = performance.now() - beforeClock;
const start = await call("route_run", { timeoutMs: 5_000, applyPolicy: "manual" });
const runId = (start.output.json as { runId: string }).runId;
await Bun.sleep(120);
const mid = await call("route_status", { runId });
let run = services.routeRuns.get(runId)!;
while (!["completed", "failed", "cancelled", "timed_out", "interrupted"].includes(run.state)) {
  await Bun.sleep(10);
  run = services.routeRuns.get(runId)!;
}
const final = await call("route_status", { runId });
const after = createHash("sha256")
  .update(await readFile(boardPath))
  .digest("hex");

process.stdout.write(
  `${JSON.stringify(
    {
      controlledDelayMs: delayMs,
      before: { synchronousBoundaryMs },
      after: {
        start: { ms: start.ms, bytes: start.bytes, state: (start.output.json as any).state },
        independentStatus: {
          ms: mid.ms,
          bytes: mid.bytes,
          state: (mid.output.json as any).run.state,
          progress: (mid.output.json as any).run.progress,
        },
        finalStatus: {
          ms: final.ms,
          bytes: final.bytes,
          state: (final.output.json as any).run.state,
        },
      },
      runId,
      canonical: { before, after, unchanged: before === after },
      candidate: run.candidate,
    },
    null,
    2,
  )}\n`,
);
