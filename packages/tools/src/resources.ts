/**
 * Host resources as part of the tool: heavy board workflow jobs (autorouters, placement seeds, last-mile tries)
 * ask a process-wide governor for admission, are watched while they run, and report what they used.
 *
 * Measured basis (io-c6 placement/routing records): one TraceMaker route of a 318-part board holds
 * 11-14 GB RSS, and two at once OOM-killed the agent session; KiCad API servers are ~150-300 MB;
 * board copies (seeds, tries, candidates) filled the disk until runs started checking for 10 GB free.
 */
import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { cpus } from "node:os";
import { isAbsolute, join } from "node:path";
import { ToolError } from "./registry";

const GiB = 1024 ** 3;

/**
 * Classes are about what a job holds, not which command it runs: `light` (reads, checks, edits), `router`
 * (an autorouter or other multi-GiB engine) and `tracemaker` (the one engine that needs ~12 GiB and runs alone).
 */
export type ResourceClass = "light" | "router" | "tracemaker";

/** Admission needs per class; `exclusive` means one job of that class at a time. */
export const RESOURCE_NEEDS: Record<ResourceClass, { memGiB: number; exclusive: boolean; diskGiB: number }> = {
  light: { memGiB: 0.5, exclusive: false, diskGiB: 1 },
  router: { memGiB: 3, exclusive: false, diskGiB: 10 },
  tracemaker: { memGiB: 12, exclusive: true, diskGiB: 10 },
};

/** Below this much available memory a running job is stopped before the kernel picks a victim. */
export const MEM_FLOOR_GIB = 1.5;

export type HostSample = {
  memTotalGiB: number;
  memAvailableGiB: number;
  swapUsedGiB: number;
  load1: number;
  cpus: number;
  disk: Array<{ path: string; freeGiB: number; totalGiB: number; freeShare: number }>;
};

export type RunningJob = { id: string; label: string; cls: ResourceClass; startedAt: number; pid?: number; peakRssGiB: number; memGiB?: number };

async function meminfo(): Promise<Record<string, number>> {
  const text = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]!] = Number(m[2]) * 1024;
  }
  return out;
}

export async function sampleHost(paths: string[] = []): Promise<HostSample> {
  const m = await meminfo();
  const load = await readFile("/proc/loadavg", "utf8").catch(() => "0");
  const disk = [];
  for (const path of [...new Set(paths)]) {
    const s = await statfs(path).catch(() => null);
    if (!s) continue;
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
    disk.push({ path, freeGiB: round(free / GiB), totalGiB: round(total / GiB), freeShare: total ? round(free / total) : 0 });
  }
  return {
    memTotalGiB: round((m["MemTotal"] ?? 0) / GiB),
    memAvailableGiB: round((m["MemAvailable"] ?? 0) / GiB),
    swapUsedGiB: round(((m["SwapTotal"] ?? 0) - (m["SwapFree"] ?? 0)) / GiB),
    load1: Number(load.split(" ")[0]) || 0,
    cpus: cpus().length,
    disk,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** Resident memory of a process and all its descendants (bytes); 0 when unavailable. */
export async function treeRss(root: number): Promise<number> {
  const children = new Map<number, number[]>();
  for (const name of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid) (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(Number(name));
  }
  let total = 0;
  const queue = [root];
  while (queue.length) {
    const pid = queue.pop()!;
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const kb = /VmRSS:\s+(\d+)/.exec(status);
    if (kb) total += Number(kb[1]) * 1024;
    queue.push(...(children.get(pid) ?? []));
  }
  return total;
}

type Waiter = () => void;

/**
 * One per core process. `admit` resolves when the class's needs are met (memory, exclusivity, disk),
 * calling `onWait` with the reason while it queues; disk below the floor is refused with a proposal
 * instead of waited on, since waiting never frees disk.
 */
export class ResourceGovernor {
  readonly running = new Map<string, RunningJob>();
  private waiters = new Set<Waiter>();
  private seq = 0;
  constructor(private readonly sample: (paths: string[]) => Promise<HostSample> = sampleHost) {}

  async admit(input: {
    cls: ResourceClass;
    label: string;
    paths: string[];
    signal?: AbortSignal;
    onWait?: (why: string) => void;
    pollMs?: number;
    /** Memory this job will hold when it is more than its class default (a large board). */
    memGiB?: number;
  }): Promise<RunningJob & { release(): void }> {
    const base = RESOURCE_NEEDS[input.cls];
    const need = { ...base, memGiB: Math.max(base.memGiB, input.memGiB ?? 0) };
    for (;;) {
      if (input.signal?.aborted) throw new ToolError("cancelled while waiting for resources", "cancelled");
      const host = await this.sample(input.paths);
      const lowDisk = host.disk.find((d) => d.freeGiB < need.diskGiB || (input.cls !== "light" && d.freeShare < 0.1));
      if (lowDisk)
        throw new ToolError(
          `disk: ${lowDisk.freeGiB} GiB free (${Math.round(lowDisk.freeShare * 100)} %) on ${lowDisk.path}; a ${input.cls} job needs ${need.diskGiB} GiB and 10 %. ` +
            "Free reproducible copies first (board copies from seeds, tries and candidates are reproducible).",
          "precondition",
        );
      const sameClass = [...this.running.values()].filter((j) => j.cls === input.cls);
      // memory other heavy jobs already admitted will still claim (they may not have peaked yet)
      const reserved = [...this.running.values()].reduce(
        (sum, j) => sum + Math.max(0, (j.memGiB ?? RESOURCE_NEEDS[j.cls].memGiB) - j.peakRssGiB),
        0,
      );
      const free = host.memAvailableGiB - reserved;
      const why =
        need.exclusive && sameClass.length
          ? `waiting: one ${input.cls} job at a time (${sameClass[0]!.label} running)`
          : free < need.memGiB
            ? `waiting for memory: ${round(free)} GiB free after reservations, ${need.memGiB} GiB needed`
            : null;
      if (!why) {
        const job: RunningJob = { id: `job${++this.seq}`, label: input.label, cls: input.cls, startedAt: Date.now(), peakRssGiB: 0, memGiB: need.memGiB };
        this.running.set(job.id, job);
        return {
          ...job,
          release: () => {
            this.running.delete(job.id);
            for (const w of [...this.waiters]) w();
          },
        };
      }
      input.onWait?.(why);
      await new Promise<void>((resolve) => {
        const w: Waiter = () => {
          this.waiters.delete(w);
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(w, input.pollMs ?? 5000);
        this.waiters.add(w);
        input.signal?.addEventListener("abort", w, { once: true });
      });
    }
  }

  /** Record a running job's process tree for status, peak RSS and the memory floor watchdog. */
  track(id: string, pid: number) {
    const job = this.running.get(id);
    if (job) job.pid = pid;
  }
}

let shared: ResourceGovernor | null = null;
export function governor(): ResourceGovernor {
  return (shared ??= new ResourceGovernor());
}
/** Replace the shared governor (tests use a fixed host so results do not depend on this machine's disk). */
export function setGovernor(g: ResourceGovernor | null): void {
  shared = g;
}

/** GiB a board job holds per MB of board file, measured on an 85 MB board (last-mile try 5.0 GiB, finish 4.0, edit impact 2.0). */
export const GIB_PER_BOARD_MB = 0.06;

/**
 * Memory a board job will hold, from the largest `.kicad_pcb` named by the given absolute paths (a file, a folder, or a
 * folder one level down such as a bench's step). Returns 0 when no board is named; pass the result as `admit({ memGiB })`.
 */
export async function boardMemGiB(paths: string[]): Promise<number> {
  let largest = 0;
  const consider = async (p: string) => {
    const s = await stat(p).catch(() => null);
    if (s?.isFile() && p.endsWith(".kicad_pcb")) largest = Math.max(largest, s.size);
  };
  for (const a of paths.filter((x) => isAbsolute(x))) {
    if (a.endsWith(".kicad_pcb")) {
      await consider(a);
      continue;
    }
    for (const e of await readdir(a, { withFileTypes: true }).catch(() => [])) {
      if (e.isFile()) await consider(join(a, e.name));
      else if (e.isDirectory() && !e.name.startsWith("."))
        for (const f of await readdir(join(a, e.name)).catch(() => [] as string[])) if (f.endsWith(".kicad_pcb")) await consider(join(a, e.name, f));
    }
  }
  return Math.round((largest / 1e6) * GIB_PER_BOARD_MB * 10) / 10;
}
