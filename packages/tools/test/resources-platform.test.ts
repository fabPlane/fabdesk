import { describe, expect, test } from "bun:test";
import { sysinfo } from "@fabdesk/board-workflow";
import { ResourceGovernor, sampleHost, type HostSample, type SampleDeps } from "../src/resources";

const GiB = 1024 ** 3;
const disk = async () => ({ bavail: 200 * (GiB / 4096), bsize: 4096, blocks: 500 * (GiB / 4096) });

/** A host as `sampleHost` sees it on each platform, built from the same sysinfo readers with a fake OS underneath. */
const platforms: Record<string, SampleDeps> = {
  macOS: {
    memory: () =>
      sysinfo.hostMemory({
        platform: "darwin",
        run: (cmd) => (cmd === "vm_stat" ? { code: 0, stdout: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  4000.\nPages wired down:  100000.\nAnonymous pages:  300000.\nPages purgeable:  0.\nPages occupied by compressor:  100000.\n" } : null),
        freemem: () => 4000 * 16384,
        totalmem: () => 16 * GiB,
      }),
    loadavg: () => [2.5, 2, 1],
    cpus: () => 10,
    statfs: disk,
  },
  Windows: {
    memory: () => sysinfo.hostMemory({ platform: "win32", freemem: () => 9 * GiB, totalmem: () => 16 * GiB }),
    loadavg: () => [0, 0, 0],
    cpus: () => 8,
    statfs: disk,
  },
  "no data": {
    memory: async () => {
      throw new Error("nothing readable");
    },
    loadavg: () => [],
    cpus: () => 1,
    statfs: async () => null,
  },
};

describe("sampleHost on each platform", () => {
  test("macOS: vm_stat memory (not the 62 MB free list), load and disk", async () => {
    const h = await sampleHost(["/data"], platforms["macOS"]!);
    expect(h.memAvailableGiB).toBe(8.37); // 16 GiB - (300000 + 100000 + 100000) pages of 16 KiB
    expect(h.memTotalGiB).toBe(16);
    expect(h.load1).toBe(2.5);
    expect(h.disk).toEqual([{ path: "/data", freeGiB: 200, totalGiB: 500, freeShare: 0.4 }]);
  });

  test("Windows: os.freemem memory, load average 0", async () => {
    const h = await sampleHost(["C:\\\\boards"], platforms["Windows"]!);
    expect(h).toMatchObject({ memAvailableGiB: 9, memTotalGiB: 16, swapUsedGiB: 0, load1: 0, cpus: 8 });
  });

  test("a host with nothing readable gives zeros instead of throwing", async () => {
    expect(await sampleHost(["/x"], platforms["no data"]!)).toEqual({ memTotalGiB: 0, memAvailableGiB: 0, swapUsedGiB: 0, load1: 0, cpus: 1, disk: [] });
  });

  test("this machine", async () => {
    const h = await sampleHost([process.cwd()]);
    expect(h.memAvailableGiB).toBeGreaterThan(0);
    expect(h.disk).toHaveLength(1);
  });
});

describe("governor liveness", () => {
  const fixed = (memAvailableGiB: number): HostSample => ({ memTotalGiB: 8, memAvailableGiB, swapUsedGiB: 0, load1: 0, cpus: 4, disk: [] });

  for (const cls of ["light", "router", "tracemaker"] as const)
    test(`a ${cls} job that does not fit, with nothing else running, starts with a note`, async () => {
      const g = new ResourceGovernor(async () => fixed(0));
      const notes: string[] = [];
      const job = await g.admit({ cls, label: cls, paths: [], pollMs: 10, onWait: (w) => notes.push(w) });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("memory is short");
      expect(notes[0]).toContain("starting anyway");
      job.release();
      expect(g.running.size).toBe(0);
    });

  test("on a no-data host every heavy tool still runs, one after another", async () => {
    const g = new ResourceGovernor((paths) => sampleHost(paths, platforms["no data"]!));
    const a = await g.admit({ cls: "router", label: "a", paths: ["/x"], pollMs: 10 });
    a.release();
    const b = await g.admit({ cls: "light", label: "b", paths: ["/x"], pollMs: 10 });
    b.release();
  });

  test("one that does not fit while another job runs waits until that job releases", async () => {
    const g = new ResourceGovernor(async () => fixed(4));
    const first = await g.admit({ cls: "router", label: "first", paths: [], pollMs: 10 });
    const waits: string[] = [];
    let admitted = false;
    const second = g.admit({ cls: "router", label: "second", paths: [], pollMs: 10, onWait: (w) => waits.push(w) }).then((j) => ((admitted = true), j));
    await new Promise((r) => setTimeout(r, 40));
    expect(admitted).toBe(false);
    expect(waits[0]).toContain("waiting for memory");
    expect(waits[0]).toContain("1 board job(s) running");
    first.release();
    const j = await second;
    expect(j.label).toBe("second");
    j.release();
  });

  test("exclusivity still holds when memory is short: the second TraceMaker waits", async () => {
    const g = new ResourceGovernor(async () => fixed(0));
    const first = await g.admit({ cls: "tracemaker", label: "tm1", paths: [], pollMs: 10 });
    const waits: string[] = [];
    const second = g.admit({ cls: "tracemaker", label: "tm2", paths: [], pollMs: 10, onWait: (w) => waits.push(w) });
    await new Promise((r) => setTimeout(r, 30));
    expect(waits[0]).toContain("one tracemaker job at a time");
    first.release();
    (await second).release();
  });

  test("the disk check is unchanged: low disk is refused even with nothing running", async () => {
    const g = new ResourceGovernor(async () => ({ ...fixed(0), disk: [{ path: "/", freeGiB: 2, totalGiB: 500, freeShare: 0.004 }] }));
    await expect(g.admit({ cls: "router", label: "r", paths: ["/"] })).rejects.toThrow(/reproducible copies/);
  });
});
