import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardMemGiB, ResourceGovernor, type HostSample } from "../src/resources";

const host = (memAvailableGiB: number, freeGiB = 100): HostSample => ({
  memTotalGiB: 30, memAvailableGiB, swapUsedGiB: 0, load1: 1, cpus: 8,
  disk: [{ path: "/", freeGiB, totalGiB: 500, freeShare: freeGiB / 500 }],
});

describe("resource governor", () => {
  test("a job estimated above the machine's total memory is refused, not started", async () => {
    const g = new ResourceGovernor(async () => host(25));
    await expect(g.admit({ cls: "router", label: "lastmile krt", paths: ["/"], pollMs: 10, memGiB: 40 })).rejects.toThrow(/needs about 40 GiB .* 30 GiB in all/);
    const ok = await g.admit({ cls: "router", label: "fits", paths: ["/"], pollMs: 10, memGiB: 18 });
    ok.release();
  });

  test("a router job that fits the machine but not the memory available now is refused, not started", async () => {
    const g = new ResourceGovernor(async () => host(10));
    await expect(g.admit({ cls: "router", label: "lastmile krt", paths: ["/"], pollMs: 10, memGiB: 17.8 })).rejects.toThrow(/only 10 GiB is available now/);
    // a light job keeps the liveness rule: nothing else runs, so it starts with a note
    const notes: string[] = [];
    const light = await g.admit({ cls: "light", label: "edit", paths: ["/"], pollMs: 10, memGiB: 12, onWait: (w) => notes.push(w) });
    expect(notes[0]).toContain("starting anyway");
    light.release();
  });

  test("a plan-dependent peak reserves but never refuses: only the grid term (hardGiB) can (16 GB laptop, jetson)", async () => {
    const laptop = (avail: number): HostSample => ({ ...host(avail), memTotalGiB: 15 });
    const g = new ResourceGovernor(async () => laptop(10));
    const notes: string[] = [];
    const run = await g.admit({ cls: "router", label: "lastmile krt", paths: ["/"], pollMs: 10, memGiB: 14.6, hardGiB: 7.5, onWait: (w) => notes.push(w) });
    expect(notes[0]).toContain("starting anyway");
    run.release();
    await expect(g.admit({ cls: "router", label: "lastmile krt", paths: ["/"], pollMs: 10, memGiB: 14.6, hardGiB: 12 })).rejects.toThrow(/only 10 GiB is available now/);
    await expect(g.admit({ cls: "router", label: "lastmile krt", paths: ["/"], pollMs: 10, memGiB: 20, hardGiB: 18 })).rejects.toThrow(/15 GiB in all/);
  });

  test("parallel router jobs whose estimates do not fit together run one after another", async () => {
    const g = new ResourceGovernor(async () => host(24));
    const a = await g.admit({ cls: "router", label: "a", paths: ["/"], pollMs: 10, memGiB: 18.6 });
    const waits: string[] = [];
    const second = g.admit({ cls: "router", label: "b", paths: ["/"], pollMs: 10, memGiB: 18.6, onWait: (w) => waits.push(w) });
    await new Promise((r) => setTimeout(r, 30));
    expect(waits[0]).toContain("waiting for memory");
    a.release();
    (await second).release();
  });

  test("TraceMaker jobs run one at a time; the second waits and then runs", async () => {
    const g = new ResourceGovernor(async () => host(25));
    const first = await g.admit({ cls: "tracemaker", label: "a", paths: ["/"], pollMs: 10 });
    const waits: string[] = [];
    const second = g.admit({ cls: "tracemaker", label: "b", paths: ["/"], pollMs: 10, onWait: (w) => waits.push(w) });
    await new Promise((r) => setTimeout(r, 30));
    expect(waits[0]).toContain("one tracemaker job at a time");
    first.release();
    const b = await second;
    expect(b.label).toBe("b");
    b.release();
  });

  test("memory admission counts what admitted jobs have not claimed yet", async () => {
    const g = new ResourceGovernor(async () => host(14));
    const tm = await g.admit({ cls: "tracemaker", label: "tm", paths: ["/"], pollMs: 10 });
    const waits: string[] = [];
    const ac = new AbortController();
    const router = g.admit({ cls: "router", label: "r", paths: ["/"], pollMs: 10, signal: ac.signal, onWait: (w) => waits.push(w) });
    await new Promise((r) => setTimeout(r, 30));
    expect(waits[0]).toContain("waiting for memory");
    ac.abort();
    await expect(router).rejects.toThrow(/cancelled/);
    tm.release();
  });

  test("low disk is refused with a proposal instead of waited on", async () => {
    const g = new ResourceGovernor(async () => host(25, 4));
    await expect(g.admit({ cls: "router", label: "r", paths: ["/"] })).rejects.toThrow(/reproducible copies/);
  });

  test("board size scales the memory a job asks for (0.06 GiB per MB)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bm-"));
    await writeFile(join(dir, "a.kicad_pcb"), Buffer.alloc(50_000_000));
    expect(await boardMemGiB([join(dir, "a.kicad_pcb")])).toBe(3);
    expect(await boardMemGiB([dir])).toBe(3);
    expect(await boardMemGiB(["relative", join(dir, "none")])).toBe(0);
    // a big board's light job waits for memory while another board job holds it
    const g = new ResourceGovernor(async () => host(2.5));
    const other = await g.admit({ cls: "light", label: "other", paths: ["/"] });
    const ac = new AbortController();
    const waits: string[] = [];
    const j = g.admit({ cls: "light", label: "big", paths: ["/"], memGiB: 3, pollMs: 10, signal: ac.signal, onWait: (w) => waits.push(w) });
    await new Promise((r) => setTimeout(r, 30));
    expect(waits[0]).toContain("waiting for memory");
    ac.abort();
    await expect(j).rejects.toThrow(/cancelled/);
    other.release();
  });
});
