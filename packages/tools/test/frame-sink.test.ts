import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouterWorkerMessage } from "@fabdesk/protocol";
import { FrameSink } from "../src/frame-sink";

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
});
