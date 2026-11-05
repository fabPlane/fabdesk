import { expect, test } from "bun:test";
import { exportEnclosureBoards } from "../src/tools/enclosure-exports";
import { boundsSeparation } from "../src/tools/enclosure-bounds";
import { solidKernel } from "@fabdesk/kicad/enclosure-solid";

test("native export queue is bounded, preserves order and isolates a failed board", async () => {
  let active = 0,
    peak = 0;
  const results = await exportEnclosureBoards([0, 1, 2, 3, 4], async (id) => {
    peak = Math.max(peak, ++active);
    try {
      await new Promise((resolve) => setTimeout(resolve, id === 0 ? 15 : 1));
      if (id === 2) throw new Error("Missing model");
      return id;
    } finally {
      active--;
    }
  });
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(results.map((r) => (r.status === "fulfilled" ? r.value : "failed"))).toEqual([
    0,
    1,
    "failed",
    3,
    4,
  ]);
});

test("aborting drains running exports before cleanup and starts no more boards", async () => {
  const controller = new AbortController();
  let active = 0,
    started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = exportEnclosureBoards(
    [0, 1, 2, 3],
    async () => {
      started++;
      active++;
      await gate;
      active--;
    },
    controller.signal,
  );
  controller.abort();
  expect(active).toBe(2);
  release();
  await expect(pending).rejects.toThrow();
  expect(started).toBe(2);
  expect(active).toBe(0);
});

test("bounds pruning preserves close, touching and intersecting geometry", async () => {
  const k = await solidKernel();
  const cube = k.Manifold.cube([10, 10, 10]);
  try {
    for (const [offset, gap] of [
      [20, 10],
      [10.2, 0.2],
      [10, 0],
      [5, 0],
    ] as const) {
      const other = cube.translate([offset, 0, 0]);
      const hit = cube.intersect(other);
      try {
        const bound = boundsSeparation(cube.boundingBox(), other.boundingBox());
        expect(bound).toBeCloseTo(gap, 6);
        if (bound > 0) expect(hit.volume()).toBe(0);
        if (offset < 10) expect(hit.volume()).toBeGreaterThan(0);
      } finally {
        hit.delete();
        other.delete();
      }
    }
  } finally {
    cube.delete();
  }
});
