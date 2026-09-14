import { describe, expect, test } from "bun:test";
import { fabplaneApiOrigin } from "./api-origin";

describe("fabplaneApiOrigin", () => {
  test("defaults to production", () => {
    expect(fabplaneApiOrigin({})).toBe("https://api.fabplane.com");
  });

  test("strips a trailing slash on the override", () => {
    expect(fabplaneApiOrigin({ EXPO_PUBLIC_FABPLANE_API_ORIGIN: "http://10.0.2.2:4077/" })).toBe(
      "http://10.0.2.2:4077",
    );
  });
});
