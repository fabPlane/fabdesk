import { expect, test } from "bun:test";
import { solidKernel } from "@fabdesk/kicad/enclosure-solid";
import { sampleVerticalAssembly } from "../src/tools/enclosure-assembly";

test("a clear final position can still have an obstructed straight assembly path", async () => {
  const k = await solidKernel();
  const board = k.Manifold.cube([10, 10, 1]);
  const bar = k.Manifold.cube([10, 2, 1]);
  const overhead = bar.translate([0, 4, 3]);
  const finalHit = board.intersect(overhead);
  try {
    expect(finalHit.volume()).toBe(0);
    const result = sampleVerticalAssembly(board, [{ path: "fixed crossbar", solid: overhead }]);
    expect(result.obstruction?.path).toBe("fixed crossbar");
    expect(result.obstruction!.offset).toBeGreaterThan(0);
    expect(result.obstruction!.volume).toBeGreaterThan(0.01);
    expect(result.samplesTested).toBeLessThanOrEqual(12);
    expect(board.boundingBox().min[2]).toBe(0);
  } finally {
    finalHit.delete();
    overhead.delete();
    bar.delete();
    board.delete();
  }
});

test("clear paths are reported as bounded samples and cancellation stops the check", async () => {
  const k = await solidKernel();
  const board = k.Manifold.cube([10, 10, 1]);
  const block = k.Manifold.cube([2, 2, 5]);
  const side = block.translate([20, 0, 0]);
  try {
    const result = sampleVerticalAssembly(board, [{ path: "side", solid: side }]);
    expect(result.obstruction).toBeNull();
    expect(result.samplesTested).toBe(12);
    expect(result.distance).toBe(6);
    expect(() => sampleVerticalAssembly(board, [], AbortSignal.abort())).toThrow();
  } finally {
    side.delete();
    block.delete();
    board.delete();
  }
});
