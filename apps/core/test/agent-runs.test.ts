/**
 * One agent writer per project (#93): the lease `AgentRunManager` holds from the start checks
 * until the run has ended, on every exit path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManifest, type AgentId } from "@fabdesk/protocol";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { ProjectHandle } from "@fabdesk/tools";
import { AgentRunManager, type AgentAdapterLike } from "../src/agent-runs";
import { TokenSet } from "../src/auth";
import { Store } from "../src/db";
import { DURABLE_WAIT_SHORT_MS, durableWaitForClient, RAISED_TOOL_TIMEOUT_AGENTS } from "../src/mcp-sessions";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** A run that stays live until `finish()`; `abort()` ends it unless `ignoreAbort`. */
type Controlled = { session: AgentSession; finish(ev?: AgentEvent[]): void; aborted: boolean };

function harness(
  opts: {
    agentId?: AgentId;
    ignoreAbort?: boolean;
    run?: AgentAdapterLike["run"];
    resolveProject?: (id: string) => Promise<ProjectHandle | null>;
    detect?: NonNullable<AgentAdapterLike["detect"]>;
    extraToolsets?: (project: ProjectHandle | null) => Promise<string[]>;
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
    const agentId = opts.agentId ?? "claude";
    const manager = new AgentRunManager({
      store,
      emit: () => {},
      tokens: new TokenSet("daemon-token"),
      mcpUrl: "http://localhost/mcp",
      adapters: { [agentId]: { id: agentId, run, ...(opts.detect ? { detect: opts.detect } : {}) } },
      settings: () => store.settings.get(),
      workspaceDir: dir,
      abortSettleTimeoutMs: 100,
      ...(opts.resolveProject ? { resolveProject: opts.resolveProject } : {}),
      ...(opts.extraToolsets ? { extraToolsets: opts.extraToolsets } : {}),
    });
    const project = (id: string): ProjectHandle =>
      ({ id, name: id, dir: join(dir, id), manifest: () => ProjectManifest.parse({ schema: 1, id, name: id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), board: {} }) }) as unknown as ProjectHandle;
    const thread = (title = "chat") => store.threads.create({ agentId, title });
    const start = (threadId: string, p: ProjectHandle | null, prompt = "go") =>
      manager.start({ threadId, project: p, agentId, prompt, attachments: [] });
    return { dir, store, manager, runs, project, thread, start };
  })();
}

const settle = () => Bun.sleep(20);

test("saved effort survives storage reload and applies to new chats only when supported", async () => {
  const h = await harness({ detect: async () => ({ installed: true, defaultModel: "test-model", modelEfforts: { "test-model": ["low", "high"] } }) });
  h.store.settings.patch({ agents: { claude: { effort: "high", permissionMode: "auto", pickerModels: ["test-model"] } } });
  const reopened = Store.open(join(h.dir, "core.sqlite"));
  try { expect(reopened.settings.get().agents.claude?.effort).toBe("high"); } finally { reopened.close(); }
  for (const effort of ["high", "low", "ultra", null] as const) {
    const current = h.store.settings.get();
    h.store.settings.patch({ agents: { ...current.agents, claude: { ...current.agents.claude, effort } } });
    await h.start(h.thread().id, null);
    const latest = h.runs.at(-1)!;
    expect(latest.session.effort).toBe(effort === "high" || effort === "low" ? effort : undefined);
    expect(latest.session.permission).toBe("auto");
    latest.finish(); await settle();
  }
});


test("Antigravity's native approval appears in the chat in Full mode", async () => {
  const h = await harness({ agentId: "antigravity" });
  const t = h.thread();
  await h.start(t.id, null);
  const run = h.runs[0]!;
  expect(run.session.runtimeMode).toBe("full");
  expect(run.session.supervisor).toBeUndefined();
  const decision = run.session.requestApproval!({ tool: "Edit test.txt", input: { path: "test.txt" } });
  const approval = h.manager.pending(t.id).approvals[0]!;
  expect(approval.tool).toBe("Edit test.txt");
  expect(h.manager.resolveApproval(t.id, approval.requestId, "approve", "desktop")).toBe("ok");
  expect(await decision).toBe("approve");
  run.finish();
  await settle();
  expect(h.store.threads.messages(t.id).flatMap((m) => m.parts)).toContainEqual(expect.objectContaining({
    type: "approval", requestId: approval.requestId, decision: "approve",
  }));
});

describe("AgentRunManager project lease", () => {
  test("a CLI failure emitted as text and repeated errors is saved only once", async () => {
    const h = await harness();
    const t = h.thread();
    const failure = "Failed to authenticate: OAuth session expired and could not be refreshed";
    await h.start(t.id, null);
    h.runs[0]!.finish([
      { type: "text", delta: failure },
      { type: "error", message: failure },
      { type: "error", message: failure },
    ]);
    await settle();
    const reply = h.store.threads.messages(t.id).find(m => m.role === "assistant");
    expect(reply?.contentMd).toBe(failure);
    expect(h.store.runs.latestForThread(t.id)?.status).toBe("failed");
  });
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
    // Dispatch resolves a project and creates its working directory asynchronously. A fixed
    // 20 ms sleep can expire before those filesystem operations finish on a busy CI runner.
    const dispatchDeadline = Date.now() + 2_000;
    while (h.runs.length < 3 && Date.now() < dispatchDeadline) await Bun.sleep(10);
    expect(h.runs.map((r) => r.session.prompt)).toEqual(["first", "other thread", "follow-up"]);
    expect(h.store.threads.getMessage(queued.id)?.status).toBeUndefined();
    expect(h.manager.projectHolder(p.id)).toBe(a.id);
    h.runs[2]!.finish();
    await settle();
  });
});

describe("captured workspace context", () => {
  test("passes context to the agent without altering the visible user message", async () => {
    const h = await harness(), t = h.thread(), context = { projectId: null, label: "Outputs / Preview", details: "Selected renders/top.png", capturedAt: "2026-10-29T00:00:00Z" };
    const user = h.store.threads.addMessage({ threadId: t.id, role: "user", contentMd: "Explain this output", parts: [{ type: "workspace_context", context }] });
    await h.manager.start({ threadId: t.id, project: null, agentId: "claude", prompt: "Explain this output", workspaceContext: context, attachments: [] });
    expect(h.runs[0]!.session.prompt).toContain("renders/top.png"); expect(h.runs[0]!.session.prompt).toContain("<workspace_context>");
    expect(h.store.threads.getMessage(user.id)?.contentMd).toBe("Explain this output");
    h.runs[0]!.finish(); await settle();
  });
  test("context from another project never starts a run", async () => {
    const h = await harness(), t = h.thread();
    await expect(h.manager.start({ threadId: t.id, project: null, agentId: "claude", prompt: "Change it", workspaceContext: { projectId: "other", label: "Board", details: "other source", capturedAt: "2026-10-29T00:00:00Z" }, attachments: [] })).rejects.toThrow("another project");
    expect(h.runs).toHaveLength(0); expect(h.manager.activeCount()).toBe(0);
  });
  test("queued messages retain their captured view and refuse mismatched project metadata", async () => {
    const h = await harness(), t = h.thread(), context = { projectId: null, label: "Review / Checks", details: "Saved finding R1", capturedAt: "2026-10-29T00:00:00Z" };
    h.store.threads.addMessage({ threadId: t.id, role: "user", contentMd: "Help with this finding", parts: [{ type: "workspace_context", context }], status: "queued" });
    await h.manager.drainQueue(t.id);
    expect(h.runs[0]!.session.prompt).toContain("Saved finding R1"); h.runs[0]!.finish(); await settle();
    h.store.threads.addMessage({ threadId: t.id, role: "user", contentMd: "Wrong project", parts: [{ type: "workspace_context", context: { ...context, projectId: "other" } }], status: "queued" });
    await h.manager.drainQueue(t.id); expect(h.runs).toHaveLength(1);
    expect(h.store.threads.messages(t.id).some(message => message.contentMd.includes("queued workspace context belongs to another project"))).toBe(true);
  });
});

test("a run starts with the toolsets the project asks for, and without them when it asks for none or fails", async () => {
  const asked: Array<string | null> = [];
  const h = await harness({ extraToolsets: async (p) => { asked.push(p?.id ?? null); if (p?.id === "boom") throw new Error("x"); return p?.id === "board" ? ["board"] : []; } });
  const url = () => new URL(h.runs.at(-1)!.session.mcp.url).searchParams.get("toolsets");
  await h.start(h.thread().id, h.project("board")); expect(url()).toBe("board"); expect(new URL(h.runs.at(-1)!.session.mcp.url).searchParams.get("start")).toBe("board"); h.runs.at(-1)!.finish(); await settle();
  await h.start(h.thread().id, h.project("blank")); expect(url()).toBeNull(); h.runs.at(-1)!.finish(); await settle();
  await h.start(h.thread().id, h.project("boom")); expect(url()).toBeNull(); h.runs.at(-1)!.finish(); await settle();
  expect(asked).toEqual(["board", "blank", "boom"]);
});

test("idea planning is restricted and promotion carries history into a fresh engineering session once", async () => {
  const h = await harness(), p = h.project("idea-plan"), t = h.thread();
  let manifest = { ...p.manifest(), ideaDraft: {} };
  p.manifest = () => manifest;
  h.store.threads.addMessage({ threadId: t.id, role: "user", contentMd: "Use a 1k resistor" });
  await h.start(t.id, p, "Discuss my idea");
  expect(h.runs[0]?.session.planningOnly).toBe(true);
  expect(new URL(h.runs[0]!.session.mcp.url).searchParams.get("profile")).toBe("planning");
  expect(h.runs[0]?.session.prompt).toContain("Do not create, edit, generate");
  h.runs[0]!.finish([{ type: "text", delta: "We agreed on a 20mm outline" }]); await settle();
  const { ideaDraft: _draft, ...rest } = manifest;
  manifest = { ...rest, promotedAt: new Date().toISOString() } as typeof manifest;
  await h.start(t.id, p, "Generate the agreed circuit");
  expect(h.runs[1]?.session.planningOnly).toBeUndefined();
  expect(h.runs[1]?.session.resume).toBeUndefined();
  expect(h.runs[1]?.session.prompt).toContain("Use a 1k resistor");
  expect(h.runs[1]?.session.prompt).toContain("20mm outline");
  h.runs[1]!.finish(); await settle();
  await h.start(t.id, p, "Explain the result");
  expect(h.runs[2]?.session.resume).toBe("s2");
  h.runs[2]!.finish(); await settle();
});

test("Antigravity cannot run before an idea is promoted and keeps the selected model afterward", async () => {
  const h = await harness({ agentId: "antigravity" }), p = h.project("antigravity-idea"), t = h.thread();
  const base = p.manifest();
  let manifest: typeof base = { ...base, ideaDraft: {} };
  p.manifest = () => manifest;
  const model = "gemini-4-neon-high", prompt = "make me a simple blinking light board";
  const start = () => h.manager.start({ threadId: t.id, project: p, agentId: "antigravity", model, prompt, attachments: [] });
  await expect(start()).rejects.toThrow("create the project first");
  expect(h.runs).toHaveLength(0);
  expect(h.manager.activeCount()).toBe(0);
  manifest = { ...base, promotedAt: new Date().toISOString() };
  await start();
  expect(h.runs[0]?.session.model).toBe(model);
  expect(h.runs[0]?.session.prompt).toContain(prompt);
  expect(h.runs[0]?.session.planningOnly).toBeUndefined();
  h.runs[0]!.finish();
  await settle();
});

test("a run token names its agent; only agents whose tool timeout fabdesk raised get the full durable wait", async () => {
  const h = await harness();
  expect(h.manager.activeRunAgent(null)).toBeNull();
  await h.start(h.thread().id, null);
  const token = h.runs.at(-1)!.session.mcp.token;
  expect(h.manager.activeRunAgent(token)).toBe("claude");
  expect(durableWaitForClient(undefined, { ownRun: RAISED_TOOL_TIMEOUT_AGENTS.has("claude") })).toBeUndefined();
  // Cursor and Grok configs carry no tool-timeout key: their own runs return a job id after the short wait
  for (const agent of ["cursor", "grok"]) {
    expect(RAISED_TOOL_TIMEOUT_AGENTS.has(agent)).toBe(false);
    expect(durableWaitForClient({ name: agent }, { ownRun: RAISED_TOOL_TIMEOUT_AGENTS.has(agent) })).toBe(DURABLE_WAIT_SHORT_MS);
  }
  h.runs.at(-1)!.finish();
  await settle();
  expect(h.manager.activeRunAgent(token)).toBeNull();
});
