import { describe, expect, test } from "bun:test";
import type { CoreEvent } from "@fabdesk/protocol";
import { JobRunner } from "../src/jobs";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

describe("JobRunner", () => {
  test("per-class concurrency: router 1, kicad 2", async () => {
    const events: CoreEvent[] = [];
    const jobs = new JobRunner({ emit: (e) => events.push(e) });
    let running = 0;
    let maxRouter = 0;
    let maxKicad = 0;
    const mk = (cls: "router" | "kicad") =>
      jobs.enqueue({
        kind: cls,
        jobClass: cls,
        projectId: null,
        run: async ({ progress }) => {
          running++;
          if (cls === "router") maxRouter = Math.max(maxRouter, jobs.runningCount("router"));
          else maxKicad = Math.max(maxKicad, jobs.runningCount("kicad"));
          progress(0.5, "half");
          await sleep(20);
          running--;
          return cls;
        },
      });
    const ids = [mk("router"), mk("router"), mk("router"), mk("kicad"), mk("kicad"), mk("kicad")];
    const results = await Promise.all(ids.map((j) => jobs.wait(j.id)));
    expect(results.every((r) => r.status === "done")).toBe(true);
    expect(maxRouter).toBe(1);
    expect(maxKicad).toBe(2);
    expect(running).toBe(0);
    const topics = events.map((e) => e.topic);
    expect(topics.filter((t) => t === "job.started").length).toBe(6);
    expect(topics.filter((t) => t === "job.progress").length).toBe(6);
    expect(topics.filter((t) => t === "job.done").length).toBe(6);
    expect(results[0]!.result).toBe("router");
    expect(results[0]!.progress).toBe(1);
  });

  test("cancel running and queued jobs, failures propagate", async () => {
    const events: CoreEvent[] = [];
    const jobs = new JobRunner({ emit: (e) => events.push(e) });
    const a = jobs.enqueue({ kind: "a", jobClass: "build", projectId: "p", run: ({ signal }) => sleep(1000, signal) });
    const b = jobs.enqueue({ kind: "b", jobClass: "build", projectId: "p", run: () => sleep(10) });
    const c = jobs.enqueue({ kind: "c", jobClass: "default", projectId: null, run: async () => { throw new Error("boom"); } });
    await new Promise((r) => setTimeout(r, 5));
    expect(jobs.get(a.id)!.status).toBe("running");
    expect(jobs.get(b.id)!.status).toBe("queued");
    expect(jobs.cancel(b.id)).toBe(true);
    expect(jobs.get(b.id)!.status).toBe("cancelled");
    const t0 = Date.now();
    expect(jobs.cancel(a.id)).toBe(true);
    const ra = await jobs.wait(a.id);
    expect(ra.status).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(200);
    const rc = await jobs.wait(c.id);
    expect(rc.status).toBe("failed");
    expect(rc.error).toBe("boom");
    expect(events.some((e) => e.topic === "job.cancelled" && e.jobId === a.id)).toBe(true);
    expect(events.some((e) => e.topic === "job.failed" && e.jobId === c.id)).toBe(true);
    expect(jobs.cancel("nope")).toBe(false);
  });

  test("persists through the store hooks", async () => {
    const log: string[] = [];
    const jobs = new JobRunner({ emit: () => {}, store: { insert: (j) => log.push(`insert ${j.kind}`), update: (_id, p) => log.push(`update ${p.status ?? "progress"}`) } });
    const j = jobs.enqueue({ kind: "x", jobClass: "default", projectId: null, run: async () => 42 });
    await jobs.wait(j.id);
    expect(log).toEqual(["insert x", "update running", "update done"]);
  });
});
