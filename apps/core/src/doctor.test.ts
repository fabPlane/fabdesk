import { describe, expect, test } from "bun:test";
import { isUnsupportedFpPcbKicad } from "./doctor";

describe("isUnsupportedFpPcbKicad", () => {
  test("rejects stock releases older than the 10.99 fork baseline", () => {
    expect(isUnsupportedFpPcbKicad("9.0.6")).toBe(true);
    expect(isUnsupportedFpPcbKicad("10.0.4")).toBe(true);
    expect(isUnsupportedFpPcbKicad("10.98.9-12-gabc")).toBe(true);
  });

  test("accepts the fork baseline and later versions", () => {
    expect(isUnsupportedFpPcbKicad("10.99.0-3763-gf0420b49e1")).toBe(false);
    expect(isUnsupportedFpPcbKicad("11.0.0")).toBe(false);
  });

  test("does not invent an ordering for an unrecognised version string", () => {
    expect(isUnsupportedFpPcbKicad("nightly")).toBe(false);
  });
});
