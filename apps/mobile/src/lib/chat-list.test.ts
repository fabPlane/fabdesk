import { describe, expect, test } from "bun:test";
import type { ProjectThreadGroup } from "@fabdesk/client-core";
import type { Thread } from "@fabdesk/protocol";
import {
  DEFAULT_PREFS,
  buildSections,
  isUnread,
  parsePrefs,
  sortThreads,
  threadIdFromPath,
  toggleCollapsed,
  withSeen,
  type ChatListPrefs,
} from "./chat-list";

function thread(
  id: string,
  updatedAt: string,
  createdAt = updatedAt,
  extra: Partial<Thread> = {},
): Thread {
  return {
    id,
    projectId: null,
    folderId: null,
    title: id,
    pinned: false,
    archived: false,
    agentId: "claude",
    model: null,
    parentThreadId: null,
    branchFromMessageId: null,
    createdAt,
    updatedAt,
    ...extra,
  };
}

const T1 = "2026-09-10T10:00:00.000Z";
const T2 = "2026-09-11T10:00:00.000Z";
const T3 = "2026-09-12T10:00:00.000Z";

const none = () => false;

describe("parsePrefs", () => {
  test("returns defaults for garbage", () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("x")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(42)).toEqual(DEFAULT_PREFS);
  });

  test("keeps valid fields and drops the rest", () => {
    expect(
      parsePrefs({
        sort: "created",
        collapsed: ["a", 3, null, "b"],
        lastSeen: { t1: T1, t2: "not a date", t3: 5 },
        baseline: T2,
        stray: true,
      }),
    ).toEqual({ sort: "created", collapsed: ["a", "b"], lastSeen: { t1: T1 }, baseline: T2 });
  });

  test("replaces wrong types with defaults", () => {
    expect(
      parsePrefs({ sort: "nope", collapsed: "a", lastSeen: [], baseline: "yesterday" }),
    ).toEqual({
      sort: "updated",
      collapsed: [],
      lastSeen: {},
      baseline: null,
    });
    // An array is an object; its indices are not thread ids we care about but they are harmless.
    expect(parsePrefs({ lastSeen: [T1] })).toEqual({ ...DEFAULT_PREFS, lastSeen: { "0": T1 } });
  });

  test("does not return the shared default object", () => {
    const a = parsePrefs(undefined);
    a.collapsed.push("x");
    expect(DEFAULT_PREFS.collapsed).toEqual([]);
  });
});

describe("isUnread", () => {
  test("nothing is unread before the store has a baseline", () => {
    expect(isUnread(thread("a", T3), { lastSeen: {}, baseline: null })).toBe(false);
  });

  test("never-seen threads compare against the baseline", () => {
    const prefs = { lastSeen: {}, baseline: T2 };
    expect(isUnread(thread("old", T1), prefs)).toBe(false);
    expect(isUnread(thread("same", T2), prefs)).toBe(false);
    expect(isUnread(thread("new", T3), prefs)).toBe(true);
  });

  test("a seen thread is unread only when updated after the look", () => {
    const prefs = { lastSeen: { a: T2 }, baseline: T1 };
    expect(isUnread(thread("a", T2), prefs)).toBe(false);
    expect(isUnread(thread("a", T3), prefs)).toBe(true);
    expect(isUnread(thread("a", T1), prefs)).toBe(false);
  });

  test("lastSeen wins over the baseline even when it is earlier", () => {
    // Looked at it on day 1, baseline moved later (never happens in practice; must not throw).
    expect(isUnread(thread("a", T2), { lastSeen: { a: T1 }, baseline: T3 })).toBe(true);
  });

  test("an unparsable updatedAt is treated as the epoch, hence read", () => {
    expect(isUnread(thread("a", "garbage"), { lastSeen: {}, baseline: T1 })).toBe(false);
  });
});

describe("withSeen", () => {
  const now = Date.parse(T2);

  test("stores now when the thread is older", () => {
    expect(withSeen({}, "a", T1, now)).toEqual({ a: T2 });
  });

  test("stores the thread's own time when the daemon's clock is ahead", () => {
    expect(withSeen({}, "a", T3, now)).toEqual({ a: T3 });
  });

  test("works without an updatedAt", () => {
    expect(withSeen({ b: T1 }, "a", undefined, now)).toEqual({ b: T1, a: T2 });
  });

  test("returns the same object when nothing changes", () => {
    const seen = { a: T2 };
    expect(withSeen(seen, "a", T1, now)).toBe(seen);
  });

  test("does not mutate the input", () => {
    const seen = { a: T1 };
    withSeen(seen, "a", T3, now);
    expect(seen).toEqual({ a: T1 });
  });
});

describe("toggleCollapsed", () => {
  test("adds and removes without mutating", () => {
    const start = ["a"];
    const added = toggleCollapsed(start, "b");
    expect(added).toEqual(["a", "b"]);
    expect(toggleCollapsed(added, "a")).toEqual(["b"]);
    expect(start).toEqual(["a"]);
  });
});

describe("sortThreads", () => {
  const a = thread("a", T1, T3); // oldest message, newest created
  const b = thread("b", T2, T2);
  const c = thread("c", T3, T1); // newest message, oldest created

  test("newest message first by default", () => {
    expect(sortThreads([a, b, c], "updated", none).map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  test("newest created first in created mode", () => {
    expect(sortThreads([a, b, c], "created", none).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  test("running threads come first, then the normal order", () => {
    const running = (id: string) => id === "a" || id === "b";
    expect(sortThreads([a, b, c], "updated", running).map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  test("is stable for equal timestamps and does not mutate", () => {
    const x = thread("x", T1);
    const y = thread("y", T1);
    const input = [x, y];
    expect(sortThreads(input, "updated", none).map((t) => t.id)).toEqual(["x", "y"]);
    expect(input.map((t) => t.id)).toEqual(["x", "y"]);
  });

  test("unparsable timestamps sort last", () => {
    expect(sortThreads([thread("bad", "?"), a], "updated", none).map((t) => t.id)).toEqual([
      "a",
      "bad",
    ]);
  });
});

describe("buildSections", () => {
  const groups: ProjectThreadGroup[] = [
    {
      key: "pinned",
      title: "Pinned",
      kind: "pinned",
      projectId: null,
      threads: [thread("p", T1, T1, { pinned: true })],
    },
    {
      key: "proj",
      title: "Blinky",
      kind: "project",
      projectId: "proj",
      threads: [thread("a", T1), thread("b", T3), thread("c", T2)],
    },
    { key: "empty", title: "Empty", kind: "project", projectId: "empty", threads: [] },
  ];
  const prefs: ChatListPrefs = {
    sort: "updated",
    collapsed: [],
    lastSeen: { b: T3 },
    baseline: T1,
  };

  test("keeps group order, sorts rows, counts unread and running", () => {
    const sections = buildSections({ groups, prefs, isRunning: (id) => id === "a" });
    expect(sections.map((s) => s.key)).toEqual(["pinned", "proj", "empty"]);
    const proj = sections[1]!;
    expect(proj.title).toBe("Blinky");
    expect(proj.group).toBe(groups[1]!);
    expect(proj.collapsed).toBe(false);
    expect(proj.data.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(proj.total).toBe(3);
    // b was seen at T3; c changed at T2 > baseline; a is at the baseline.
    expect(proj.unread).toBe(1);
    expect(proj.running).toBe(1);
    expect(sections[2]).toMatchObject({ data: [], total: 0, unread: 0, running: 0 });
  });

  test("a collapsed group renders no rows but keeps its counts", () => {
    const sections = buildSections({
      groups,
      prefs: { ...prefs, collapsed: ["proj"] },
      isRunning: none,
    });
    const proj = sections[1]!;
    expect(proj.collapsed).toBe(true);
    expect(proj.data).toEqual([]);
    expect(proj.total).toBe(3);
    expect(proj.unread).toBe(1);
    expect(sections[0]!.collapsed).toBe(false);
  });

  test("honours the sort mode", () => {
    const created: ProjectThreadGroup[] = [
      {
        key: "g",
        title: "G",
        kind: "project",
        projectId: "g",
        threads: [thread("a", T3, T1), thread("b", T1, T3)],
      },
    ];
    expect(
      buildSections({
        groups: created,
        prefs: { ...prefs, sort: "created" },
        isRunning: none,
      })[0]!.data.map((t) => t.id),
    ).toEqual(["b", "a"]);
  });
});

describe("threadIdFromPath", () => {
  test("extracts the id from a thread route", () => {
    expect(threadIdFromPath("/thread/abc")).toBe("abc");
    expect(threadIdFromPath("/thread/abc?x=1")).toBe("abc");
    expect(threadIdFromPath("/thread/a%20b/")).toBe("a b");
  });

  test("returns null elsewhere", () => {
    expect(threadIdFromPath("/")).toBeNull();
    expect(threadIdFromPath("/project/abc")).toBeNull();
    expect(threadIdFromPath("/thread/")).toBeNull();
    expect(threadIdFromPath(null)).toBeNull();
    expect(threadIdFromPath(undefined)).toBeNull();
  });
});
