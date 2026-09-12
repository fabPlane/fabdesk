import { describe, expect, test } from "bun:test";
import {
  DEFAULT_NOTIFICATION_PREFS,
  connectionForCore,
  dedupeKey,
  isExpoPushToken,
  navigationFor,
  noticeForEvent,
  notificationText,
  parseNotificationData,
  prefAllows,
  pushRegistration,
  rememberKey,
} from "./notification-payload";

const good = {
  v: 1,
  kind: "run.done",
  coreId: "core_abc",
  coreName: "studio",
  threadId: "t1",
  runId: "r1",
};

describe("parseNotificationData", () => {
  test("accepts a §4.2 payload and drops unknown/empty fields", () => {
    expect(parseNotificationData({ ...good, extra: 1, projectId: "" })).toEqual({
      v: 1,
      kind: "run.done",
      coreId: "core_abc",
      coreName: "studio",
      threadId: "t1",
      runId: "r1",
    });
  });

  test("rejects the wrong version, an unknown kind, or a missing coreId", () => {
    expect(parseNotificationData({ ...good, v: 2 })).toBeNull();
    expect(parseNotificationData({ ...good, kind: "run.started" })).toBeNull();
    expect(parseNotificationData({ ...good, coreId: undefined })).toBeNull();
    expect(parseNotificationData(null)).toBeNull();
    expect(parseNotificationData("run.done")).toBeNull();
  });

  test("unwraps Android's dataString / body JSON forms", () => {
    expect(parseNotificationData({ dataString: JSON.stringify(good) })?.threadId).toBe("t1");
    expect(parseNotificationData({ body: JSON.stringify(good) })?.runId).toBe("r1");
    expect(parseNotificationData({ dataString: "{not json" })).toBeNull();
  });

  test("a job without a thread keeps its jobId", () => {
    const d = parseNotificationData({
      v: 1,
      kind: "job.done",
      coreId: "c",
      coreName: "n",
      jobId: "j9",
    });
    expect(d).toEqual({ v: 1, kind: "job.done", coreId: "c", coreName: "n", jobId: "j9" });
  });
});

describe("dedupeKey / rememberKey", () => {
  test("keys on the run, else the job, else nothing", () => {
    expect(dedupeKey({ coreId: "c", runId: "r" })).toBe("c:r");
    expect(dedupeKey({ coreId: "c", jobId: "j" })).toBe("c:j");
    expect(dedupeKey({ coreId: "c", runId: "r", jobId: "j" })).toBe("c:r");
    expect(dedupeKey({ coreId: "c" })).toBeNull();
  });

  test("keeps the most recent `max` keys, newest last, without duplicates", () => {
    let seen: string[] = [];
    for (let i = 0; i < 105; i++) seen = rememberKey(seen, `k${i}`);
    expect(seen).toHaveLength(100);
    expect(seen[0]).toBe("k5");
    expect(seen[99]).toBe("k104");
    const again = rememberKey(seen, "k50");
    expect(again).toHaveLength(100);
    expect(again[99]).toBe("k50");
    expect(again.filter((k) => k === "k50")).toHaveLength(1);
  });
});

describe("connectionForCore / navigationFor", () => {
  const conns = [
    { id: "dev-1", deviceId: "dev-1", coreId: "core_a" },
    { id: "dev-2", deviceId: "dev-2" },
  ];

  test("matches by coreId first, then by device id for older pairings", () => {
    expect(connectionForCore(conns, "core_a")?.id).toBe("dev-1");
    expect(connectionForCore(conns, "dev-2")?.id).toBe("dev-2");
    expect(connectionForCore(conns, "core_zzz")).toBeNull();
  });

  test("a thread on the active connection needs no switch", () => {
    const data = parseNotificationData(good)!;
    expect(navigationFor({ ...data, coreId: "core_a" }, conns, "dev-1")).toEqual({
      switchTo: null,
      target: { kind: "thread", threadId: "t1" },
    });
  });

  test("a thread on another paired daemon switches to it first", () => {
    const data = parseNotificationData({ ...good, coreId: "dev-2" })!;
    expect(navigationFor(data, conns, "dev-1")).toEqual({
      switchTo: "dev-2",
      target: { kind: "thread", threadId: "t1" },
    });
  });

  test("a job without a thread opens Jobs; an unknown daemon or payload opens Chats", () => {
    const job = parseNotificationData({
      v: 1,
      kind: "job.done",
      coreId: "core_a",
      coreName: "n",
      jobId: "j",
    })!;
    expect(navigationFor(job, conns, "dev-1").target).toEqual({ kind: "jobs" });
    const stranger = parseNotificationData({ ...good, coreId: "core_unknown" })!;
    expect(navigationFor(stranger, conns, "dev-1")).toEqual({
      switchTo: null,
      target: { kind: "thread", threadId: "t1" },
    });
    expect(navigationFor(null, conns, "dev-1")).toEqual({
      switchTo: null,
      target: { kind: "chats" },
    });
  });
});

describe("noticeForEvent", () => {
  const threadFor = (runId: string) => (runId === "r-known" ? "t-known" : undefined);

  test("agent.done splits on status", () => {
    expect(
      noticeForEvent(
        { topic: "agent.done", runId: "r1", threadId: "t1", status: "completed" },
        threadFor,
      ),
    ).toEqual({ kind: "run.done", runId: "r1", threadId: "t1" });
    expect(
      noticeForEvent(
        { topic: "agent.done", runId: "r1", threadId: "t1", status: "failed" },
        threadFor,
      ),
    ).toEqual({ kind: "run.failed", runId: "r1", threadId: "t1" });
    expect(
      noticeForEvent(
        { topic: "agent.done", runId: "r1", threadId: "t1", status: "aborted" },
        threadFor,
      )?.kind,
    ).toBe("run.failed");
  });

  test("agent.error finds its thread through the run store, or is dropped", () => {
    expect(noticeForEvent({ topic: "agent.error", runId: "r-known" }, threadFor)).toEqual({
      kind: "run.failed",
      runId: "r-known",
      threadId: "t-known",
    });
    expect(noticeForEvent({ topic: "agent.error", runId: "r-orphan" }, threadFor)).toBeNull();
  });

  test("approval and input requests need the user", () => {
    expect(
      noticeForEvent({ topic: "agent.approval_requested", runId: "r1", threadId: "t1" }, threadFor)
        ?.kind,
    ).toBe("run.needs_input");
    expect(
      noticeForEvent({ topic: "agent.input_requested", runId: "r-known" }, threadFor)?.threadId,
    ).toBe("t-known");
  });

  test("job.done is a job notice; everything else is ignored", () => {
    expect(noticeForEvent({ topic: "job.done", jobId: "j1" }, threadFor)).toEqual({
      kind: "job.done",
      jobId: "j1",
    });
    expect(noticeForEvent({ topic: "agent.delta", runId: "r1" }, threadFor)).toBeNull();
    expect(
      noticeForEvent({ topic: "agent.started", runId: "r1", threadId: "t1" }, threadFor),
    ).toBeNull();
  });
});

describe("prefAllows", () => {
  test("defaults notify on done, failed and needs-input but not jobs", () => {
    expect(prefAllows(DEFAULT_NOTIFICATION_PREFS, "run.done")).toBe(true);
    expect(prefAllows(DEFAULT_NOTIFICATION_PREFS, "run.failed")).toBe(true);
    expect(prefAllows(DEFAULT_NOTIFICATION_PREFS, "run.needs_input")).toBe(true);
    expect(prefAllows(DEFAULT_NOTIFICATION_PREFS, "job.done")).toBe(false);
    expect(prefAllows({ ...DEFAULT_NOTIFICATION_PREFS, onDone: false }, "run.done")).toBe(false);
  });
});

describe("notificationText", () => {
  test("matches the §4.3 table", () => {
    const ctx = {
      threadTitle: "LED driver",
      agent: "Claude",
      project: "blinky",
      coreName: "studio",
    };
    expect(notificationText("run.done", ctx)).toEqual({
      title: "Done · LED driver",
      body: "Claude finished in blinky on studio",
    });
    expect(notificationText("run.failed", ctx)).toEqual({
      title: "Failed · LED driver",
      body: "Claude stopped in blinky — tap to see why",
    });
    expect(notificationText("run.needs_input", ctx)).toEqual({
      title: "Needs you · LED driver",
      body: "Claude is waiting for an answer",
    });
    expect(notificationText("job.done", { ...ctx, jobKind: "route_run" })).toEqual({
      title: "Route run finished",
      body: "blinky on studio",
    });
  });

  test("falls back when the cache has nothing", () => {
    expect(notificationText("run.done", { coreName: "studio" })).toEqual({
      title: "Done · Chat",
      body: "The agent finished in a chat on studio",
    });
    expect(notificationText("job.done", { coreName: "studio" }).title).toBe("Job finished");
  });
});

describe("pushRegistration / isExpoPushToken", () => {
  test("builds the §4.1 body and omits an absent appVersion", () => {
    expect(
      pushRegistration({
        expoPushToken: "ExponentPushToken[abc]",
        platform: "ios",
        prefs: DEFAULT_NOTIFICATION_PREFS,
      }),
    ).toEqual({
      expoPushToken: "ExponentPushToken[abc]",
      platform: "ios",
      prefs: DEFAULT_NOTIFICATION_PREFS,
    });
    expect(
      pushRegistration({
        expoPushToken: "ExpoPushToken[x]",
        platform: "android",
        appVersion: "0.1.0",
        prefs: DEFAULT_NOTIFICATION_PREFS,
      }).appVersion,
    ).toBe("0.1.0");
  });

  test("only Expo-shaped tokens pass", () => {
    expect(isExpoPushToken("ExponentPushToken[abc-DEF_123]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc]")).toBe(true);
    expect(isExpoPushToken("fcm:abc")).toBe(false);
    expect(isExpoPushToken(undefined)).toBe(false);
  });
});
