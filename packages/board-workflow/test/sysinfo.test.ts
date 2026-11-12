import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layout, sysinfo } from "../src/index";
import type * as S from "../src/sysinfo";

const GiB = 1024 ** 3;

/** A fake host: files by path, command output by "cmd args", fixed os numbers. */
function fake(o: { platform: NodeJS.Platform; files?: Record<string, string>; cmds?: Record<string, string | null>; free?: number; total?: number }): S.SysDeps {
  const runs: string[] = [];
  return {
    platform: o.platform,
    readFile: async (p) => o.files?.[p] ?? "",
    readdir: async (p) => [...new Set(Object.keys(o.files ?? {}).filter((f) => f.startsWith(p + "/")).map((f) => f.slice(p.length + 1).split("/")[0]!))],
    run: (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      runs.push(key);
      if (!o.cmds || !(key in o.cmds)) return null;
      const out = o.cmds[key];
      return out === null || out === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: out };
    },
    freemem: () => o.free ?? 0,
    totalmem: () => o.total ?? 0,
  };
}

const MEMINFO = `MemTotal:       32000000 kB
MemFree:         1000000 kB
MemAvailable:   20971520 kB
SwapTotal:       8388608 kB
SwapFree:        7340032 kB
`;

// macOS 14 on Apple Silicon (16 GiB, 16 KiB pages): the free list alone is 63 MB.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4047.
Pages active:                            252698.
Pages inactive:                          249802.
Pages speculative:                         2054.
Pages throttled:                              0.
Pages wired down:                        124556.
Pages purgeable:                           8569.
"Translation faults":                1043452406.
Pages copy-on-write:                   29567390.
Pages zero filled:                    465451829.
Pages reactivated:                     15585656.
Pages purged:                           2862826.
File-backed pages:                       179870.
Anonymous pages:                         324684.
Pages stored in compressor:              730458.
Pages occupied by compressor:            346453.
Decompressions:                        15898522.
Compressions:                          24101148.
Pageins:                               17617830.
Pageouts:                                138961.
Swapins:                                      0.
Swapouts:                                     0.
`;

describe("host memory per platform", () => {
  test("Linux reads MemAvailable and swap from /proc/meminfo", async () => {
    const m = await sysinfo.hostMemory(fake({ platform: "linux", files: { "/proc/meminfo": MEMINFO }, free: 1 * GiB, total: 32 * GiB }));
    expect(m).toEqual({ totalGiB: 30.52, availableGiB: 20, swapUsedGiB: 1, source: "proc" });
  });

  test("Linux without /proc falls back to os.freemem", async () => {
    const m = await sysinfo.hostMemory(fake({ platform: "linux", free: 3 * GiB, total: 8 * GiB }));
    expect(m).toEqual({ totalGiB: 8, availableGiB: 3, swapUsedGiB: 0, source: "os" });
  });

  test("macOS counts what Activity Monitor calls available, not the free list", async () => {
    const m = await sysinfo.hostMemory(
      fake({ platform: "darwin", cmds: { vm_stat: VM_STAT, "sysctl -n vm.swapusage": "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)" }, free: 4047 * 16384, total: 16 * GiB }),
    );
    // used = (anonymous 324684 - purgeable 8569) + wired 124556 + compressor 346453 = 787124 pages of 16 KiB = 12.01 GiB
    expect(m.source).toBe("vm_stat");
    expect(m.availableGiB).toBe(3.99);
    expect(m.swapUsedGiB).toBe(1);
    expect(m.totalGiB).toBe(16);
  });

  test("older vm_stat without anonymous pages: free + inactive + speculative, 4 KiB pages", async () => {
    const old = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              262144.
Pages active:                            100000.
Pages inactive:                          262144.
Pages speculative:                       262144.
Pages wired down:                         50000.
Pages purgeable:                          10000.
`;
    const m = await sysinfo.hostMemory(fake({ platform: "darwin", cmds: { vm_stat: old }, total: 8 * GiB }));
    expect(m).toEqual({ totalGiB: 8, availableGiB: 3, swapUsedGiB: 0, source: "vm_stat" });
  });

  test("macOS without a readable vm_stat uses os.freemem as the last resort", async () => {
    expect(await sysinfo.hostMemory(fake({ platform: "darwin", free: 2 * GiB, total: 16 * GiB }))).toEqual({ totalGiB: 16, availableGiB: 2, swapUsedGiB: 0, source: "os" });
    expect((await sysinfo.hostMemory(fake({ platform: "darwin", cmds: { vm_stat: "garbage" }, free: 2 * GiB, total: 16 * GiB }))).source).toBe("os");
  });

  test("Windows uses os.freemem (available physical memory)", async () => {
    expect(await sysinfo.hostMemory(fake({ platform: "win32", free: 6.5 * GiB, total: 16 * GiB }))).toEqual({ totalGiB: 16, availableGiB: 6.5, swapUsedGiB: 0, source: "os" });
  });

  test("swap usage units", () => {
    expect(sysinfo.parseSwapUsage("total = 4.00G  used = 1.50G  free = 2.50G")).toBe(1.5 * GiB);
    expect(sysinfo.parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toBe(0);
    expect(sysinfo.parseSwapUsage("")).toBe(0);
  });

  test("this machine gives a positive reading", async () => {
    const m = await sysinfo.hostMemory();
    expect(m.availableGiB).toBeGreaterThan(0);
    expect(m.totalGiB).toBeGreaterThanOrEqual(m.availableGiB);
  });
});

describe("process tree memory", () => {
  test("Linux sums VmRSS over /proc descendants", async () => {
    const files = {
      "/proc/10/stat": "10 (python) S 1 10",
      "/proc/11/stat": "11 (tm (x)) S 10 10",
      "/proc/12/stat": "12 (other) S 1 12",
      "/proc/10/status": "VmRSS:\t  1024 kB\n",
      "/proc/11/status": "VmRSS:\t  2048 kB\n",
      "/proc/12/status": "VmRSS:\t  9999 kB\n",
    };
    expect(await sysinfo.treeRss(10, fake({ platform: "linux", files }))).toBe(3072 * 1024);
  });

  test("macOS reads one ps listing", async () => {
    const ps = "    1     0   100\n   10     1  1024\n   11    10  2048\n   12     1  9999\n";
    expect(await sysinfo.treeRss(10, fake({ platform: "darwin", cmds: { "ps -A -o pid=,ppid=,rss=": ps } }))).toBe(3072 * 1024);
    expect(await sysinfo.treeRss(10, fake({ platform: "darwin" }))).toBe(0);
  });

  test("Windows reports 0 without running anything", async () => {
    expect(await sysinfo.treeRss(10, fake({ platform: "win32" }))).toBe(0); // nothing answered
    const win = fake({ platform: "win32", cmds: { [`powershell.exe -NoProfile -NonInteractive -Command ${"Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, [math]::Round($_.WorkingSetSize / 1024) }"}`]: "4 0 100\n10 4 2048\n11 10 1024\n12 4 9999\n" } });
    expect(await sysinfo.treeRss(10, win)).toBe((2048 + 1024) * 1024);
  });

  test("this process has resident memory", async () => {
    expect(await sysinfo.treeRss(process.pid)).toBeGreaterThan(0);
  });
});

describe("is a program running", () => {
  test("pgrep on Linux and macOS", async () => {
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "darwin", cmds: { "pgrep -x tracemaker": "4242\n" } }))).toBe(true);
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "darwin", cmds: { "pgrep -x tracemaker": null } }))).toBe(false);
    // macOS: pgrep misses a full-path command name; ps comm by base name finds it
    expect(await sysinfo.processRunning("bun", fake({ platform: "darwin", cmds: { "pgrep -x bun": null, "ps -A -o comm=": "/sbin/launchd\n/Users/runner/.bun/bin/bun\n" } }))).toBe(true);
    expect(await sysinfo.processRunning("bun", fake({ platform: "darwin", cmds: { "pgrep -x bun": null, "ps -A -o comm=": "/sbin/launchd\nbunx\n" } }))).toBe(false);
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "linux", cmds: { "pgrep -x tracemaker": null } }))).toBe(false);
  });

  test("Linux without pgrep reads /proc/<pid>/comm", async () => {
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "linux", files: { "/proc/7/comm": "bash\n", "/proc/9/comm": "tracemaker\n" } }))).toBe(true);
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "linux", files: { "/proc/7/comm": "bash\n" } }))).toBe(false);
  });

  test("tasklist on Windows", async () => {
    const q = 'tasklist /FI IMAGENAME eq tracemaker.exe /NH /FO CSV';
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "win32", cmds: { [q]: '"TraceMaker.exe","5120","Console","1","11,532,104 K"\r\n' } }))).toBe(true);
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "win32", cmds: { [q]: "INFO: No tasks are running which match the specified criteria.\r\n" } }))).toBe(false);
    expect(await sysinfo.processRunning("tracemaker", fake({ platform: "win32" }))).toBe(false);
  });
});

describe("low-priority runs", () => {
  test("nice where it exists, the priority API elsewhere", () => {
    expect(layout.lowPriority(["krt", "-x"], { platform: "linux", nice: "/usr/bin/nice" })).toEqual({ argv: ["/usr/bin/nice", "-n", "5", "krt", "-x"], setPriority: null });
    expect(layout.lowPriority(["krt"], { platform: "darwin", nice: null })).toEqual({ argv: ["krt"], setPriority: 5 });
    expect(layout.lowPriority(["krt.exe"], { platform: "win32", nice: "/usr/bin/nice" })).toEqual({ argv: ["krt.exe"], setPriority: 10 });
  });

  test("nodeRun runs a command and keeps its output on this machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "noderun-"));
    const log = join(dir, "log.txt");
    const r = await layout.nodeRun(["sh", "-c", "echo hello; exit 3"], { log });
    expect(r.code).toBe(3);
    expect(await readFile(log, "utf8")).toContain("hello");
  });
});
