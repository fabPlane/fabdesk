import { describe, expect, test } from "bun:test";
import { isCoreReady } from "./core-info";

describe("isCoreReady", () => {
  test("requires ready state plus address and token", () => {
    expect(isCoreReady({ url: "http://127.0.0.1:1", token: "t", status: { state: "ready" } })).toBe(true);
    expect(isCoreReady({ url: "http://127.0.0.1:1", token: "t", status: { state: "starting" } })).toBe(false);
    expect(isCoreReady({ url: null, token: null, status: { state: "ready" } })).toBe(false);
    expect(isCoreReady(null)).toBe(false);
  });
});
