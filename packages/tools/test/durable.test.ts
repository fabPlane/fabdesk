import { describe, expect, test } from "bun:test";
import { cancelDurableJob, FINISHED_TTL_MS, getDurableJob, listDurableJobs, MAX_FINISHED, pruneDurableJobs, runDurable, setDurableWaitMs } from "../src/durable";
import { board_job } from "../src/tools/board";

const base = (signal = new AbortController().signal) => ({ signal, progress: () => {} }) as never;
type Out = { text: string; json?: { jobId?: string; state?: string } };
const job = (a: object, ctx = base()) => (board_job.handler as unknown as (a: object, c: unknown) => Promise<Out>)(a, ctx);

describe("durable board jobs", () => {
  test("a quick job returns its result directly", async () => {
    const r = await runDurable(base(), "t", async () => ({ text: "done" }), { waitMs: 500 });
    expect(r.text).toBe("done");
  });
  test("a slow job returns a job id, keeps running, and board_job waits for it", async () => {
    setDurableWaitMs(20);
    const r = (await runDurable(base(), "slow", async (c) => {
      c.progress(0.5, "halfway");
      await new Promise((z) => setTimeout(z, 80));
      return { text: "finished" };
    }, { waitMs: 20 })) as Out;
    expect(r.text).toContain("still running");
    const id = r.json!.jobId!;
    expect((await job({ jobId: id, action: "status" })).json?.state).toBe("running");
    setDurableWaitMs(2000);
    expect((await job({ jobId: id })).text).toBe("finished");
    expect((await job({ action: "list" })).text).toContain(id);
  });
  test("cancel aborts the job's own signal; its error is reported", async () => {
    const r = (await runDurable(base(), "hang", (c) => new Promise((_, rej) => c.signal.addEventListener("abort", () => rej(new Error("stopped")))), { waitMs: 10 })) as Out;
    const id = r.json!.jobId!;
    const c = await job({ jobId: id, action: "cancel" });
    expect(c.json?.state).toBe("cancelled");
    expect(getDurableJob(id)?.state).toBe("cancelled");
    await expect(job({ jobId: id })).rejects.toThrow("stopped");
    await expect(job({ jobId: "nope" })).rejects.toThrow(/no board job/);
  });
});

describe("board jobs are scoped, pruned and honest about their end", () => {
  const inProject = (id: string, signal = new AbortController().signal) => ({ signal, progress: () => {}, project: { id } }) as never;
  const slow = (ms: number) => async () => {
    await new Promise((z) => setTimeout(z, ms));
    return { text: "slow done" };
  };
  test("list, status, wait and cancel see only the calling project's jobs; allProjects lists every one", async () => {
    const a = (await runDurable(inProject("pa"), "ta", slow(60), { waitMs: 5 })) as Out;
    const b = (await runDurable(inProject("pb"), "tb", slow(60), { waitMs: 5 })) as Out;
    const listA = (await job({ action: "list" }, inProject("pa"))) as Out & { json: { jobs: Array<{ id: string }> } };
    expect(listA.json.jobs.map((j) => j.id)).toContain(a.json!.jobId!);
    expect(listA.json.jobs.map((j) => j.id)).not.toContain(b.json!.jobId!);
    const all = (await job({ action: "list", allProjects: true }, inProject("pa"))) as Out & { json: { jobs: Array<{ id: string }> } };
    expect(all.json.jobs.map((j) => j.id)).toEqual(expect.arrayContaining([a.json!.jobId!, b.json!.jobId!]));
    for (const action of ["status", "wait", "cancel"])
      await expect(job({ jobId: b.json!.jobId!, action }, inProject("pa"))).rejects.toThrow(/another project/);
    expect(getDurableJob(b.json!.jobId!)?.state).toBe("running");
    setDurableWaitMs(2000);
    expect((await job({ jobId: b.json!.jobId! }, inProject("pb"))).text).toBe("slow done");
  });
  test("cancel reports the real end state: already ended, cancelled, or still stopping", async () => {
    const quick = (await runDurable(inProject("pc"), "q", async () => ({ text: "ok" }), { waitMs: 500 })) as Out;
    expect(quick.text).toBe("ok");
    const id = listDurableJobs("pc")[0]!.id;
    const c1 = await job({ jobId: id, action: "cancel" }, inProject("pc"));
    expect(c1.json?.state).toBe("done");
    expect(c1.text).toContain("already ended");
    // a job that ignores its signal is still stopping after the cancel's wait
    const stubborn = (await runDurable(inProject("pc"), "stubborn", slow(400), { waitMs: 5 })) as Out;
    const r = await cancelDurableJob(getDurableJob(stubborn.json!.jobId!)!, 20);
    expect(r).toEqual({ state: "stopping", already: false });
  });
  test("finished jobs are pruned after the TTL; an id from before a restart says the daemon restarted", async () => {
    const r = (await runDurable(inProject("pd"), "old", async () => ({ text: "x" }), { waitMs: 500 })) as Out;
    expect(r.text).toBe("x");
    const id = listDurableJobs("pd")[0]!.id;
    pruneDurableJobs(Date.now() + FINISHED_TTL_MS + 1000);
    expect(getDurableJob(id)).toBeUndefined();
    await expect(job({ jobId: id }, inProject("pd"))).rejects.toThrow(/pruned/);
    const before = `bj-${(Date.now() - 86_400_000).toString(36)}-abcd`;
    await expect(job({ jobId: before }, inProject("pd"))).rejects.toThrow(/daemon restarted/);
  });
  test("at most MAX_FINISHED finished jobs are kept", async () => {
    for (let i = 0; i < MAX_FINISHED + 5; i++) await runDurable(inProject("pe"), "many", async () => ({ text: String(i) }), { waitMs: 500 });
    expect(listDurableJobs(undefined).filter((j) => j.state !== "running").length).toBeLessThanOrEqual(MAX_FINISHED);
  });
});
