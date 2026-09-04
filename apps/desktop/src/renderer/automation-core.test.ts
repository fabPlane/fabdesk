import { describe, expect, test } from "bun:test";
import { cssPath, implicitRole, normalizeText, rankMatches, scoreMatch, uiSnapshot, type ElementInfo, type PathNode } from "./automation-core";

const el = (over: Partial<ElementInfo> & { role?: string }): ElementInfo => ({
  ref: "x",
  role: "button",
  name: "",
  text: "",
  testid: null,
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  disabled: false,
  ...over,
});

describe("matching", () => {
  test("implicit roles and text normalisation", () => {
    expect(implicitRole("BUTTON")).toBe("button");
    expect(implicitRole("input", "checkbox")).toBe("checkbox");
    expect(implicitRole("input", null)).toBe("textbox");
    expect(implicitRole("div")).toBe("generic");
    expect(normalizeText("  Route \n Cinema  ")).toBe("Route Cinema");
    expect(normalizeText("a".repeat(300), 20)).toHaveLength(20);
  });

  test("scores exact > prefix > word > substring and prefers testid/name over text", () => {
    const q = "route cinema";
    const exactTestid = scoreMatch(el({ testid: "route cinema" }), q);
    const exactName = scoreMatch(el({ name: "Route Cinema" }), q);
    const exactText = scoreMatch(el({ text: "Route Cinema" }), q);
    const prefixText = scoreMatch(el({ text: "Route Cinema tab" }), q);
    const wordText = scoreMatch(el({ text: "open Route Cinema now" }), q);
    const substr = scoreMatch(el({ text: "xroute cinemax" }), q);
    expect(exactTestid).toBeGreaterThan(exactName);
    expect(exactName).toBeGreaterThan(exactText);
    expect(exactText).toBeGreaterThan(prefixText);
    expect(prefixText).toBeGreaterThan(wordText);
    expect(wordText).toBeGreaterThan(substr);
    expect(substr).toBeGreaterThan(0);
    expect(scoreMatch(el({ text: "Schematic" }), q)).toBe(0);
    expect(scoreMatch(el({ text: "anything" }), "   ")).toBe(0);
  });

  test("case-insensitive, shorter and interactive elements win ties, disabled loses", () => {
    expect(scoreMatch(el({ text: "WHOLE BOARD" }), "whole board")).toBe(scoreMatch(el({ text: "whole board" }), "Whole Board"));
    expect(scoreMatch(el({ text: "Send" }), "send")).toBeGreaterThan(scoreMatch(el({ text: "Send" + " a message to the agent".repeat(3) }), "send"));
    expect(scoreMatch(el({ text: "Send", role: "button" }), "send")).toBeGreaterThan(scoreMatch(el({ text: "Send", role: "heading" }), "send"));
    expect(scoreMatch(el({ text: "Send" }), "send")).toBeGreaterThan(scoreMatch(el({ text: "Send", disabled: true }), "send"));
    expect(scoreMatch(el({ role: "button" }), "button")).toBeGreaterThan(0);
  });

  test("rankMatches orders by score then position and applies the limit", () => {
    const items = [
      el({ ref: "c", text: "Route Cinema settings", bounds: { x: 0, y: 50, width: 1, height: 1 } }),
      el({ ref: "a", text: "Route Cinema", bounds: { x: 5, y: 10, width: 1, height: 1 } }),
      el({ ref: "b", text: "Route Cinema", bounds: { x: 0, y: 10, width: 1, height: 1 } }),
      el({ ref: "d", text: "Schematic" }),
    ];
    const ranked = rankMatches(items, "route cinema", 10);
    expect(ranked.map((r) => r.ref)).toEqual(["b", "a", "c"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[2]!.score);
    expect(rankMatches(items, "route cinema", 1).map((r) => r.ref)).toEqual(["b"]);
    expect(rankMatches(items, "nothing", 5)).toEqual([]);
  });
});

describe("css paths", () => {
  const node = (tag: string, parent: PathNode | null, extra: Partial<PathNode> = {}): PathNode => ({ tag, id: null, testid: null, parent, nthOfType: 1, countOfType: 1, ...extra });

  test("prefers a unique testid, then a unique id", () => {
    const body = node("body", node("html", null));
    const withTestid = node("button", node("div", body), { testid: "send", id: "btn" });
    expect(cssPath(withTestid, () => true)).toBe('[data-testid="send"]');
    expect(cssPath(withTestid, (s) => s.startsWith("#"))).toBe("#btn");
    expect(cssPath(node("button", body, { testid: 'we"ird' }), () => true)).toBe('[data-testid="we\\"ird"]');
  });

  test("falls back to an nth-of-type path anchored at the nearest unique ancestor", () => {
    const body = node("body", node("html", null));
    const root = node("div", body, { id: "root" });
    const panel = node("div", root, { nthOfType: 2, countOfType: 3 });
    const select = node("select", panel, { nthOfType: 2, countOfType: 2 });
    const option = node("option", select, { nthOfType: 2, countOfType: 2 });
    expect(cssPath(option, (s) => s === "#root")).toBe("#root > div:nth-of-type(2) > select:nth-of-type(2) > option:nth-of-type(2)");
    expect(cssPath(option, () => false)).toBe("body > div > div:nth-of-type(2) > select:nth-of-type(2) > option:nth-of-type(2)");
    // Invalid ids (spaces, leading digit) are never used as anchors.
    expect(cssPath(node("span", body, { id: "1bad" }), () => true)).toBe("body > span");
  });
});

describe("ui snapshot", () => {
  test("summarises stores without leaking tokens", () => {
    const snap = uiSnapshot({
      ui: { sidebarOpen: true, boardOpen: true, activeThreadId: null, activeProjectId: "p1", boardTab: "cinema", drafts: { __new__: "hi", t1: "other" }, paletteOpen: false, settingsOpen: true, settingsSection: "router", sketchOpen: false, agentPickerOpen: false },
      cinema: {
        runs: { r1: { frames: [1, 2, 3], evicted: 2, result: { complete: [1, 2], open: [3], timedOut: false } }, r0: { frames: [] } },
        activeRunId: "r1",
        cursor: 2,
        playing: false,
        followLive: true,
        hiddenLayers: [1],
        playbackMs: 120,
        viewMode: "board",
        perf: { fps: 3, drawMs: 1.5, received: 5, dropped: 0 },
      },
      auth: { mode: "local" },
      core: { url: "http://127.0.0.1:47831", status: { state: "ready" } },
      page: { href: "http://localhost:5173/", title: "fabPlane", width: 1440, height: 920, dpr: 2, composerMounted: true },
      newChatDraftKey: "__new__",
    });
    expect(snap.activeProjectId).toBe("p1");
    expect(snap.composer).toEqual({ draft: "hi", mounted: true });
    expect(snap.cinema).toEqual({
      activeRunId: "r1",
      runIds: ["r1", "r0"],
      frames: 3,
      evicted: 2,
      cursor: 2,
      playing: false,
      followLive: true,
      viewMode: "board",
      hiddenLayers: [1],
      playbackMs: 120,
      perf: { fps: 3, drawMs: 1.5, received: 5, dropped: 0 },
      result: { complete: 2, open: 1, timedOut: false },
    });
    expect(snap.core).toEqual({ url: "http://127.0.0.1:47831", status: { state: "ready" } });
    expect(JSON.stringify(snap)).not.toContain("token");
  });
});
