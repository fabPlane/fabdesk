import { describe, expect, test } from "bun:test";
import {
  effectiveStatus,
  lastSeenLabel,
  orderEnvironments,
  probeDue,
  probeEnvironments,
  statusFromProbe,
  type EnvironmentLike,
  type StatusEntry,
} from "./environments";

const NOW = Date.parse("2026-09-13T12:00:00Z");

function env(
  id: string,
  lastConnectedAt: string | null,
  pairedAt = "2026-09-01T00:00:00Z",
): EnvironmentLike {
  return {
    id,
    baseUrl: `http://${id}:47820`,
    candidates: [`http://${id}:47820`],
    pairedAt,
    lastConnectedAt,
  };
}

const entry = (status: StatusEntry["status"], checkedAt: number | null = NOW): StatusEntry => ({
  status,
  checkedAt,
  baseUrl: status === "reachable" ? "http://x" : null,
});

describe("statusFromProbe", () => {
  test("an answering address is reachable and remembered", () => {
    expect(statusFromProbe("http://100.64.0.1:47820", NOW)).toEqual({
      status: "reachable",
      checkedAt: NOW,
      baseUrl: "http://100.64.0.1:47820",
    });
  });

  test("no answer is offline", () => {
    expect(statusFromProbe(null, NOW)).toEqual({
      status: "offline",
      checkedAt: NOW,
      baseUrl: null,
    });
  });
});

describe("probeDue", () => {
  test("nothing to probe when there are no computers", () => {
    expect(probeDue({}, [], NOW)).toBe(false);
  });

  test("a never-checked computer is due", () => {
    expect(probeDue({}, ["a"], NOW)).toBe(true);
  });

  test("a fresh snapshot is not re-probed, a stale one is", () => {
    const statuses = { a: entry("reachable", NOW - 2_000), b: entry("offline", NOW - 2_000) };
    expect(probeDue(statuses, ["a", "b"], NOW)).toBe(false);
    expect(probeDue({ ...statuses, b: entry("offline", NOW - 30_000) }, ["a", "b"], NOW)).toBe(
      true,
    );
  });
});

describe("probeEnvironments", () => {
  test("probes every computer in parallel and keys the result by id", async () => {
    let inFlight = 0;
    let peak = 0;
    const prober = async (e: EnvironmentLike) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return e.id === "up" ? e.baseUrl : null;
    };
    const result = await probeEnvironments([env("up", null), env("down", null)], prober, () => NOW);
    expect(peak).toBe(2);
    expect(result).toEqual({
      up: { status: "reachable", checkedAt: NOW, baseUrl: "http://up:47820" },
      down: { status: "offline", checkedAt: NOW, baseUrl: null },
    });
  });

  test("a prober that throws counts as offline rather than failing the round", async () => {
    const result = await probeEnvironments(
      [env("a", null)],
      async () => {
        throw new Error("boom");
      },
      () => NOW,
    );
    expect(result.a?.status).toBe("offline");
  });
});

describe("effectiveStatus", () => {
  test("an open stream beats a stale offline probe", () => {
    expect(effectiveStatus(entry("offline"), { streamOpen: true, unreachable: false })).toBe(
      "reachable",
    );
  });

  test("a failed locate beats a stale reachable probe", () => {
    expect(effectiveStatus(entry("reachable"), { streamOpen: false, unreachable: true })).toBe(
      "offline",
    );
  });

  test("while connecting, the probe decides; nothing known is unknown", () => {
    expect(effectiveStatus(entry("reachable"), { streamOpen: false, unreachable: false })).toBe(
      "reachable",
    );
    expect(effectiveStatus(undefined, { streamOpen: false, unreachable: false })).toBe("unknown");
    expect(effectiveStatus(undefined, null)).toBe("unknown");
  });
});

describe("orderEnvironments", () => {
  const statuses: Record<string, StatusEntry["status"]> = {
    active: "offline",
    up1: "reachable",
    up2: "reachable",
    down: "offline",
    unknown: "unknown",
  };
  const statusOf = (id: string) => statuses[id] ?? "unknown";

  test("active first, then reachable, then by last seen", () => {
    const list = [
      env("down", "2026-09-13T11:00:00Z"),
      env("up1", "2026-09-10T00:00:00Z"),
      env("unknown", "2026-09-12T00:00:00Z"),
      env("active", null),
      env("up2", "2026-09-12T00:00:00Z"),
    ];
    expect(orderEnvironments(list, "active", statusOf).map((e) => e.id)).toEqual([
      "active",
      "up2",
      "up1",
      "unknown",
      "down",
    ]);
  });

  test("never-connected computers come last within a status, newest pairing first", () => {
    const list = [
      env("a", null, "2026-09-01T00:00:00Z"),
      env("b", null, "2026-09-05T00:00:00Z"),
      env("c", "2026-08-01T00:00:00Z"),
    ];
    expect(orderEnvironments(list, null, () => "unknown").map((e) => e.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  test("is stable for equal keys and does not mutate the input", () => {
    const list = [env("a", null), env("b", null)];
    const copy = [...list];
    expect(orderEnvironments(list, null, () => "unknown").map((e) => e.id)).toEqual(["a", "b"]);
    expect(list).toEqual(copy);
  });
});

describe("lastSeenLabel", () => {
  test("never connected and never reachable", () => {
    expect(lastSeenLabel({ lastConnectedAt: null }, undefined, NOW)).toBe("never connected");
    expect(lastSeenLabel({ lastConnectedAt: null }, entry("offline"), NOW)).toBe("never connected");
  });

  test("uses the connection time when that is the latest", () => {
    const e = { lastConnectedAt: new Date(NOW - 5 * 60_000).toISOString() };
    expect(lastSeenLabel(e, entry("offline", NOW), NOW)).toBe("last seen 5m ago");
  });

  test("a reachable probe counts as seen", () => {
    const e = { lastConnectedAt: new Date(NOW - 3 * 3_600_000).toISOString() };
    expect(lastSeenLabel(e, entry("reachable", NOW - 30_000), NOW)).toBe("last seen just now");
  });
});
