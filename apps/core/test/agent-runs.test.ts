/**
 * One agent writer per project (#93): the lease `AgentRunManager` holds from the start checks
 * until the run has ended, on every exit path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { ProjectHandle } from "@fabdesk/tools";
import { AgentRunManager, type AgentAdapterLike } from "../src/agent-runs";
import { TokenSet } from "../src/auth";
import { Store } from "../src/db";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** A run that stays live until `finish()`; `abort()` ends it unless `ignoreAbort`. */
type Controlled = { session: AgentSession; finish(ev?: AgentEvent[]): void; aborted: boolean };

function harness(
  opts: {
    ignoreAbort?: boolean;
    run?: AgentAdapterLike["run"];
    resolveProject?: (id: string) => Promise<ProjectHandle | null>;
  } = {},
) {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-agent-runs-"));
    const store = Store.open(join(dir, "core.sqlite"));
    stores.push(store);
    const runs: Controlled[] = [];
    const run: AgentAdapterLike["run"] =
      opts.run ??
      ((session) => {
        let release!: (ev: AgentEvent[]) => void;
        const released = new Promise<AgentEvent[]>((r) => (release = r));
        const c: Controlled = { session, finish: (ev = []) => release(ev), aborted: false };
        runs.push(c);
        return {
          events: (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: "init", sessionId: `s${runs.length}` };
            const tail = await released;
            yield* tail;
            yield { type: "done", exitCode: tail.some((e) => e.type === "error") ? 1 : 0 };
          })(),
          abort() {
            c.aborted = true;
            if (!opts.ignoreAbort) release([]);
          },
        } satisfies AgentRun;
      });
    const manager = new AgentRunManager({
      store,
      emit: () => {},
      tokens: new TokenSet("daemon-token"),
      mcpUrl: "http://localhost/mcp",
      adapters: { claude: { id: "claude", run } },
      settings: () => store.settings.get(),
      workspaceDir: dir,
      abortSettleTimeoutMs: 100,
      ...(opts.resolveProject ? { resolveProject: opts.resolveProject } : {}),
    });
    const project = (id: string): ProjectHandle =>
      ({ id, name: id, dir: join(dir, id) }) as unknown as ProjectHandle;
    const thread = (title = "chat") => store.threads.create({ agentId: "claude", title });
    const start = (threadId: string, p: ProjectHandle | null, prompt = "go") =>
      manager.start({ threadId, project: p, agentId: "claude", prompt, attachments: [] });
    return { dir, store, manager, runs, project, thread, start };
  })();
}

const settle = () => Bun.sleep(20);

describe("AgentRunManager project lease", () => {
  test("a second thread cannot start a writer on a busy project, and is told which thread holds it", async () => {
    const h = await harness();
    const p = h.project("proj-a");
    const a = h.thread("Power stage");
    const b = h.thread();
    await h.start(a.id, p);
    expect(h.manager.projectHolder(p.id)).toBe(a.id);
    const refused = h.start(b.id, p);
    await expect(refused).rejects.toThrow(/already active on this project/);
    await expect(refused).rejects.toThrow(`"Power stage" (${a.id})`);
    await expect(refused).rejects.toMatchObject({ code: "precondition" });
    expect(h.runs).toHaveLength(1);
    // The refused thread is not left marked as running.
    expect(h.manager.isRunning(b.id)).toBe(false);
    h.runs[0]!.finish();
    await settle();
  });

  test("concurrent starts on one project: exactly one gets the lease", async () => {
    const h = await harness();
    const p = h.project("proj-race");
    const [a, b] = [h.thread(), h.thread()];
    const results = await Promise.allSettled([h.start(a.id, p), h.start(b.id, p)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(h.runs).toHaveLength(1);
    h.runs[0]!.finish();
    await settle();
  });

  test("different projects, and runs without a project, run concurrently", async () => {
    const h = await harness();
    const threads = [h.thread(), h.thread(), h.thread(), h.thread()];
    await h.start(threads[0]!.id, h.project("proj-1"));
    await h.start(threads[1]!.id, h.project("proj-2"));
    await h.start(threads[2]!.id, null);
    await h.start(threads[3]!.id, null);
    expect(h.manager.activeCount()).toBe(4);
    for (const r of h.runs) r.finish();
    await settle();
    expect(h.manager.activeCount()).toBe(0);
  });

  test("released when the run completes", async () => {
    const h = await harness();
    const p = h.project("proj-done");
    const [a, b] = [h.thread(), h.thread()];
    await h.start(a.id, p);
    h.runs[0]!.finish([{ type: "text", delta: "ok" }]);
    await settle();
    expect(h.manager.projectHolder(p.id)).toBeNull();
    await h.start(b.id, p);
    expect(h.manager.projectHolder(p.id)).toBe(b.id);
    h.runs[1]!.finish();
    await settle();
  });

  test("released when the run fails", async () => {
    const h = await harness();
    const p = h.project("proj-err");
    const [a, b] = [h.thread(), h.thread()];
    await h.start(a.id, p);
    h.runs[0]!.finish([{ type: "error", message: "boom" }]);
    await settle();
    expect(h.manager.projectHolder(p.id)).toBeNull();
    await h.start(b.id, p);
    h.runs[1]!.finish();
    await settle();
  });

  test("released when the agent cannot be started, and when setup throws", async () => {
    const throwing = await harness({
      run: () => {
        throw new Error("no such binary");
      },
    });
    const p = throwing.project("proj-spawn");
    await expect(throwing.start(throwing.thread().id, p)).rejects.toThrow(/failed to start/);
    expect(throwing.manager.projectHolder(p.id)).toBeNull();

    // mkdir of the project dir fails: the reservation made before it must still go.
    const h = await harness();
    const blocked = join(h.dir, "a-file");
    await writeFile(blocked, "x");
    const bad = {
      id: "proj-mkdir",
      name: "x",
      dir: join(blocked, "sub"),
    } as unknown as ProjectHandle;
    const t = h.thread();
    await expect(h.start(t.id, bad)).rejects.toThrow();
    expect(h.manager.projectHolder(bad.id)).toBeNull();
    expect(h.manager.isRunning(t.id)).toBe(false);
  });

  test("abort waits for the run to end, then the project is free", async () => {
    const h = await harness();
    const p = h.project("proj-abort");
    const [a, b] = [h.thread(), h.thread()];
    await h.start(a.id, p);
    expect(await h.manager.abortThread(a.id)).toEqual({ aborted: true, settled: true });
    expect(h.manager.projectHolder(p.id)).toBeNull();
    await h.start(b.id, p);
    h.runs[1]!.finish();
    await settle();
    expect(await h.manager.abortThread(a.id)).toEqual({ aborted: false, settled: true });
  });

  test("abort answers after the bounded wait when the agent ignores it; the lease is kept until it exits", async () => {
    const h = await harness({ ignoreAbort: true });
    const p = h.project("proj-stuck");
    const [a, b] = [h.thread(), h.thread()];
    await h.start(a.id, p);
    const started = Date.now();
    expect(await h.manager.abortThread(a.id)).toEqual({ aborted: true, settled: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.runs[0]!.aborted).toBe(true);
    expect(h.manager.projectHolder(p.id)).toBe(a.id);
    await expect(h.start(b.id, p)).rejects.toThrow(/already active on this project/);
    h.runs[0]!.finish();
    await settle();
    expect(h.manager.projectHolder(p.id)).toBeNull();
  });

  test("a fresh manager (daemon restart) starts with every project free", async () => {
    const h = await harness();
    const p = h.project("proj-restart");
    await h.start(h.thread().id, p);
    const restarted = new AgentRunManager({
      store: h.store,
      emit: () => {},
      tokens: new TokenSet("daemon-token"),
      mcpUrl: "http://localhost/mcp",
      adapters: {},
      settings: () => h.store.settings.get(),
      workspaceDir: h.dir,
    });
    expect(restarted.projectHolder(p.id)).toBeNull();
    h.runs[0]!.finish();
    await settle();
  });
});

describe("queued messages and the lease", () => {
  /** Captures unhandled rejections for the duration of `fn`. */
  async function noUnhandled(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const onRejection = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      await fn();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    return seen;
  }

  test("deleting a thread with a queued message starts no run and rejects nothing", async () => {
    const h = await harness();
    const p = h.project("proj-delete");
    const t = h.thread();
    const unhandled = await noUnhandled(async () => {
      await h.start(t.id, p);
      const queued = h.store.threads.addMessage({
        threadId: t.id,
        role: "user",
        contentMd: "queued follow-up",
        status: "queued",
      });
      // What DELETE /threads/:id does.
      expect(await h.manager.abortForDelete(t.id)).toEqual({ aborted: true, settled: true });
      await settle();
      // The run ended during the wait; its drain left the queue alone and started nothing.
      expect(h.store.threads.getMessage(queued.id)?.status).toBe("queued");
      expect(h.manager.isRunning(t.id)).toBe(false);
      expect(h.store.threads.delete(t.id)).toBe(true);
      h.manager.deleted(t.id);
      await settle();
    });
    expect(unhandled).toEqual([]);
    expect(h.runs).toHaveLength(1);
    expect(h.manager.activeCount()).toBe(0);
    expect(h.manager.projectHolder(p.id)).toBeNull();
  });

  test("a queued message whose project is taken meanwhile stays queued and goes out when it frees", async () => {
    let gate: (() => void) | null = null;
    const h = await harness({
      // The drain resolves the project before un-queueing; hold it there so another thread can
      // take the project in between.
      resolveProject: async (id) => {
        if (gate === null) await new Promise<void>((r) => (gate = r));
        return h.project(id);
      },
    });
    const now = new Date().toISOString();
    h.store.projects.upsert({
      id: "proj-drain",
      name: "Drain",
      slug: "drain",
      path: join(h.dir, "proj-drain"),
      createdAt: now,
      updatedAt: now,
    });
    const p = h.project("proj-drain");
    const a = h.store.threads.create({ agentId: "claude", title: "A", projectId: p.id });
    const b = h.thread("B");
    await h.start(a.id, p, "first");
    const queued = h.store.threads.addMessage({
      threadId: a.id,
      role: "user",
      contentMd: "follow-up",
      status: "queued",
    });
    h.runs[0]!.finish();
    await settle();
    // A's run ended; its drain is parked in resolveProject. B takes the project.
    expect(h.manager.projectHolder(p.id)).toBeNull();
    await h.start(b.id, p, "other thread");
    (gate as unknown as () => void)();
    await settle();
    expect(h.store.threads.getMessage(queued.id)?.status).toBe("queued");
    expect(h.runs.map((r) => r.session.prompt)).toEqual(["first", "other thread"]);
    // B's run ends: A's queued message goes out now.
    h.runs[1]!.finish();
    await settle();
    expect(h.runs.map((r) => r.session.prompt)).toEqual(["first", "other thread", "follow-up"]);
    expect(h.store.threads.getMessage(queued.id)?.status).toBeUndefined();
    expect(h.manager.projectHolder(p.id)).toBe(a.id);
    h.runs[2]!.finish();
    await settle();
  });
});
