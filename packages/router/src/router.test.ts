import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { RouterWorkerMessage, type RouteRequest } from "@fabdesk/protocol";

import { CapacityAutorouterAdapter } from "./adapters/capacity";
import { RouterHost } from "./host";
import { availableRouters, loadAdapter } from "./registry";
import { FIXTURE_CONNECTIONS, MULTI_PAD_CONNECTIONS, fixtureSrj, multiPadNetSrj } from "./testing/fixture";
import { RouteAbortedError } from "./types";
import { frameUnitsPerMm } from "./units";

const VENDOR_PRESENT = existsSync(
  new URL("../../../vendor/js_autorouter/src/index.ts", import.meta.url),
);

function request(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    router: "capacity",
    srj: fixtureSrj(),
    timeoutMs: 20_000,
    minFrameIntervalMs: 0,
    ...overrides,
  };
}

function expectWellFormedStream(messages: RouterWorkerMessage[]): void {
  for (const message of messages) {
    expect(RouterWorkerMessage.parse(message)).toBeDefined();
  }
  const kinds = messages.map((m) => m.kind);
  expect(kinds[0]).toBe("meta");
  expect(kinds[1]).toBe("static");
  expect(kinds.filter((k) => k === "frame").length).toBeGreaterThanOrEqual(1);
  expect(kinds.filter((k) => k === "result").length).toBe(1);
  expect(kinds.filter((k) => k === "error").length).toBe(0);
  expect(kinds[kinds.length - 1]).toBe("result");
  const frames = messages.filter((m) => m.kind === "frame");
  expect(frames.map((f) => f.seq)).toEqual(frames.map((_, i) => i + 1));
  expect(frames[frames.length - 1]?.event.kind).toBe("done");
  expect(frames[frames.length - 1]?.shapes.length).toBeGreaterThan(0);
}

describe("capacity adapter (in-process)", () => {
  test("routes the fixture and streams meta, static, frames, result", async () => {
    const messages: RouterWorkerMessage[] = [];
    const req = request();
    const result = await new CapacityAutorouterAdapter().route(req, {
      onMessage: (m) => messages.push(m),
    });
    expectWellFormedStream(messages);
    const meta = messages[0];
    if (meta?.kind !== "meta") throw new Error("no meta");
    expect(meta.unitsPerMm).toBe(1);
    expect(meta.layers).toEqual(["top", "bottom"]);
    const statics = messages[1];
    if (statics?.kind !== "static") throw new Error("no static");
    expect(statics.shapes.filter((s) => s.k === "pad").length).toBe(8);
    expect(statics.shapes.filter((s) => s.k === "keepout").length).toBe(2);

    expect(result.runId).toBe(req.runId);
    expect(result.router).toBe("capacity");
    expect(result.timedOut).toBe(false);
    expect([...result.complete].sort()).toEqual(FIXTURE_CONNECTIONS);
    expect(result.open).toEqual([]);
    expect(result.traces.map((t) => t.connection_name).sort()).toEqual(FIXTURE_CONNECTIONS);
    for (const trace of result.traces) {
      expect(trace.route.length).toBeGreaterThanOrEqual(2);
    }
    expect(result.stats.frames).toBe(messages.filter((m) => m.kind === "frame").length);
    const last = messages[messages.length - 1];
    if (last?.kind !== "result") throw new Error("no result");
    expect(last.result).toEqual(result);
  });

  test("honours onlyConnections", async () => {
    const result = await new CapacityAutorouterAdapter().route(
      request({ onlyConnections: ["A", "D"] }),
      {
        onMessage: () => {},
      },
    );
    expect([...result.complete].sort()).toEqual(["A", "D"]);
    expect(result.traces.length).toBe(2);
  });

  test("multi-pad nets: every merged connection is complete and the stream adds up", async () => {
    const messages: RouterWorkerMessage[] = [];
    const srj = multiPadNetSrj();
    const result = await new CapacityAutorouterAdapter().route(request({ srj }), {
      onMessage: (m) => messages.push(m),
    });
    expectWellFormedStream(messages);
    expect(result.timedOut).toBe(false);
    // The solver names a merged net's traces after one member; the others must not read as open.
    expect(result.traces.length).toBeGreaterThan(srj.connections.length - 2);
    expect(new Set(result.traces.map((t) => t.connection_name)).size).toBeLessThan(srj.connections.length);
    expect([...result.complete].sort()).toEqual(MULTI_PAD_CONNECTIONS);
    expect(result.open).toEqual([]);
    expect(result.complete.length + result.open.length).toBe(srj.connections.length);
    // One `connection` frame per SRJ connection, each attributed to a real net number.
    const frames = messages.filter((m) => m.kind === "frame");
    const announced = frames.filter((f) => f.event.kind === "connection").map((f) => f.event.netNumber);
    expect([...announced].sort()).toEqual(srj.connections.map((_, i) => i));
    for (const frame of frames) {
      for (const shape of frame.shapes) {
        if (shape.k === "trace" || shape.k === "via") expect(shape.net).toBeGreaterThanOrEqual(0);
      }
    }
  }, 30_000);

  test("onlyConnections can route one member of a merged net", async () => {
    const result = await new CapacityAutorouterAdapter().route(
      request({ srj: multiPadNetSrj(), onlyConnections: ["GND_b", "SIG"] }),
      { onMessage: () => {} },
    );
    expect([...result.complete].sort()).toEqual(["GND_b", "SIG"]);
    expect(result.open).toEqual([]);
    // Members that were not requested are neither complete nor open.
    expect(result.complete.length + result.open.length).toBe(2);
  });

  test("an aborted signal stops the step loop", async () => {
    const controller = new AbortController();
    const promise = new CapacityAutorouterAdapter().route(request(), {
      onMessage: (m) => {
        if (m.kind === "frame") controller.abort();
      },
      signal: controller.signal,
    });
    await expect(promise).rejects.toBeInstanceOf(RouteAbortedError);
  });
});

describe("RouterHost (worker)", () => {
  test("routes the fixture through the worker", async () => {
    const host = new RouterHost();
    const messages: RouterWorkerMessage[] = [];
    try {
      const result = await host.route(request(), { onMessage: (m) => messages.push(m) });
      expectWellFormedStream(messages);
      expect([...result.complete].sort()).toEqual(FIXTURE_CONNECTIONS);
      expect(result.open).toEqual([]);
      expect(host.busy).toBe(false);
    } finally {
      host.dispose();
    }
  }, 30_000);

  test("merged nets are complete through the worker too", async () => {
    const host = new RouterHost();
    try {
      const result = await host.route(request({ srj: multiPadNetSrj() }), { onMessage: () => {} });
      expect([...result.complete].sort()).toEqual(MULTI_PAD_CONNECTIONS);
      expect(result.open).toEqual([]);
    } finally {
      host.dispose();
    }
  }, 30_000);

  test("cancel via AbortSignal terminates within 500 ms", async () => {
    const host = new RouterHost();
    const controller = new AbortController();
    let abortedAt = 0;
    try {
      const promise = host.route(request({ timeoutMs: 60_000 }), {
        onMessage: (m) => {
          if (m.kind === "meta") {
            abortedAt = performance.now();
            controller.abort();
          }
        },
        signal: controller.signal,
      });
      await expect(promise).rejects.toBeInstanceOf(RouteAbortedError);
      expect(performance.now() - abortedAt).toBeLessThan(500);
      expect(host.busy).toBe(false);
    } finally {
      host.dispose();
    }
  }, 30_000);

  test("rejects a second concurrent route and reports unknown routers as errors", async () => {
    const host = new RouterHost();
    try {
      const first = host.route(request(), { onMessage: () => {} });
      await expect(host.route(request(), { onMessage: () => {} })).rejects.toThrow(/busy/);
      await first;
      const previous = process.env["FABDESK_CHANNEL"];
      delete process.env["FABDESK_CHANNEL"];
      try {
        await expect(
          host.route(request({ router: "freerouting" }), { onMessage: () => {} }),
        ).rejects.toThrow(/not available/);
      } finally {
        if (previous !== undefined) process.env["FABDESK_CHANNEL"] = previous;
      }
    } finally {
      host.dispose();
    }
  }, 30_000);
});

describe.skipIf(!VENDOR_PRESENT)("RouterHost (worker, internal channel)", () => {
  test("routes with freerouting when the host process enables the channel at runtime", async () => {
    const previous = process.env["FABDESK_CHANNEL"];
    process.env["FABDESK_CHANNEL"] = "internal";
    const host = new RouterHost();
    const messages: RouterWorkerMessage[] = [];
    try {
      const result = await host.route(request({ router: "freerouting" }), {
        onMessage: (m) => messages.push(m),
      });
      expectWellFormedStream(messages);
      expect(result.router).toBe("freerouting");
      expect([...result.complete].sort()).toEqual(FIXTURE_CONNECTIONS);
      const meta = messages[0];
      if (meta?.kind !== "meta") throw new Error("no meta");
      expect(meta.unitsPerMm).toBe(frameUnitsPerMm("freerouting"));
    } finally {
      host.dispose();
      if (previous === undefined) delete process.env["FABDESK_CHANNEL"];
      else process.env["FABDESK_CHANNEL"] = previous;
    }
  }, 30_000);
});

describe("registry", () => {
  test("frameUnitsPerMm", () => {
    expect(frameUnitsPerMm("capacity")).toBe(1);
    expect(frameUnitsPerMm("freerouting")).toBe(10_000);
  });

  test("availableRouters gates freerouting on the internal channel", async () => {
    const previous = process.env["FABDESK_CHANNEL"];
    try {
      delete process.env["FABDESK_CHANNEL"];
      const publicProbes = await availableRouters();
      expect(publicProbes.map((p) => p.id)).toEqual(["capacity", "freerouting"]);
      expect(publicProbes[0]?.present).toBe(true);
      expect(publicProbes[0]?.ready).toBe(true);
      expect(publicProbes[1]?.present).toBe(false);
      expect(await loadAdapter("freerouting")).toBeUndefined();

      process.env["FABDESK_CHANNEL"] = "internal";
      const internalProbes = await availableRouters();
      expect(internalProbes[1]?.present).toBe(VENDOR_PRESENT);
      const adapter = await loadAdapter("freerouting");
      if (VENDOR_PRESENT) expect(adapter?.id).toBe("freerouting");
      else expect(adapter).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env["FABDESK_CHANNEL"];
      else process.env["FABDESK_CHANNEL"] = previous;
    }
  });
});
