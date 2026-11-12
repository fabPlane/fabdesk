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
    const g = new ResourceGovernor(async () => host(2.5));
    const ac = new AbortController();
    const waits: string[] = [];
    const j = g.admit({ cls: "light", label: "big", paths: ["/"], memGiB: 3, pollMs: 10, signal: ac.signal, onWait: (w) => waits.push(w) });
    await new Promise((r) => setTimeout(r, 30));
    expect(waits[0]).toContain("waiting for memory");
    ac.abort();
    await expect(j).rejects.toThrow(/cancelled/);
  });
});
