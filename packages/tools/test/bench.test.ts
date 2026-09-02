import { describe, expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { benchRoute, formatBenchReport, resultHash, summarize, type BenchRun } from "../src";
import { mockServices, tempProject } from "./mock-services";

const run = (over: Partial<BenchRun>): BenchRun => ({
  index: 0,
  kind: "warm",
  runId: "r",
  status: "done",
  wallMs: 10,
  routerWallMs: 9,
  frames: 3,
  framesThrottled: 0,
  framesConnection: 1,
  frameBytes: 100,
  maxFrameShapes: 2,
  complete: 1,
  open: 0,
  openConnections: [],
  timedOut: false,
  vias: 0,
  segments: 1,
  resultHash: "a",
  cpu: { userMs: 1, systemMs: 1 },
  rss: { beforeMb: 1, afterMb: 1 },
  detail: null,
  error: null,
  ...over,
});

describe("bench helpers", () => {
  test("summarize reports median/min/max, failures, timeouts and distinct results", () => {
    const s = summarize([
      run({ wallMs: 30, resultHash: "a" }),
      run({ wallMs: 10, resultHash: "b" }),
      run({ wallMs: 20, resultHash: "a", timedOut: true }),
      run({ status: "failed", wallMs: 999, resultHash: null }),
    ]);
    expect(s.runs).toBe(4);
    expect(s.wallMs).toEqual({ median: 20, min: 10, max: 30 });
    expect(s.failures).toBe(1);
    expect(s.timeouts).toBe(1);
    expect(s.distinctResults).toBe(2);
    expect(summarize([]).wallMs).toBeNull();
  });
  test("resultHash ignores trace order and sub-0.1µm noise", () => {
    const a = {
      type: "pcb_trace" as const,
      pcb_trace_id: "1",
      connection_name: "A",
      route: [
        { route_type: "wire" as const, x: 0, y: 0, width: 0.15, layer: "top" },
        { route_type: "wire" as const, x: 1, y: 0, width: 0.15, layer: "top" },
      ],
    };
    const b = { ...a, pcb_trace_id: "2", connection_name: "B" };
    expect(resultHash([a, b])).toBe(resultHash([b, a]));
    expect(resultHash([{ ...a, route: [{ ...a.route[0]!, x: 0.000001 }, a.route[1]!] }])).toBe(
      resultHash([a]),
    );
    expect(resultHash([{ ...a, route: [{ ...a.route[0]!, x: 0.01 }, a.route[1]!] }])).not.toBe(
      resultHash([a]),
    );
  });
});

describe("benchRoute", () => {
  test("runs N routes through the router service, streams frames on the bus and persists a report", async () => {
    const project = await tempProject("bench");
    const services = mockServices([project]);
    await writeFile(
      join(project.dir, "circuit.json"),
      JSON.stringify([
        { type: "pcb_board", width: 20, height: 20, num_layers: 2 },
        { type: "source_trace", source_trace_id: "N1", connected_source_port_ids: ["p1", "p2"] },
      ]),
    );
    const notes: string[] = [];
    const report = await benchRoute(
      { project, services, progress: (_p, n) => n && notes.push(n) },
      { router: "capacity", scenario: "full", repeat: 3, timeoutMs: 5000, label: "unit" },
    );
    expect(report.runs).toHaveLength(3);
    expect(report.runs.map((r) => r.kind)).toEqual(["cold", "warm", "warm"]);
    expect(report.summary.cold.runs).toBe(1);
    expect(report.summary.warm.runs).toBe(2);
    expect(report.summary.all.failures).toBe(0);
    expect(report.summary.all.distinctResults).toBe(1);
    expect(report.runs[0]?.complete).toBe(1);
    expect(report.runs[0]?.frames).toBe(3);
    expect(report.srj.layerNames).toEqual(["top", "bottom"]);
    expect(report.scope).toBeNull();
    expect(report.machine.cpus).toBeGreaterThan(0);
    expect(services.events.filter((e) => e.topic === "route.frame").length).toBe(9);
    expect(services.events.filter((e) => e.topic === "route.done").length).toBe(3);
    expect(services.routeRuns.get(report.runs[1]!.runId)?.status).toBe("done");
    const files = await readdir(join(project.dir, ".fabdesk", "bench"));
    expect(files).toHaveLength(1);
    expect(report.path).toBe(join(project.dir, ".fabdesk", "bench", files[0]!));
    expect(
      await Bun.file(
        join(project.dir, ".fabdesk", "runs", report.runs[0]!.runId, "frames.jsonl"),
      ).exists(),
    ).toBe(true);
    expect(formatBenchReport(report)).toContain("cold  n=1");
    expect(notes.some((n) => n.startsWith("run 3/3"))).toBe(true);
  });

  test("repair scenario resolves the scope and routes only those connections", async () => {
    const project = await tempProject("bench-repair");
    const services = mockServices([project]);
    await writeFile(
      join(project.dir, "circuit.json"),
      JSON.stringify([{ type: "pcb_board", width: 20, height: 20, num_layers: 2 }]),
    );
    const report = await benchRoute(
      { project, services },
      {
        router: "capacity",
        scenario: "repair",
        repeat: 1,
        timeoutMs: 5000,
        repairRefs: ["U1"],
        persistFrames: false,
      },
    );
    expect(report.scope?.refs).toEqual(["U1"]);
    expect(report.scope?.connections).toEqual(["N1"]);
    expect(report.srj.connectionsRouted).toBe(1);
    expect(report.runs[0]?.status).toBe("done");
  });

  test("refuses freerouting outside the internal channel", async () => {
    const project = await tempProject("bench-chan");
    const services = mockServices([project]);
    await writeFile(join(project.dir, "circuit.json"), "[]");
    await expect(
      benchRoute(
        { project, services },
        { router: "freerouting", scenario: "full", repeat: 1, timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/internal/);
  });
});
