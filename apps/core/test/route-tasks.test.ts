import { describe, expect, test } from "bun:test";
import { RouteTaskQueue } from "../src/route-tasks";

describe("RouteTaskQueue", () => {
  test("serializes one project's routes while allowing another project and exact cancellation", async () => {
    const queue = new RouteTaskQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    expect(
      queue.enqueue({ id: "a1", projectId: "a" }, async () => {
        events.push("a1:start");
        await firstGate;
        events.push("a1:end");
      }),
    ).toBe("running");
    expect(
      queue.enqueue({ id: "a2", projectId: "a" }, async (signal) => {
        events.push(signal.aborted ? "a2:cancelled" : "a2:ran");
      }),
    ).toBe("queued");
    expect(
      queue.enqueue({ id: "b1", projectId: "b" }, async () => {
        events.push("b1:ran");
      }),
    ).toBe("running");
    expect(queue.cancel("a2")).toBe("requested");
    await Bun.sleep(10);
    expect(events).toContain("a1:start");
    expect(events).toContain("b1:ran");
    expect(events).not.toContain("a2:ran");
    releaseFirst();
    await Bun.sleep(10);
    expect(events).toContain("a2:cancelled");
  });
});
