/**
 * Host resources as part of the tool: heavy board workflow jobs (autorouters, placement seeds, last-mile tries)
 * ask a process-wide governor for admission. Admission is the whole of it: a running job is not watched or stopped
 * by the governor (no per-job RSS sampling, no memory-floor watchdog); its estimate is held until it releases.
 *
 * Measured basis (io-c6 placement/routing records): one TraceMaker route of a 318-part board holds
 * 11-14 GB RSS, and two at once OOM-killed the agent session; KiCad API servers are ~150-300 MB;
 * board copies (seeds, tries, candidates) filled the disk until runs started checking for 10 GB free.
 */
import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { layout, sysinfo } from "@fabdesk/board-workflow";
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

export type HostSample = {
  memTotalGiB: number;
  memAvailableGiB: number;
  swapUsedGiB: number;
  load1: number;
  cpus: number;
  disk: Array<{ path: string; freeGiB: number; totalGiB: number; freeShare: number }>;
};

export type RunningJob = { id: string; label: string; cls: ResourceClass; startedAt: number; memGiB?: number };

/** Seams for `sampleHost` (tests simulate macOS, Windows and hosts with no data): memory, load, CPUs and disk. */
export interface SampleDeps {
  memory?: () => Promise<sysinfo.HostMemory>;
  loadavg?: () => number[];
  cpus?: () => number;
  statfs?: (path: string) => Promise<{ bavail: number; bsize: number; blocks: number } | null>;
}

/**
 * The host now, on Linux, macOS and Windows: memory from `sysinfo.hostMemory` (the bench reads the same number), load
 * from `os.loadavg()` (always 0 on Windows, which has no load average; nothing admits on it), disk by `statfs` per
 * path (a path statfs cannot read is left out, so it is not checked).
 */
export async function sampleHost(paths: string[] = [], deps: SampleDeps = {}): Promise<HostSample> {
  const mem = await (deps.memory ?? (() => sysinfo.hostMemory()))().catch(() => null);
  const load = (deps.loadavg ?? loadavg)()[0] ?? 0;
  const disk = [];
  for (const path of [...new Set(paths)]) {
    const s = await (deps.statfs ? deps.statfs(path) : statfs(path)).catch(() => null);
    if (!s) continue;
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
    disk.push({ path, freeGiB: round(free / GiB), totalGiB: round(total / GiB), freeShare: total ? round(free / total) : 0 });
  }
  return {
    memTotalGiB: mem?.totalGiB ?? 0,
    memAvailableGiB: mem?.availableGiB ?? 0,
    swapUsedGiB: mem?.swapUsedGiB ?? 0,
    load1: Number.isFinite(load) ? round(load) : 0,
    cpus: (deps.cpus ?? (() => cpus().length))(),
    disk,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

type Waiter = () => void;

/**
 * One per core process. `admit` resolves when the class's needs are met (memory, exclusivity, disk),
 * calling `onWait` with the reason while it queues; disk below the floor is refused with a proposal
 * instead of waited on, since waiting never frees disk.
 *
 * Memory: free = available now − the estimate of every admitted job still running. The governor does not measure a
 * job's own use, so a job that already holds its memory is counted twice (once gone from `available`, once reserved);
 * near the limit a heavy job therefore queues somewhat early behind another, which errs toward not swapping.
 *
 * Liveness: a job only ever waits on another admitted job, which will release. Short memory with no other
 * admitted job running is admitted at once with a note (every class alike): nothing this governor controls
 * would free memory, the needs are estimates, and refusing would make heavy tools unusable on a small machine.
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
    /** Progress: why the job queues, and the note when it is admitted short on memory with nothing else running. */
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
      // only the job's own board-based estimate can refuse it; class defaults are conservative constants, not this board
      const own = input.memGiB ?? 0;
      if (host.memTotalGiB > 0 && own > host.memTotalGiB)
        throw new ToolError(
          `${input.label} needs about ${own} GiB of memory and this machine has ${round(host.memTotalGiB)} GiB in all; ` +
            "it would run the machine out of memory. A KRT or TraceMaker run grids the whole board whatever the step; use a machine with more memory, or fill:freerouting.",
          "precondition",
        );
      const sameClass = [...this.running.values()].filter((j) => j.cls === input.cls);
      // each running job's whole estimate (what it may still claim; see the class comment for the overlap with `available`)
      const reserved = [...this.running.values()].reduce((sum, j) => sum + (j.memGiB ?? RESOURCE_NEEDS[j.cls].memGiB), 0);
      const free = host.memAvailableGiB - reserved;
      const short = free < need.memGiB;
      const why =
        need.exclusive && sameClass.length
          ? `waiting: one ${input.cls} job at a time (${sameClass[0]!.label} running)`
          : short && this.running.size
            ? `waiting for memory: ${round(free)} GiB free after reservations, ${need.memGiB} GiB needed (${this.running.size} board job(s) running)`
            : null;
      if (!why && short && (input.cls === "router" || input.cls === "tracemaker") && own > host.memAvailableGiB)
        // the liveness rule (start anyway when nothing else runs) is for estimates that may be pessimistic; a router run on a
        // large board holds a grid that big, so starting it short of memory would run the machine out instead
        throw new ToolError(
          `${input.label} needs about ${own} GiB of memory and only ${round(host.memAvailableGiB)} GiB is available now (${round(host.memTotalGiB)} GiB in all); ` +
            "close other applications and try again (a KRT or TraceMaker run grids the whole board whatever the step), or use fill:freerouting.",
          "precondition",
        );
      if (!why) {
        if (short)
          input.onWait?.(
            `memory is short: ${round(host.memAvailableGiB)} GiB available, ${need.memGiB} GiB estimated for ${input.label}; ` +
              "no other board job is running, so waiting would not free any — starting anyway (close other applications if the machine starts swapping)",
          );
        const job: RunningJob = { id: `job${++this.seq}`, label: input.label, cls: input.cls, startedAt: Date.now(), memGiB: need.memGiB };
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
  const { bytes } = await largestBoard(paths);
  return Math.round((bytes / 1e6) * GIB_PER_BOARD_MB * 10) / 10;
}

/**
 * Memory an ECO (board_edit impact / apply / proof) holds on the largest board the paths name: about 0.16 GiB per MB of
 * board file, measured on jetson (86 MB): the edit child peaked at 13.8 GB with its scoring DRC (impact alone 3.7 GiB,
 * apply 6.8 GiB before scoring, kicad-cli's refilled DRC on top). The compute runs in a child process (child-tasks.ts),
 * so this estimate is what keeps two edits, or an edit and a router run, from running out of memory together.
 */
export async function editMemGiB(paths: string[]): Promise<number> {
  const { bytes } = await largestBoard(paths);
  return Math.round((bytes / 1e6) * 0.16 * 10) / 10;
}

/**
 * Memory one router run (KiCadRoutingTools, TraceMaker) holds on the largest board the paths name: from the board's
 * outline area x copper layers (board-workflow `routerFootprint`, measured on vme-wren and jetson), never below the
 * file-size rule. 0 when no board is named.
 */
export async function routerMemGiB(paths: string[]): Promise<number> {
  const { file, bytes } = await largestBoard(paths);
  if (!file) return 0;
  const text = await readFile(file, "utf8").catch(() => null);
  if (!text) return boardMemGiB(paths);
  try {
    return layout.routerFootprint(layout.boardGridShape(text), bytes).memGiB; // a light scan, not a full parse
  } catch {
    return boardMemGiB(paths);
  }
}

async function largestBoard(paths: string[]): Promise<{ file: string | null; bytes: number }> {
  let largest = 0;
  let file: string | null = null;
  const consider = async (p: string) => {
    const s = await stat(p).catch(() => null);
    if (s?.isFile() && p.endsWith(".kicad_pcb") && s.size > largest) {
      largest = s.size;
      file = p;
    }
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
  return { file, bytes: largest };
}
