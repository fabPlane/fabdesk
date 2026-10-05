/** Durable ownership of agent CLIs, so a dead core cannot leave a thread writer alive. */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const AGENT_OWNER_DIR = "FABDESK_AGENT_OWNER_DIR";

/** Birth identity prevents a reused PID from being mistaken for our old process. */
export function processIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return null;
      return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
    }
    const result =
      process.platform === "win32"
        ? Bun.spawnSync([
            "powershell",
            "-NoProfile",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ])
        : Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
    const value = result.stdout.toString().trim();
    return result.exitCode === 0 && value ? value : null;
  } catch {
    return null;
  }
}

type Owner = {
  ownerPid: number;
  ownerIdentity: string;
  pid: number;
  identity: string;
  descendants?: Array<{ pid: number; identity: string }>;
};

export function trackAgentProcess(
  directory: string,
  pid: number,
  descendants: (pid: number) => number[] = () => [],
): () => void {
  const ownerIdentity = processIdentity(process.pid);
  const identity = processIdentity(pid);
  // A CLI that already exited holds no live writer. Never record an ambiguous identity.
  if (!identity) return () => {};
  if (!ownerIdentity) throw new Error("cannot establish core process identity");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.json`);
  const seen = new Map<number, string>();
  const persist = () => {
    if (processIdentity(pid) === identity) {
      for (const child of descendants(pid)) {
        const birth = processIdentity(child);
        if (birth) seen.set(child, birth);
      }
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
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
      renameSync(temporary, path);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* already renamed */
      }
    }
  };
  persist();
  const timer = setInterval(() => {
    try {
      persist();
    } catch (error) {
      console.error(`agent ownership update failed: ${String(error)}`);
    }
  }, 250);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      unlinkSync(path);
    } catch {
      /* recovery can remove a finished record */
    }
  };
}

export async function recoverAgentProcesses(
  directory: string,
  stop: (pid: number) => void,
): Promise<number> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records: Array<{ path: string; owner: Owner }> = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const path = join(directory, name);
    const owner = JSON.parse(await readFile(path, "utf8")) as Owner;
    if (
      !Number.isSafeInteger(owner.pid) ||
      !Number.isSafeInteger(owner.ownerPid) ||
      owner.pid <= 0 ||
      owner.ownerPid <= 0 ||
      typeof owner.identity !== "string" ||
      typeof owner.ownerIdentity !== "string"
    )
      throw new Error(`invalid agent ownership record: ${name}`);
    // Refuse a second core before it can mark the first core's runs failed.
    if (processIdentity(owner.ownerPid) === owner.ownerIdentity)
      throw new Error(`agent writer belongs to live core ${owner.ownerPid}`);
    records.push({ path, owner });
  }
  let recovered = 0;
  for (const { path, owner } of records) {
    const targets = [
      ...(owner.descendants ?? []).reverse(),
      { pid: owner.pid, identity: owner.identity },
    ];
    for (const target of targets) {
      if (
        !Number.isSafeInteger(target.pid) ||
        target.pid <= 0 ||
        typeof target.identity !== "string"
      )
        throw new Error("invalid descendant ownership record");
      if (processIdentity(target.pid) !== target.identity) continue;
      stop(target.pid);
      for (
        let attempt = 0;
        attempt < 100 && processIdentity(target.pid) === target.identity;
        attempt++
      )
        await Bun.sleep(20);
      if (processIdentity(target.pid) === target.identity)
        throw new Error(`orphan agent ${target.pid} did not stop`);
      recovered++;
    }
    await unlink(path);
  }
  return recovered;
}
