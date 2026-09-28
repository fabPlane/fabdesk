import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterWorkerMessage } from "@fabdesk/protocol";
import { FrameSink } from "../src/frame-sink";
import { RouteProgressFrames } from "../src/tools/route";

const meta: RouterWorkerMessage = {
  kind: "meta",
  runId: "run_test",
  router: "capacity",
  bounds: { x1: 0, y1: 0, x2: 10, y2: 10 },
  layers: ["top", "bottom"],
  unitsPerMm: 1,
};

describe("FrameSink", () => {
  test("caps persisted bytes without suppressing live events or progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-frames-"));
    const path = join(dir, "frames.jsonl");
    const live: RouterWorkerMessage[] = [];
    const progress: RouterWorkerMessage[] = [];
    const firstLineBytes = Buffer.byteLength(JSON.stringify(meta) + "\n");
    const sink = new FrameSink(
      path,
      {
        emit: (event) => {
          if (event.topic === "route.meta") live.push(event.meta);
        },
      },
      (message) => progress.push(message),
      firstLineBytes,
    );

    sink.onMessage(meta);
    sink.onMessage({ ...meta, runId: "run_dropped" });
    await sink.close();

    expect(await Bun.file(path).text()).toBe(JSON.stringify(meta) + "\n");
    expect(sink.stats).toMatchObject({ bytes: firstLineBytes, truncated: true });
    expect(sink.stats.droppedBytes).toBeGreaterThan(0);
    expect(live).toHaveLength(2);
    expect(progress).toHaveLength(2);
  });

  test("always persists the terminal done frame after the cap is reached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-frames-"));
    const path = join(dir, "frames.jsonl");
    const metaBytes = Buffer.byteLength(JSON.stringify(meta) + "\n");
    const sink = new FrameSink(path, null, undefined, metaBytes + 10);
    const frames = new RouteProgressFrames("run_test", Date.now(), sink);
    sink.onMessage(meta);
    frames.onProgress({ state: "running", log: [], routed: 50, total: 50 });
    frames.complete([{ k: "trace", id: 1, layer: 0, net: 1, pts: [0, 0, 5, 5], w: 0.2 }], 50);
    await sink.close();

    const lines = (await Bun.file(path).text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event?.kind ?? l.kind)).toEqual(["meta", "done"]);
    expect(lines.at(-1).shapes).toHaveLength(1);
    expect(sink.stats.truncated).toBe(true);
    expect(sink.stats.droppedBytes).toBeGreaterThan(0);
  });
});
