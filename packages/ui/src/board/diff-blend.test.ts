import { expect, test } from "bun:test";
import { blendDiffOverlay } from "./diff-blend";

const svg = '<svg viewBox="0 0 100 80"><g class="board-diff-removed" opacity="0.55"><path opacity="0.2"/></g><g class="board-diff-added" opacity="0.55"/></svg>';

test("blend reveals each revision at the endpoints and both in the middle", () => {
  for (const [percent, before, after] of [[0, 1, 0], [50, 0.5, 0.5], [100, 0, 1]]) {
    const result = blendDiffOverlay(svg, percent!);
    expect(result).toContain(`class="board-diff-removed" opacity="${before}"`);
    expect(result).toContain(`class="board-diff-added" opacity="${after}"`);
    expect(result).toContain('viewBox="0 0 100 80"');
    expect(result).toContain('<path opacity="0.2"/>');
  }
});

test("invalid blend values are bounded or default to both", () => {
  expect(blendDiffOverlay(svg, -10)).toBe(blendDiffOverlay(svg, 0));
  expect(blendDiffOverlay(svg, 150)).toBe(blendDiffOverlay(svg, 100));
  expect(blendDiffOverlay(svg, NaN)).toBe(blendDiffOverlay(svg, 50));
});
