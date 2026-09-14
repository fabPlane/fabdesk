import { describe, expect, test } from "bun:test";
import { DORMANT_AFTER_MS, dormancyAction } from "./dormancy";

describe("dormancyAction", () => {
  test("leaving the foreground arms the close, returning wakes", () => {
    expect(dormancyAction("active", "background")).toBe("arm");
    expect(dormancyAction("inactive", "background")).toBe("arm");
    expect(dormancyAction("background", "active")).toBe("wake");
    expect(dormancyAction("inactive", "active")).toBe("wake");
  });

  test("inactive on its own, and repeats, do nothing", () => {
    expect(dormancyAction("active", "inactive")).toBe("none");
    expect(dormancyAction("background", "background")).toBe("none");
    expect(dormancyAction("active", "active")).toBe("none");
    expect(dormancyAction(null, "active")).toBe("wake");
  });

  test("the grace window is shorter than iOS's background budget", () => {
    expect(DORMANT_AFTER_MS).toBeLessThan(25_000);
  });
});
