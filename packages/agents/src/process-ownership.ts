/** Durable, birth-identity-checked ownership. Windows recovery is unsupported: no safe
 * native-child birth identity is available here; never guess from a PID or delete CLI locks. */
import { readdir, readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const AGENT_OWNER_DIR = "FABDESK_AGENT_OWNER_DIR";
export const OWNERSHIP_SAMPLE_MS = 5000;
type ProcessInfo = { pid: number; parent: number; identity: string };
type Owner = {
  ownerPid: number;
  ownerIdentity: string;
  pid: number;
  identity: string;
  descendants?: Array<{ pid: number; identity: string }>;
};

async function linuxProcess(pid: number, boot: string): Promise<ProcessInfo | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || !fields[19]) return null;
    return { pid, parent: Number(fields[1]), identity: `${boot}:${fields[19]}` };
  } catch {
    return null;
  }
}

/** One asynchronous batched ps on macOS; no external probes on Linux or Windows. */
export async function processSnapshot(
  platform: NodeJS.Platform = process.platform,
  command: (args: string[]) => Promise<string> = async (args) => {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`process probe exited ${code}`);
    return output;
  },
): Promise<Map<number, ProcessInfo>> {
  const result = new Map<number, ProcessInfo>();
  if (platform === "win32") return result;
  if (platform === "linux") {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const names = await readdir("/proc");
    await Promise.all(
      names
        .filter((n) => /^\d+$/.test(n))
        .map(async (n) => {
          const info = await linuxProcess(Number(n), boot);
          if (info) result.set(info.pid, info);
        }),
    );
    return result;
  }
  const output = await command(["ps", "-A", "-o", "pid=,ppid=,stat=,lstart="]);
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (match && !match[3]!.startsWith("Z")) {
      const pid = Number(match[1]);
      result.set(pid, { pid, parent: Number(match[2]), identity: match[4]! });
    }
  }
  return result;
}

export async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    return (await linuxProcess(pid, boot.trim()))?.identity ?? null;
  }
  return (await processSnapshot()).get(pid)?.identity ?? null;
}

/** Initial capture, one early native-child capture, then sparse non-overlapping samples.
 * Async cleanup waits for any pending write, preventing a completed record from reappearing. */
export async function trackAgentProcess(
  directory: string,
  pid: number,
): Promise<() => Promise<void>> {
  if (process.platform === "win32") {
    console.warn(
      "agent crash recovery unsupported on Windows; native child ownership is not recorded",
    );
    return async () => {};
  }
  const first = await processSnapshot();
  const ownerIdentity = first.get(process.pid)?.identity;
  const identity = first.get(pid)?.identity;
  if (!identity) return async () => {};
  if (!ownerIdentity) throw new Error("cannot establish core process identity");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.json`);
  const seen = new Map<number, string>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = async (snapshot: Map<number, ProcessInfo>) => {
    if (snapshot.get(pid)?.identity === identity) {
      const queue = [pid];
      const visited = new Set(queue);
      for (const parent of queue)
        for (const child of snapshot.values()) {
          if (child.parent === parent && !visited.has(child.pid)) {
            visited.add(child.pid);
            queue.push(child.pid);
            seen.set(child.pid, child.identity);
          }
        }
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          ownerPid: process.pid,
          ownerIdentity,
          pid,
          identity,
          descendants: [...seen].map(([pid, identity]) => ({ pid, identity })),
        } satisfies Owner),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };
  await persist(first);
  let pending: Promise<void> = Promise.resolve();
  const schedule = (delay: number) => {
    timer = setTimeout(() => {
      pending = processSnapshot()
        .then(persist)
        .catch((error) => {
          console.error(`agent ownership update failed: ${String(error)}`);
        })
        .finally(() => {
          if (!closed) schedule(OWNERSHIP_SAMPLE_MS);
        });
    }, delay);
    timer.unref();
  };
  schedule(100);
  return async () => {
    closed = true;
    clearTimeout(timer);
    await pending;
    await unlink(path).catch(() => {});
  };
}

export type RecoveryResult = { recovered: number; liveOwners: number[]; failures: string[] };
function validProcess(value: unknown): value is { pid: number; identity: string } {
  const p = value as { pid?: number; identity?: string } | null;
  return (
    !!p &&
    Number.isSafeInteger(p.pid) &&
    p.pid! > 0 &&
    typeof p.identity === "string" &&
    !!p.identity
  );
}

/** Recovery is best effort. Malformed records are quarantined; stop failures remain for retry. */
export async function recoverAgentProcesses(
  directory: string,
  stop: (pid: number, identity: string) => void | Promise<void>,
  options: { waitMs?: number } = {},
): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: 0, liveOwners: [], failures: [] };
  const report = (reason: string) => {
    result.failures.push(reason);
    console.error(reason);
  };
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      report(`cannot read agent ownership directory: ${String(error)}`);
    return result;
  }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const path = join(directory, name);
    let owner: Owner;
    try {
      owner = JSON.parse(await readFile(path, "utf8"));
      if (
        !validProcess(owner) ||
        !validProcess({ pid: owner.ownerPid, identity: owner.ownerIdentity }) ||
        (owner.descendants !== undefined &&
          (!Array.isArray(owner.descendants) || !owner.descendants.every(validProcess)))
      )
        throw new Error("invalid ownership record");
    } catch (error) {
      report(`bad agent ownership record ${name}: ${String(error)}`);
      try {
        const quarantine = join(directory, "quarantine");
        await mkdir(quarantine, { recursive: true, mode: 0o700 });
        await rename(path, join(quarantine, `${randomUUID()}-${name}`));
      } catch (error) {
        report(`cannot quarantine ${name}: ${String(error)}`);
      }
      continue;
    }
    try {
      if (process.platform === "win32") {
        report(
          `Windows agent recovery unsupported: ${name}; writer may still hold its thread lock`,
        );
        continue;
      }
      if ((await processIdentity(owner.ownerPid)) === owner.ownerIdentity) {
        result.liveOwners.push(owner.ownerPid);
        console.warn(
          `agent writer belongs to live core ${owner.ownerPid}; preserving its processes and runs`,
        );
        continue;
      }
      let failed = false;
      for (const target of [...(owner.descendants ?? [])]
        .reverse()
        .concat({ pid: owner.pid, identity: owner.identity })) {
        if ((await processIdentity(target.pid)) !== target.identity) continue;
        try {
          await stop(target.pid, target.identity);
          const deadline = Date.now() + (options.waitMs ?? 2000);
          while ((await processIdentity(target.pid)) === target.identity && Date.now() < deadline)
            await Bun.sleep(20);
          if ((await processIdentity(target.pid)) === target.identity)
            throw new Error(
              `orphan agent ${target.pid} did not stop; thread writer lock may remain held`,
            );
          result.recovered++;
        } catch (error) {
          failed = true;
          report(`agent recovery ${name}: ${String(error)}`);
        }
      }
      if (!failed) await unlink(path);
    } catch (error) {
      report(`agent recovery ${name}: ${String(error)}`);
    }
  }
  return result;
}

/** Recovery also reaches descendants spawned since the last durable sample, without sync ps. */
export async function stopAgentProcess(pid: number, expectedIdentity: string): Promise<void> {
  const snapshot = await processSnapshot();
  if (snapshot.get(pid)?.identity !== expectedIdentity) return;
  const targets = [pid];
  const visited = new Set(targets);
  for (const parent of targets)
    for (const child of snapshot.values()) {
      if (child.parent === parent && !visited.has(child.pid)) {
        visited.add(child.pid);
        targets.push(child.pid);
      }
    }
  for (const target of targets.reverse()) {
    const identity = snapshot.get(target)?.identity;
    if (identity && (await processIdentity(target)) === identity) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
