import { describe, expect, test } from "bun:test";
import { resyncOnStatus } from "./provider";

describe("resyncOnStatus", () => {
  test("the first open is not a resync; an open after having been open is", () => {
    expect(resyncOnStatus(false, "connecting")).toBe(false);
    expect(resyncOnStatus(false, "open")).toBe(false);
    expect(resyncOnStatus(true, "reconnecting")).toBe(false);
    expect(resyncOnStatus(true, "open")).toBe(true);
  });
});
