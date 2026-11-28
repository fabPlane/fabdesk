import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artToJob, estimateJobSeconds, jobStem, jobView, previewGeometry, readJob, writeJob, type LmcJob } from "./job-file";
import type { Vec } from "./job";

const failure = (p: Promise<unknown>) => p.then(() => "no error", (e: unknown) => String(e));
const square = (x: number, y: number, s: number): Vec[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const settings = { powerPct: 50, speedMmPerS: 100, frequencyKhz: 40, passes: 1, intervalMm: 1, angleDeg: 0, angleStepDeg: 0 };
const job: LmcJob = { boardMm: { width: 10, height: 10 }, ablate: [square(0, 0, 10)], settings };

describe("job files", () => {
  test("an exporter job is read; damaged or empty files get a clear message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfile-"));
    await writeFile(join(dir, "a.lmc.json"), JSON.stringify({ ...job, extra: 1 }));
    expect((await readJob(join(dir, "a.lmc.json"))).boardMm.width).toBe(10);
    await writeFile(join(dir, "b.lmc.json"), "{ nope");
    expect(await failure(readJob(join(dir, "b.lmc.json")))).toMatch(/not a fabPlane laser job/);
    await writeFile(join(dir, "c.lmc.json"), JSON.stringify({ ...job, settings: { ...settings, powerPct: 400 } }));
    expect(await failure(readJob(join(dir, "c.lmc.json")))).toMatch(/settings\.powerPct/);
    await writeFile(join(dir, "d.lmc.json"), JSON.stringify({ ...job, ablate: [] }));
    expect(await failure(readJob(join(dir, "d.lmc.json")))).toMatch(/empty/);
    expect(await failure(readJob(join(dir, "missing.lmc.json")))).toMatch(/does not exist/);
  });

  test("writing is all or nothing and leaves no temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jobfile-"));
    await writeJob(join(dir, "a.lmc.json"), job);
    expect(await readdir(dir)).toEqual(["a.lmc.json"]);
    expect(() => writeJob(join(dir, "a.lmc.json"), { ...job, boardMm: { width: -1, height: 1 } })).toThrow();
  });
});

describe("time estimate", () => {
  test("fill lines at mark speed, serpentine jumps at travel speed, per-line delays", () => {
    // 10 lines of 10 mm at 100 mm/s = 1 s; 9 jumps of 1 mm at 2000 mm/s; 10 × 0.4 ms delays.
    expect(estimateJobSeconds(job)).toBeCloseTo(1 + 9 / 2000 + 10 * 0.0004, 4);
  });

  test("cross-hatch counts both directions, edge passes count the outline", () => {
    const cross = estimateJobSeconds({ ...job, settings: { ...settings, angleStepDeg: 90 } });
    expect(cross).toBeGreaterThan(1.99);
    const withEdge = estimateJobSeconds({ ...job, edge: { powerPct: 50, speedMmPerS: 40, frequencyKhz: 40, passes: 2 } });
    expect(withEdge - estimateJobSeconds(job)).toBeGreaterThan(2 * 40 / 40 - 0.01); // 2 × 40 mm outline at 40 mm/s
  });

  test("lines are marked once per pass", () => {
    const t = estimateJobSeconds({ ablate: [], lines: [[[0, 0], [10, 0]]], settings: { ...settings, passes: 3 } });
    expect(t).toBeCloseTo(3 * (10 / 100 + 0.0004 + 2 * 0.0001), 3); // jumps between passes are left out (a few ms)
  });
});

describe("preview", () => {
  test("a huge outline is simplified to the point budget and keeps its size", () => {
    const circle: Vec[] = Array.from({ length: 100_000 }, (_, i) => [50 + 50 * Math.cos((i / 100_000) * 2 * Math.PI), 50 + 50 * Math.sin((i / 100_000) * 2 * Math.PI)]);
    const p = previewGeometry({ ablate: [circle] }, 2000);
    const pts = p.fills[0]!;
    expect(pts.length).toBeLessThanOrEqual(2000);
    expect(Math.max(...pts.map(q => q[0])) - Math.min(...pts.map(q => q[0]))).toBeGreaterThan(99.9);
  });
});

describe("job view", () => {
  test("a job that does not fit the lens at its position is flagged; the power cap is shown", () => {
    const v = jobView({ ...job, positionMm: { x: 31, y: 0 } }, "x/My-Board-F-Cu.lmc.json", { fieldMm: 70, defaultCenterMm: { x: 0, y: 0 }, maxPowerPct: 20 });
    expect(v.name).toBe("My-Board-F-Cu");
    expect(v.warnings.join(" ")).toMatch(/does not fit the 70 mm lens/);
    expect(v.warnings.join(" ")).toMatch(/capped at 20 %/);
    expect(jobView(job, "j.lmc.json", { fieldMm: 70, defaultCenterMm: { x: 0, y: 0 }, maxPowerPct: 100 }).warnings).toEqual([]);
  });
});

describe("imported drawings", () => {
  const art = { fills: [square(0, 0, 20)], lines: [[[0, 30], [20, 30]] as Vec[]], widthMm: 20, heightMm: 30, warnings: [] };

  test("scaled to a width keeping proportions, moved to 0,0", () => {
    const j = artToJob(art, { widthMm: 10 }, { name: "logo", settings });
    expect(j.boardMm.width).toBeCloseTo(10, 9);
    expect(j.boardMm.height).toBeCloseTo(15, 9);
    expect(Math.min(...j.ablate[0]!.map(p => p[0]))).toBeCloseTo(0, 9);
    expect(j.source).toBe("file");
  });

  test("turned 90° swaps width and height; mirrored flips left and right", () => {
    const turned = artToJob(art, { rotateDeg: 90 }, { name: "logo", settings });
    expect(artToJob(art, { rotateDeg: 90, widthMm: 15 }, { name: "logo", settings }).boardMm.width).toBeCloseTo(15, 9); // size after turning
    expect(turned.boardMm.width).toBeCloseTo(30, 9);
    expect(turned.boardMm.height).toBeCloseTo(20, 9);
    const lineAtTop = artToJob({ ...art, fills: [square(0, 0, 4)], lines: [[[10, 0], [20, 0]]] }, { mirror: true }, { name: "m", settings });
    expect(Math.max(...lineAtTop.lines![0]!.map(p => p[0]))).toBeCloseTo(10, 9); // the line moved to the left half
  });

  test("an empty drawing is refused", () => {
    expect(() => artToJob({ fills: [], lines: [], widthMm: 0, heightMm: 0, warnings: [] }, {}, { name: "x", settings })).toThrow(/nothing to mark/);
  });

  test("file names become safe stems", () => {
    expect(jobStem("C:\\Users\\me\\My Logo (v2).svg")).toBe("My-Logo-v2");
    expect(jobStem("../../etc/passwd")).toBe("passwd");
    expect(jobStem("....svg")).toBe("drawing");
    expect(jobStem("ป้าย ร้าน.svg")).toBe("ป้าย-ร้าน"); // Thai letters and their vowel marks are kept
  });
});
