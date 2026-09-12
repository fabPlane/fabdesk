import { describe, expect, test } from "bun:test";
import { formatBytes, formatDuration, relativeTime } from "./format";

const NOW = Date.parse("2026-03-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("relativeTime", () => {
  test("counts up through the units", () => {
    expect(relativeTime(ago(5_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe("2d ago");
  });

  test("falls back to a date past a week, and never shows a negative age", () => {
    expect(relativeTime(ago(30 * 86_400_000), NOW)).not.toContain("ago");
    // Clock skew between the phone and the desktop must not produce "-3m ago".
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });

  test("survives a timestamp it cannot parse", () => {
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});

test("formatBytes picks a readable unit", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(2048)).toBe("2 KB");
  expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
});

test("formatDuration switches to minutes with padded seconds", () => {
  expect(formatDuration(45_000)).toBe("45s");
  expect(formatDuration(65_000)).toBe("1m 05s");
});
