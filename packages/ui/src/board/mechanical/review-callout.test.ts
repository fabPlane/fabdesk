import { expect, test } from "bun:test";
import { placeReviewCallout, type ReviewRect } from "./review-callout";

test("the leader joins the exact projected part to the visible label border", () => {
  const target = { x: 500.25, y: 300.75 };
  const result = placeReviewCallout({
    target,
    viewport: { width: 1000, height: 600 },
    label: { width: 220, height: 44 },
  })!;
  expect(result.target).toEqual(target);
  expect(result.target).not.toBe(target);
  expect(result.label).toEqual({ x: 524.25, y: 278.75, width: 220, height: 44 });
  expect(result.anchor).toEqual({ x: 524.25, y: 300.75 });
  expect(target).toEqual({ x: 500.25, y: 300.75 });
});

test("clamping at every viewport edge moves the label without inventing a new target", () => {
  for (const [width, height] of [
    [1000, 600],
    [600, 300],
    [320, 240],
  ])
    for (const target of [
      { x: 0, y: 0 },
      { x: width!, y: 0 },
      { x: 0, y: height! },
      { x: width!, y: height! },
      { x: width! - 4, y: height! / 2 },
      { x: width! / 2, y: 3 },
    ]) {
      const result = placeReviewCallout({
        target,
        viewport: { width: width!, height: height! },
        label: { width: 220, height: 44 },
      });
      expect(result).not.toBeNull();
      const { label, anchor } = result!;
      expect(result!.target).toEqual(target);
      expect(label.x).toBeGreaterThanOrEqual(12);
      expect(label.y).toBeGreaterThanOrEqual(12);
      expect(label.x + label.width).toBeLessThanOrEqual(width! - 12);
      expect(label.y + label.height).toBeLessThanOrEqual(height! - 12);
      expect(anchor.x).toBeGreaterThanOrEqual(label.x);
      expect(anchor.x).toBeLessThanOrEqual(label.x + label.width);
      expect(anchor.y).toBeGreaterThanOrEqual(label.y);
      expect(anchor.y).toBeLessThanOrEqual(label.y + label.height);
      expect(
        anchor.x === label.x ||
          anchor.x === label.x + label.width ||
          anchor.y === label.y ||
          anchor.y === label.y + label.height,
      ).toBe(true);
    }
});

test("the generator and review panel reserve space for both the label and leader", () => {
  const obstacles: ReviewRect[] = [
    { x: 0, y: 0, width: 300, height: 560 },
    { x: 760, y: 0, width: 240, height: 480 },
  ];
  const result = placeReviewCallout({
    target: { x: 650, y: 320 },
    viewport: { width: 1000, height: 600 },
    label: { width: 220, height: 44 },
    obstacles,
  })!;
  expect(result.label.x).toBeGreaterThanOrEqual(312);
  expect(result.label.x + result.label.width).toBeLessThanOrEqual(748);
  expect(result.label.x + result.label.width).toBeLessThan(result.target.x);
  expect(result.anchor).toEqual({ x: 626, y: 320 });
  for (let part = 0; part <= 100; part++) {
    const x = result.target.x + ((result.anchor.x - result.target.x) * part) / 100;
    const y = result.target.y + ((result.anchor.y - result.target.y) * part) / 100;
    for (const rect of obstacles)
      expect(x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height).toBe(
        false,
      );
  }
});

test("a label above an intervening control does not point through that control", () => {
  const obstacle = { x: 200, y: 200, width: 300, height: 200 };
  const result = placeReviewCallout({
    target: { x: 100, y: 300 },
    viewport: { width: 1000, height: 600 },
    label: { width: 220, height: 44 },
    obstacles: [obstacle],
  })!;
  expect(result).not.toBeNull();
  expect(result.anchor.x).toBeLessThan(obstacle.x);
  expect(result.target).toEqual({ x: 100, y: 300 });
  expect(result.label.y + result.label.height <= obstacle.y - 12 || result.label.y >= 412).toBe(
    true,
  );
});

test("covered, offscreen and crowded targets are hidden instead of pointing at a different part", () => {
  const input = {
    target: { x: 650, y: 320 },
    viewport: { width: 1000, height: 600 },
    label: { width: 220, height: 44 },
  };
  expect(
    placeReviewCallout({ ...input, obstacles: [{ x: 600, y: 280, width: 100, height: 100 }] }),
  ).toBeNull();
  for (const target of [
    { x: -1, y: 300 },
    { x: 1001, y: 300 },
    { x: 500, y: 601 },
  ])
    expect(placeReviewCallout({ ...input, target })).toBeNull();
  expect(
    placeReviewCallout({
      ...input,
      viewport: { width: 200, height: 200 },
      target: { x: 100, y: 100 },
    }),
  ).toBeNull();
  expect(
    placeReviewCallout({
      ...input,
      obstacles: [
        { x: 0, y: 0, width: 600, height: 600 },
        { x: 700, y: 0, width: 300, height: 600 },
      ],
    }),
  ).toBeNull();
});

test("invalid transient measurements do not leak nonfinite SVG positions", () => {
  const input = {
    target: { x: 500, y: 300 },
    viewport: { width: 1000, height: 600 },
    label: { width: 220, height: 44 },
  };
  expect(placeReviewCallout({ ...input, target: { x: NaN, y: 300 } })).toBeNull();
  expect(placeReviewCallout({ ...input, viewport: { width: Infinity, height: 600 } })).toBeNull();
  expect(placeReviewCallout({ ...input, label: { width: 0, height: 0 } })).toBeNull();
  expect(placeReviewCallout({ ...input, margin: -1 })).toBeNull();
  expect(placeReviewCallout({ ...input, gap: -1 })).toBeNull();
  expect(
    placeReviewCallout({
      ...input,
      obstacles: [
        { x: NaN, y: 0, width: 20, height: 20 },
        { x: 500, y: 300, width: 0, height: 10 },
      ],
    }),
  ).toEqual(placeReviewCallout(input));
});
