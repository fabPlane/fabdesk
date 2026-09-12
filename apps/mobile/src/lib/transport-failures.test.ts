import { describe, expect, test } from "bun:test";
import {
  createFailureDeduper,
  transportFailure,
  type ConnectionSnapshot,
} from "./transport-failures";

const snap = (over: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot => ({
  phase: "ready",
  status: "open",
  error: null,
  app: "active",
  ...over,
});

describe("transportFailure", () => {
  test("a failed locate is reported once, with the provider's message", () => {
    const next = snap({ phase: "unreachable", status: "closed", error: "Could not reach Studio" });
    expect(transportFailure(snap({ phase: "locating", status: "closed" }), next)).toEqual({
      key: "unreachable",
      message: "Could not reach Studio",
      level: "warning",
    });
    // Staying unreachable across re-renders is not a new failure.
    expect(transportFailure(next, next)).toBeNull();
  });

  test("a rejected device token is an error", () => {
    const next = snap({ phase: "unauthorized", status: "closed", error: null });
    expect(transportFailure(null, next)).toMatchObject({ key: "unauthorized", level: "error" });
  });

  test("a stream dropping in the foreground is reported; in the background it is not", () => {
    expect(transportFailure(snap(), snap({ status: "reconnecting" }))).toMatchObject({
      key: "stream-dropped",
    });
    expect(transportFailure(snap(), snap({ status: "closed", app: "background" }))).toBeNull();
    expect(transportFailure(snap({ app: "background" }), snap({ status: "closed" }))).toBeNull();
  });

  test("ordinary transitions are silent", () => {
    expect(transportFailure(null, snap({ phase: "locating", status: "closed" }))).toBeNull();
    expect(transportFailure(snap({ status: "connecting" }), snap())).toBeNull();
    expect(
      transportFailure(snap({ status: "reconnecting" }), snap({ status: "closed" })),
    ).toBeNull();
    expect(transportFailure(snap(), snap({ status: "connecting" }))).toBeNull();
  });
});

describe("createFailureDeduper", () => {
  test("repeats of one key inside the window are dropped, other keys are not", () => {
    const d = createFailureDeduper(1000);
    const dropped = { key: "stream-dropped", message: "", level: "warning" } as const;
    const unreachable = { key: "unreachable", message: "", level: "warning" } as const;
    expect(d.shouldReport(dropped, 0)).toBe(true);
    expect(d.shouldReport(dropped, 500)).toBe(false);
    expect(d.shouldReport(unreachable, 500)).toBe(true);
    expect(d.shouldReport(dropped, 1000)).toBe(true);
  });
});
