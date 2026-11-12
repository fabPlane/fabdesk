import { describe, expect, test } from "bun:test";
import { runDurable, setDurableWaitMs, getDurableJob } from "../src/durable";
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
