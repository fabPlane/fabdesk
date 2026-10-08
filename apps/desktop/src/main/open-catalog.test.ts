import { describe, expect, test } from "bun:test";
import { OpenCatalogQueue } from "./open-catalog";

describe("OpenCatalogQueue", () => {
  test("keeps the last valid deep link until the renderer takes it", () => {
    const queue = new OpenCatalogQueue();
    expect(queue.offer(["--foo", "not-a-link"])).toBeNull();
    expect(queue.offer("fabplane://open?catalog=foostan/crkbd")).toEqual({
      catalogId: "foostan/crkbd",
      remix: false,
    });
    expect(queue.peek()?.catalogId).toBe("foostan/crkbd");
    expect(queue.take()).toEqual({ catalogId: "foostan/crkbd", remix: false });
    expect(queue.take()).toBeNull();
  });
});
