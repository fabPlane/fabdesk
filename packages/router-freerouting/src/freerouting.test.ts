import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { RouterWorkerMessage, type RouteRequest } from "@fabdesk/protocol";
import { FIXTURE_CONNECTIONS, fixtureSrj } from "@fabdesk/router/testing";
import type { RouterAdapter } from "@fabdesk/router";

const VENDOR_PRESENT = existsSync(
  new URL("../../../vendor/js_autorouter/src/index.ts", import.meta.url),
);

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    router: "freerouting",
    srj: fixtureSrj(),
    timeoutMs: 20_000,
    minFrameIntervalMs: 0,
    ...overrides,
  };
}

// The adapter is imported lazily so a checkout without the submodule skips instead of failing to load.
async function adapter(): Promise<RouterAdapter> {
  const mod = await import("./freerouting-adapter");
  return new mod.FreeroutingAdapter();
}

describe.skipIf(!VENDOR_PRESENT)("freerouting adapter", () => {
  test("probe reports the vendored router", async () => {
    const probe = await (await adapter()).probe();
    expect(probe).toMatchObject({ id: "freerouting", present: true, ready: true });
  });

  test("routes the fixture and forwards js_autorouter's cinema frames", async () => {
    const messages: RouterWorkerMessage[] = [];
    const req = request();
    const result = await (await adapter()).route(req, { onMessage: (m) => messages.push(m) });

    for (const message of messages) {
      expect(RouterWorkerMessage.parse(message)).toBeDefined();
    }
    const kinds = messages.map((m) => m.kind);
    expect(kinds[0]).toBe("meta");
    expect(kinds[1]).toBe("static");
    expect(kinds.filter((k) => k === "frame").length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === "result").length).toBe(1);
    expect(kinds[kinds.length - 1]).toBe("result");

    const meta = messages[0];
    if (meta?.kind !== "meta") throw new Error("no meta");
    expect(meta.runId).toBe(req.runId);
    expect(meta.router).toBe("freerouting");
    expect(meta.unitsPerMm).toBe(10_000);
    expect(meta.layers).toEqual(["top", "bottom"]);
    // Board units: the 20 mm window plus the importer's bookkeeping margin.
    expect(meta.bounds.x2 - meta.bounds.x1).toBeGreaterThanOrEqual(20 * 10_000);

    const statics = messages[1];
    if (statics?.kind !== "static") throw new Error("no static");
    expect(statics.shapes.length).toBeGreaterThan(0);

    const frames = messages.filter((m) => m.kind === "frame");
    expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
    expect(frames[0]?.event.kind).toBe("pass-start");
    const last = frames[frames.length - 1];
    expect(last?.event.kind).toBe("done");
    expect(last?.shapes.filter((s) => s.k === "trace").length).toBeGreaterThanOrEqual(4);

    expect(result.router).toBe("freerouting");
    expect(result.timedOut).toBe(false);
    expect([...result.complete].sort()).toEqual(FIXTURE_CONNECTIONS);
    expect(result.open).toEqual([]);
    expect(result.traces.map((t) => t.connection_name).sort()).toEqual(FIXTURE_CONNECTIONS);
    expect(result.detail).toBeUndefined();
    expect(result.stats.frames).toBe(frames.length);
  });

  test("honours onlyConnections", async () => {
    const result = await (
      await adapter()
    ).route(request({ onlyConnections: ["B"] }), { onMessage: () => {} });
    expect(result.complete).toEqual(["B"]);
    expect(result.traces.map((t) => t.connection_name)).toEqual(["B"]);
  });
});
