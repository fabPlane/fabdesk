/**
 * What the host has, read the same way on Linux, macOS and Windows: available memory, swap, per-process resident
 * memory and whether a program is running. Shared by the bench (how many candidates at once) and the tools package's
 * resource governor (admission), so both see one number. Nothing here throws: a reading that fails falls back to
 * `node:os`, and a value that cannot be known is 0.
 *
 * Available memory per platform:
 * - Linux: `/proc/meminfo` MemAvailable (the kernel's own estimate of memory a new job can take without swapping).
 * - macOS: `vm_stat`. `os.freemem()` counts only the free list, which a busy Mac keeps near empty (< 1 GiB is normal)
 *   because the file cache and compressor fill the rest. Available is total minus what Activity Monitor calls used:
 *   app memory (anonymous pages less purgeable ones) + wired + pages occupied by the compressor. Older `vm_stat`
 *   without "Anonymous pages" falls back to free + inactive + speculative. Purgeable pages are not added on top in
 *   that fallback because they already sit in the active/inactive counts.
 * - Windows: `os.freemem()`, which is the available physical memory (GlobalMemoryStatusEx ullAvailPhys).
 */
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { freemem, totalmem } from "node:os";

const GiB = 1024 ** 3;

/** Seams for tests: the platform, file reads (`""` when missing) and command runs (`null` when it could not run). */
export interface SysDeps {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  readdir?: (path: string) => Promise<string[]>;
  run?: (cmd: string, args: string[]) => { code: number | null; stdout: string } | null;
  freemem?: () => number;
  totalmem?: () => number;
}

export interface HostMemory {
  totalGiB: number;
  availableGiB: number;
  /** Swap in use; 0 when the platform does not say. */
  swapUsedGiB: number;
  /** Where the numbers came from (`os` is the last resort). */
  source: "proc" | "vm_stat" | "os";
}

const defaultRun: NonNullable<SysDeps["run"]> = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000, windowsHide: true });
  return r.error ? null : { code: r.status, stdout: r.stdout ?? "" };
};

function resolve(deps: SysDeps) {
  return {
    platform: deps.platform ?? process.platform,
    readFile: deps.readFile ?? ((p: string) => readFile(p, "utf8").catch(() => "")),
    readdir: deps.readdir ?? ((p: string) => readdir(p).catch(() => [] as string[])),
    run: deps.run ?? defaultRun,
    freemem: deps.freemem ?? freemem,
    totalmem: deps.totalmem ?? totalmem,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;

/** `/proc/meminfo` as bytes by field. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) out[m[1]!] = Number(m[2]) * 1024;
  }
  return out;
}

/** `vm_stat` output: the page size (bytes) and page counts by field name ("Pages free", "Anonymous pages", ...). */
export function parseVmStat(text: string): { pageSize: number; pages: Record<string, number> } | null {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return null;
  const pages: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (m) pages[m[1]!.trim()] = Number(m[2]);
  }
  return { pageSize: Number(size[1]), pages };
}

/** Available bytes from a parsed `vm_stat`, or null when the fields are not there. */
export function vmStatAvailable(vm: { pageSize: number; pages: Record<string, number> }, totalBytes: number): number | null {
  const p = vm.pages;
  const free = p["Pages free"], spec = p["Pages speculative"], inactive = p["Pages inactive"];
  const anon = p["Anonymous pages"], wired = p["Pages wired down"];
  if (anon !== undefined && wired !== undefined && totalBytes > 0) {
    const used = Math.max(0, anon - (p["Pages purgeable"] ?? 0)) + wired + (p["Pages occupied by compressor"] ?? 0);
    return Math.min(totalBytes, Math.max(0, totalBytes - used * vm.pageSize));
  }
  if (free !== undefined && inactive !== undefined) return (free + inactive + (spec ?? 0)) * vm.pageSize;
  return null;
}

/** `sysctl -n vm.swapusage` ("total = 2048.00M  used = 1024.50M  free = ...") as bytes used; 0 when unreadable. */
export function parseSwapUsage(text: string): number {
  const m = /used\s*=\s*([\d.]+)([KMGT]?)/i.exec(text);
  if (!m) return 0;
  const unit = { "": 1, K: 1024, M: 1024 ** 2, G: GiB, T: 1024 ** 4 }[m[2]!.toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Number(m[1]) * unit;
}

/** Memory the host has now (see the file comment for the source per platform). */
export async function hostMemory(deps: SysDeps = {}): Promise<HostMemory> {
  const d = resolve(deps);
  const total = d.totalmem();
  const fromOs = (): HostMemory => ({ totalGiB: round(total / GiB), availableGiB: round(d.freemem() / GiB), swapUsedGiB: 0, source: "os" });
  if (d.platform === "linux") {
    const m = parseMeminfo(await d.readFile("/proc/meminfo"));
    if (m["MemAvailable"] === undefined) return fromOs();
    return {
      totalGiB: round((m["MemTotal"] ?? total) / GiB),
      availableGiB: round(m["MemAvailable"] / GiB),
      swapUsedGiB: round(Math.max(0, (m["SwapTotal"] ?? 0) - (m["SwapFree"] ?? 0)) / GiB),
      source: "proc",
    };
  }
  if (d.platform === "darwin") {
    const out = d.run("vm_stat", []);
    const vm = out?.code === 0 ? parseVmStat(out.stdout) : null;
    const avail = vm ? vmStatAvailable(vm, total) : null;
    if (avail === null) return fromOs();
    const swap = d.run("sysctl", ["-n", "vm.swapusage"]);
    return { totalGiB: round(total / GiB), availableGiB: round(avail / GiB), swapUsedGiB: round(swap?.code === 0 ? parseSwapUsage(swap.stdout) / GiB : 0), source: "vm_stat" };
  }
  return fromOs();
}

/** `ps -A -o pid=,ppid=,rss=` rows (rss in KiB). */
export function parsePs(text: string): Array<{ pid: number; ppid: number; rssBytes: number }> {
  const rows = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssBytes: Number(m[3]) * 1024 });
  }
  return rows;
}

/**
 * Resident memory of a process and all its descendants (bytes); 0 when unavailable. Linux reads `/proc`, macOS (and a
 * Linux without `/proc`) one `ps` call; Windows has no parent links without WMI, so it reports 0.
 */
export async function treeRss(root: number, deps: SysDeps = {}): Promise<number> {
  const d = resolve(deps);
  if (d.platform === "win32") return 0;
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  const link = (pid: number, ppid: number) => (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
  const names = d.platform === "linux" ? (await d.readdir("/proc")).filter((n) => /^\d+$/.test(n)) : [];
  if (names.length) {
    for (const name of names) {
      const stat = await d.readFile(`/proc/${name}/stat`);
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid) link(Number(name), ppid);
    }
  } else {
    const out = d.run("ps", ["-A", "-o", "pid=,ppid=,rss="]);
    if (out?.code !== 0) return 0;
    for (const r of parsePs(out.stdout)) {
      link(r.pid, r.ppid);
      rss.set(r.pid, r.rssBytes);
    }
  }
  let total = 0;
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (names.length) {
      const kb = /VmRSS:\s+(\d+)/.exec(await d.readFile(`/proc/${pid}/status`));
      if (kb) total += Number(kb[1]) * 1024;
    } else total += rss.get(pid) ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return total;
}

/**
 * True while a program with this name runs anywhere on the machine. `pgrep -x` on Linux and macOS (Linux falls back to
 * `/proc/<pid>/comm` when pgrep is missing), `tasklist` on Windows (`name.exe`). False when nothing can tell.
 */
export async function processRunning(name: string, deps: SysDeps = {}): Promise<boolean> {
  const d = resolve(deps);
  if (d.platform === "win32") {
    const image = /\.exe$/i.test(name) ? name : `${name}.exe`;
    const out = d.run("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"]);
    return !!out && out.code === 0 && out.stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
  }
  const out = d.run("pgrep", ["-x", name]);
  if (out) return out.code === 0;
  if (d.platform !== "linux") return false;
  for (const pid of (await d.readdir("/proc")).filter((n) => /^\d+$/.test(n)))
    if ((await d.readFile(`/proc/${pid}/comm`)).trim() === name) return true;
  return false;
}
