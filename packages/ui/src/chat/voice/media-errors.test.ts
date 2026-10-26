import { describe, expect, test } from "bun:test";
import { classifyMediaError } from "./media-errors";

describe("classifyMediaError", () => {
  test("permission denied stays a permission error", () => {
    const err = new DOMException("Permission denied", "NotAllowedError");
    expect(classifyMediaError(err).type).toBe("permission_denied");
    expect(classifyMediaError(err).message).toMatch(/denied/i);
  });

  test("a missing device is unavailable, not a permission failure", () => {
    expect(classifyMediaError(new DOMException("Requested device not found", "NotFoundError")).type).toBe(
      "unavailable",
    );
  });
});
