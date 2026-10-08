import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentProcess } from "@fabdesk/agents";
import { trackAgentProcess } from "../../../packages/agents/src/process-ownership";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { Store } from "../src/db";
import { serve, type Daemon } from "../src/serve";

// Python's flock models Codex's OS-held writer: it remains locked while the orphan lives.
const lockScript = `import fcntl,sys,time\nf=open(sys.argv[1],'w')\nfcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint('locked',flush=True)\ntime.sleep(60)`;

test("startup stops a stale thread writer, marks its run failed, and resumes the same thread", async () => {
  const home = await mkdtemp(join(tmpdir(), "fabdesk-crash-recovery-"));
  const oldProjectsDir = process.env["FABDESK_PROJECTS_DIR"];
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "projects");
  await writeFile(join(home, ".fabdesk-dev"), "test");
  const lock = join(home, "thread.lock");
  const ownerDir = join(home, "agent-processes");
  const child = Bun.spawn(["python3", "-c", lockScript, lock], { stdout: "pipe", stderr: "pipe" });
  let daemon: Daemon | undefined;
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    await (
      await trackAgentProcess(ownerDir, child.pid)
    )(); // obtain identities, then replace the record below
    const { processIdentity } = await import("../../../packages/agents/src/process-ownership");
    await writeFile(
      join(ownerDir, "crashed.json"),
      JSON.stringify({
        ownerPid: process.pid,
        ownerIdentity: "previous-core-incarnation",
        pid: child.pid,
        identity: await processIdentity(child.pid),
      }),
    );
    const store = Store.open(join(home, "fabdesk.db"));
    const thread = store.threads.create({ agentId: "codex" });
    const old = store.runs.create({ threadId: thread.id, agentId: "codex" });
    store.runs.setSession(old.id, "same-thread-session");
    store.close();
    let resumed: string | undefined;
    daemon = await serve({
      dataDir: home,
      port: 0,
      localAuth: true,
      quiet: true,
      noHandshake: true,
      watchProjects: false,
      services: () => mockServices([]),
      adapters: {
        codex: {
          id: "codex",
          run(session) {
            resumed = session.resume;
            return runAgentProcess({
              cmd: [
                "python3",
                "-c",
                "import fcntl,sys; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",
                lock,
              ],
              cwd: home,
              env: session.env ?? {},
              parse: () => [],
            });
          },
        },
      },
    });
    expect(daemon.store.runs.get(old.id)?.status).toBe("failed");
    expect(
      daemon.store.threads.messages(thread.id).some((m) => m.contentMd.includes("core restarted")),
    ).toBe(true);
    await daemon.runs.start({
      threadId: thread.id,
      project: null,
      agentId: "codex",
      prompt: "continue",
      attachments: [],
    });
    for (let i = 0; i < 100 && daemon.runs.isRunning(thread.id); i++) await Bun.sleep(20);
    expect(resumed).toBe("same-thread-session");
    expect(daemon.store.runs.latestForThread(thread.id)?.status).toBe("completed");
    expect(await readdir(ownerDir)).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await daemon?.close();
    if (oldProjectsDir === undefined) delete process.env["FABDESK_PROJECTS_DIR"];
    else process.env["FABDESK_PROJECTS_DIR"] = oldProjectsDir;
    await rm(home, { recursive: true, force: true });
  }
});

for (const scenario of [
  "corrupt",
  "unreadable",
  "invalid-descendant",
  "stubborn",
  "live-owner",
] as const) {
  test(`startup continues with ${scenario} ownership and preserves a live owner's run`, async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-recovery-rework-"));
    const previousProjects = process.env["FABDESK_PROJECTS_DIR"];
    process.env["FABDESK_PROJECTS_DIR"] = join(home, "projects");
    const ownerDir = join(home, "agent-processes");
    const { mkdir } = await import("node:fs/promises");
    const { processIdentity } = await import("../../../packages/agents/src/process-ownership");
    await mkdir(ownerDir);
    await writeFile(join(home, ".fabdesk-dev"), "test");
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    let daemon: Daemon | undefined;
    try {
      const record = {
        ownerPid: process.pid,
        ownerIdentity: scenario === "live-owner" ? await processIdentity(process.pid) : "dead",
        pid: child.pid,
        identity: await processIdentity(child.pid),
        ...(scenario === "invalid-descendant"
          ? { descendants: [{ pid: -1, identity: "bad" }] }
          : {}),
      };
      const path = join(ownerDir, "test.json");
      if (scenario === "unreadable")
        await mkdir(path); // EISDIR works even when tests run as root
      else await writeFile(path, scenario === "corrupt" ? "{" : JSON.stringify(record));
      const store = Store.open(join(home, "fabdesk.db"));
      const thread = store.threads.create({ agentId: "codex" });
      const run = store.runs.create({ threadId: thread.id, agentId: "codex" });
      store.close();
      daemon = await serve({
        dataDir: home,
        port: 0,
        localAuth: true,
        quiet: true,
        noHandshake: true,
        watchProjects: false,
        services: () => mockServices([]),
        recoveryStop: () => {},
        recoveryWaitMs: 40,
      });
      expect((await fetch(`${daemon.url}/health`)).ok).toBe(true);
      expect(daemon.store.runs.get(run.id)?.status).toBe(
        scenario === "live-owner" ? "running" : "failed",
      );
      if (scenario === "stubborn") {
        expect(
          daemon.store.threads
            .messages(thread.id)
            .some((m) => m.contentMd.includes("did not stop")),
        ).toBe(true);
        expect(await readdir(ownerDir)).toContain("test.json");
      } else if (scenario !== "live-owner")
        expect((await readdir(join(ownerDir, "quarantine"))).length).toBe(1);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
      await child.exited;
      await daemon?.close();
      if (previousProjects === undefined) delete process.env["FABDESK_PROJECTS_DIR"];
      else process.env["FABDESK_PROJECTS_DIR"] = previousProjects;
      await rm(home, { recursive: true, force: true });
    }
  });
}
