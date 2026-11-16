import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processIdentity, recoverAgentProcesses, trackAgentProcess } from "./process-ownership";
import { killTree, runAgentProcess } from "./process";

test("crashed owner releases its verified orphan writer; live owner and reused PID remain protected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-owner-"));
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let release = async () => {};
  try {
    release = await trackAgentProcess(directory, child.pid);
    expect(
      (await recoverAgentProcesses(directory, (pid) => killTree(pid, "SIGKILL"))).liveOwners,
    ).toEqual([process.pid]);
    expect(child.exitCode).toBeNull();
    const path = join(directory, (await readdir(directory))[0]!);
    const record = JSON.parse(await readFile(path, "utf8"));
    // A crashed owner cannot keep sampling. Stop the live tracker before
    // restoring a simulated crash record so it cannot overwrite recovery.
    await release();
    record.ownerIdentity = "dead-core-incarnation";
    record.identity = "old-pid-incarnation";
    await writeFile(path, JSON.stringify(record));
    expect(
      (
        await recoverAgentProcesses(directory, () => {
          throw new Error("must not kill reused pid");
        })
      ).recovered,
    ).toBe(0);
    expect(child.exitCode).toBeNull();
    await writeFile(
      path,
      JSON.stringify({ ...record, identity: await processIdentity(child.pid) }),
    );
    expect(
      (await recoverAgentProcesses(directory, (pid) => killTree(pid, "SIGKILL"))).recovered,
    ).toBe(1);
    await child.exited;
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await release();
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal agent completion removes its durable owner record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-owner-normal-"));
  try {
    const run = runAgentProcess({
      cmd: [process.execPath, "-e", "await Bun.sleep(100);"],
      cwd: directory,
      env: { FABDESK_AGENT_OWNER_DIR: directory },
      parse: () => [],
    });
    for (let i = 0; i < 100 && !(await readdir(directory)).length; i++) await Bun.sleep(5);
    expect((await readdir(directory)).length).toBe(1);
    for await (const _event of run.events) {
      /* exhaust */
    }
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery stops a recorded native child even after its CLI wrapper was reaped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-owner-child-"));
  const wrapper = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const p = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout: "ignore", stderr: "ignore"}); console.log(p.pid); setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  let childPid = 0;
  let release = async () => {};
  try {
    const reader = wrapper.stdout.getReader();
    childPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
    release = await trackAgentProcess(directory, wrapper.pid);
    const path = join(directory, (await readdir(directory))[0]!);
    const record = JSON.parse(await readFile(path, "utf8"));
    expect(record.descendants.some((p: { pid: number }) => p.pid === childPid)).toBe(true);
    wrapper.kill();
    await wrapper.exited;
    await writeFile(path, JSON.stringify({ ...record, ownerIdentity: "crashed-core" }));
    expect(
      (await recoverAgentProcesses(directory, (pid) => killTree(pid, "SIGKILL"))).recovered,
    ).toBe(1);
    expect(await processIdentity(childPid)).toBeNull();
  } finally {
    await release();
    if (wrapper.exitCode === null) wrapper.kill();
    await wrapper.exited;
    if (childPid && (await processIdentity(childPid))) killTree(childPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("macOS ownership probes batch identities and Windows launches no probe", async () => {
  const { processSnapshot } = await import("./process-ownership");
  const calls: string[][] = [];
  const command = async (args: string[]) => {
    calls.push(args);
    await Bun.sleep(20);
    return " 100 1 S Mon Oct 5 10:00:00 2026\n 101 100 S Mon Oct 5 10:00:01 2026\n";
  };
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 5);
  const snapshot = await processSnapshot("darwin", command);
  clearTimeout(timer);
  expect(timerRan).toBe(true);
  expect(snapshot.size).toBe(2);
  expect(calls).toEqual([["ps", "-A", "-o", "pid=,ppid=,stat=,lstart="]]);
  expect((await processSnapshot("win32", command)).size).toBe(0);
  expect(calls.length).toBe(1);
});

test("two tracked agents keep the Linux event loop responsive across sparse samples", async () => {
  if (process.platform !== "linux") return;
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-owner-drift-"));
  const drift: number[] = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    drift.push(Math.max(0, now - previous - 10));
    previous = now;
  }, 10);
  const runs = Array.from({ length: 2 }, () =>
    runAgentProcess({
      cmd: [process.execPath, "-e", "await Bun.sleep(5500)"],
      cwd: directory,
      env: { FABDESK_AGENT_OWNER_DIR: directory },
      parse: () => [],
    }),
  );
  try {
    await Promise.all(
      runs.map(async (run) => {
        for await (const _event of run.events) {
        }
      }),
    );
    const sorted = drift.toSorted((a, b) => a - b);
    const measurement = {
      platform: process.platform,
      agents: 2,
      intervalMs: 10,
      sampleMs: 5000,
      samples: drift.length,
      maxDriftMs: Math.max(...drift),
      p99DriftMs: sorted[Math.floor(sorted.length * 0.99)],
    };
    console.log(`EVENT_LOOP_MEASUREMENT ${JSON.stringify(measurement)}`);
    expect(drift.length).toBeGreaterThan(300);
    expect(measurement.maxDriftMs).toBeLessThan(250);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    clearInterval(timer);
    runs.forEach((r) => r.abort());
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
