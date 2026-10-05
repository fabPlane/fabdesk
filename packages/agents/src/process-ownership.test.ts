import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processIdentity, recoverAgentProcesses, trackAgentProcess } from "./process-ownership";
import { descendantPids, killTree, runAgentProcess } from "./process";

test("crashed owner releases its verified orphan writer; live owner and reused PID remain protected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fabdesk-owner-"));
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const release = trackAgentProcess(directory, child.pid);
    await expect(
      recoverAgentProcesses(directory, (pid) => killTree(pid, "SIGKILL")),
    ).rejects.toThrow("live core");
    expect(child.exitCode).toBeNull();
    const path = join(directory, (await readdir(directory))[0]!);
    const record = JSON.parse(await readFile(path, "utf8"));
    record.ownerIdentity = "dead-core-incarnation";
    record.identity = "old-pid-incarnation";
    await writeFile(path, JSON.stringify(record));
    expect(
      await recoverAgentProcesses(directory, () => {
        throw new Error("must not kill reused pid");
      }),
    ).toBe(0);
    expect(child.exitCode).toBeNull();
    await writeFile(path, JSON.stringify({ ...record, identity: processIdentity(child.pid) }));
    expect(await recoverAgentProcesses(directory, (pid) => killTree(pid, "SIGKILL"))).toBe(1);
    await child.exited;
    expect(await readdir(directory)).toEqual([]);
    release();
  } finally {
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
  let release = () => {};
  try {
    const reader = wrapper.stdout.getReader();
    childPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
    release = trackAgentProcess(directory, wrapper.pid, descendantPids);
    const path = join(directory, (await readdir(directory))[0]!);
    const record = JSON.parse(await readFile(path, "utf8"));
    expect(record.descendants.some((p: { pid: number }) => p.pid === childPid)).toBe(true);
    wrapper.kill();
    await wrapper.exited;
    await writeFile(path, JSON.stringify({ ...record, ownerIdentity: "crashed-core" }));
    expect(await recoverAgentProcesses(directory, (pid) => killTree(pid, "SIGKILL"))).toBe(1);
    expect(processIdentity(childPid)).toBeNull();
  } finally {
    release();
    if (wrapper.exitCode === null) wrapper.kill();
    await wrapper.exited;
    if (childPid && processIdentity(childPid)) killTree(childPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
