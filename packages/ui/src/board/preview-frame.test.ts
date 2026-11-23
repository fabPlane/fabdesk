import { expect, test } from "bun:test";
import { previewFrame } from "./preview-frame";

test("coalesces a burst of input and cancels pending rendering on disposal", () => {
  let drawCount = 0, id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const frames = previewFrame(() => drawCount++, fn => { callbacks.set(++id, fn); return id; }, key => { callbacks.delete(key); });
  for (let i = 0; i < 100; i++) frames.render();
  expect(callbacks.size).toBe(1);
  const callback = callbacks.get(id)!; callbacks.clear(); callback(0);
  expect(drawCount).toBe(1);
  frames.render(); expect(callbacks.size).toBe(1);
  frames.dispose(); expect(callbacks.size).toBe(0);
  expect(drawCount).toBe(1);
});


test("resize keeps the old pixels until the replacement draws in the same frame", () => {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  let pixels = "old board", size = 100;
  const events: string[] = [];
  const frames = previewFrame(() => { pixels = "new board"; events.push(`draw:${size}`); },
    fn => { callbacks.set(++id, fn); return id; }, key => { callbacks.delete(key); });
  const resize = (next: number) => frames.renderWith(() => { pixels = "blank"; size = next; events.push(`resize:${next}`); });
  resize(120); resize(160);
  frames.render(); // Input must not discard the queued resize.
  expect(pixels).toBe("old board");
  expect(size).toBe(100);
  expect(callbacks.size).toBe(1);
  const callback = callbacks.get(id)!; callbacks.clear(); callback(0);
  expect(events).toEqual(["resize:160", "draw:160"]);
  expect(pixels).toBe("new board");
  resize(200); frames.dispose();
  expect(callbacks.size).toBe(0);
  expect(size).toBe(160);
});
