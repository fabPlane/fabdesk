import { describe, expect, test } from "bun:test";
import { emptyAabb, expandAabb, lookAt, mergeAabb, vec3 } from "../src/math";

describe("aabb merge", () => {
  test("merging an empty box with a real box keeps finite bounds", () => {
    const a = emptyAabb();
    const b = emptyAabb();
    expandAabb(b, vec3(-10, -1, -4));
    expandAabb(b, vec3(10, 2, 4));
    const merged = mergeAabb(a, b);
    expect(merged.min.x).toBe(-10);
    expect(merged.max.x).toBe(10);
    expect(Number.isFinite(merged.min.y)).toBe(true);
    expect(Number.isFinite(merged.max.z)).toBe(true);
  });
});

describe("lookAt", () => {
  test("stays finite when looking straight down the up axis", () => {
    const m = lookAt(vec3(0, 10, 0), vec3(0, 0, 0), vec3(0, 1, 0));
    expect([...m].every((n) => Number.isFinite(n))).toBe(true);
  });
});
