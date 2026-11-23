import { describe, expect, test } from "bun:test";
import { cancelDurableJob, FINISHED_TTL_MS, getDurableJob, listDurableJobs, MAX_FINISHED, pruneDurableJobs, runDurable, setDurableWaitMs } from "../src/durable";
import { board_job } from "../src/tools/board";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

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

describe("board_job reaches a job started with an explicit project", () => {
  test("project-scoped: the same `project` argument reaches it; the session default (another project) does not", async () => {
    const [home, other] = [await tempProject("bj-home"), await tempProject("bj-other")];
    const services = mockServices([home, other]);
    const registry = createRegistry();
    expect(registry.get("board_job")!.scope ?? "project").toBe("project");
    const factory = contextFactory(services, home); // the session's default project is `home`
    const invoke = (args: Record<string, unknown>) =>
      registry.invoke("board_job", args, (ref) => factory({ def: registry.get("board_job")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} })) as Promise<Out>;
    // a stage tool called with project: other
    const started = (await runDurable({ signal: new AbortController().signal, progress: () => {}, project: { id: other.id } } as never, "board_route", async () => {
      await new Promise((z) => setTimeout(z, 60));
      return { text: "routed" };
    }, { waitMs: 5 })) as Out;
    const id = started.json!.jobId!;
    await expect(invoke({ jobId: id, action: "status" })).rejects.toThrow(/another project/);
    expect((await invoke({ jobId: id, action: "status", project: other.id })).json?.state).toBe("running");
    setDurableWaitMs(2000);
    expect((await invoke({ jobId: id, project: other.id })).text).toBe("routed");
  });
});

describe("aborting the waiting request never touches the job", () => {
  test("Stop on the starting request returns a job id; the job finishes and its result is kept", async () => {
    const ac = new AbortController();
    const p = runDurable(base(ac.signal), "stop", async (c) => {
      await new Promise((z) => setTimeout(z, 40));
      expect(c.signal.aborted).toBe(false);
      return { text: "kept" };
    }, { waitMs: 5_000 }) as Promise<Out>;
    ac.abort();
    const r = await p;
    expect(r.text).toContain("still running");
    const id = r.json!.jobId!;
    setDurableWaitMs(2000);
    expect((await job({ jobId: id })).text).toBe("kept");
    expect(getDurableJob(id)?.state).toBe("done");
  });

  test("a wait whose request is already aborted returns at once, and so does runDurable", async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const r = (await runDurable(base(ac.signal), "pre-aborted", async () => {
      await new Promise((z) => setTimeout(z, 30));
      return { text: "late" };
    }, { waitMs: 5_000 })) as Out;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.text).toContain("still running");
    setDurableWaitMs(2000);
    expect((await job({ jobId: r.json!.jobId! })).text).toBe("late");
  });
});

describe("board_check is a durable board job", () => {
  test("past the wait it returns a job id and keeps running; board_job gets the result", async () => {
    const project = await tempProject("bj-check");
    let release!: () => void;
    const gate = new Promise<void>((z) => (release = z));
    const base = mockServices([project]);
    // kicad-cli resolution stands in for a long onboarding + DRC: it answers only when released
    const services = { ...base, kicad: { ...base.kicad, resolveCli: async () => (await gate, null) } };
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const session = { id: "s", durableWaitMs: () => 20 } as never;
    const ctx = (name: string) => factory({ def: registry.get(name)!, projectRef: undefined, signal: new AbortController().signal, progress: () => {}, session });
    const r = (await registry.invoke("board_check", {}, () => ctx("board_check"))) as Out;
    expect(r.text).toContain("still running");
    release();
    setDurableWaitMs(2000);
    await expect(registry.invoke("board_job", { jobId: r.json!.jobId! }, () => ctx("board_job"))).rejects.toThrow(/kicad-cli not found/);
  });
});
