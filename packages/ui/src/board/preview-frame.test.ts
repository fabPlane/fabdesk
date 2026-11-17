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
