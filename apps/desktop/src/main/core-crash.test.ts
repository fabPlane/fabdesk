import { describe, expect, test } from "bun:test";
import { coreExitReason, isTranslocated, StderrTail, STDERR_TAIL_LINES, TRANSLOCATION_HINT, withTranslocationHint } from "./core-crash";

const TRANSLOCATED = "/private/var/folders/dt/tn5_4fyn51l25st2864zs1q80000gn/T/AppTranslocation/803ADAB1-9BF0-4544-914A-FF1E5A487AAF/d/fabPlane.app/Contents/MacOS/fabPlane";

describe("StderrTail", () => {
  test("keeps the last non-empty lines only", () => {
    const tail = new StderrTail();
    expect(tail.last()).toBeNull();
    for (let i = 1; i <= STDERR_TAIL_LINES + 3; i++) tail.push(`line ${i}`);
    tail.push("   ");
    expect(tail.last()).toBe(`line ${STDERR_TAIL_LINES + 3}`);
  });
});

describe("coreExitReason", () => {
  test("bare exit code without stderr", () => {
    expect(coreExitReason(1, null, null)).toBe("core exited (code 1)");
    expect(coreExitReason(null, "SIGKILL", null)).toBe("core exited (code SIGKILL)");
    expect(coreExitReason(null, null, "  ")).toBe("core exited (code ?)");
  });

  test("appends the core's last stderr line", () => {
    expect(coreExitReason(1, null, "SQLiteError: database disk image is malformed")).toBe(
      "core exited (code 1): SQLiteError: database disk image is malformed",
    );
  });

  test("drops the structured-log timestamp", () => {
    expect(coreExitReason(1, null, '2026-09-10T08:57:49.740Z error fatal {"error":"EACCES: permission denied"}')).toBe(
      'core exited (code 1): error fatal {"error":"EACCES: permission denied"}',
    );
  });

  test("truncates a very long line", () => {
    const reason = coreExitReason(1, null, "x".repeat(1000));
    expect(reason.length).toBeLessThan(340);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("translocation", () => {
  test("detects the macOS App Translocation mount", () => {
    expect(isTranslocated(TRANSLOCATED, "darwin")).toBe(true);
    expect(isTranslocated("/Applications/fabPlane.app/Contents/MacOS/fabPlane", "darwin")).toBe(false);
    expect(isTranslocated(TRANSLOCATED, "linux")).toBe(false);
  });

  test("appends the hint only when translocated", () => {
    expect(withTranslocationHint("core exited (code 1)", TRANSLOCATED, "darwin")).toBe(`core exited (code 1)\n${TRANSLOCATION_HINT}`);
    expect(withTranslocationHint("core exited (code 1)", "/Applications/fabPlane.app/Contents/MacOS/fabPlane", "darwin")).toBe("core exited (code 1)");
  });
});
