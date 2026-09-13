/**
 * The notification contract from docs/mobile-notifications.md §4.3, kept pure so Bun can test it.
 *
 * Whether a notification came from the daemon through push or was scheduled locally while the
 * app was backgrounded, the phone reads only its `data`: it decides where a tap goes, which
 * connection it belongs to, and whether it is a duplicate of one already shown. `title` and
 * `body` are for display and nothing else. `src/notifications/` owns the expo-notifications
 * calls; this file only says what to do with what they hand over.
 */

export const NOTIFICATION_KINDS = [
  "run.done",
  "run.failed",
  "run.needs_input",
  "job.done",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** §4.2 `data`. `coreId` is the daemon's stable identity (§4.4); local notifications use the connection's. */
export interface NotificationData {
  v: 1;
  kind: NotificationKind;
  coreId: string;
  coreName: string;
  threadId?: string;
  runId?: string;
  jobId?: string;
  projectId?: string;
}

function optionalString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Validates whatever arrived as a notification's `data`. Android's FCM path sometimes wraps the
 * payload as a `dataString` JSON string or a `body` string; both are unwrapped first. Anything
 * short of a well-formed §4.2 payload is null, and the tap opens Chats.
 */
export function parseNotificationData(raw: unknown): NotificationData | null {
  let o = raw;
  if (o && typeof o === "object") {
    const wrapped =
      (o as Record<string, unknown>).dataString ?? (o as Record<string, unknown>).body;
    if (typeof wrapped === "string" && !("kind" in (o as object))) {
      try {
        o = JSON.parse(wrapped);
      } catch {
        return null;
      }
    }
  }
  if (!o || typeof o !== "object") return null;
  const d = o as Record<string, unknown>;
  if (d.v !== 1) return null;
  const kind = d.kind;
  if (typeof kind !== "string" || !NOTIFICATION_KINDS.includes(kind as NotificationKind))
    return null;
  const coreId = optionalString(d, "coreId");
  if (!coreId) return null;
  const threadId = optionalString(d, "threadId");
  const runId = optionalString(d, "runId");
  const jobId = optionalString(d, "jobId");
  const projectId = optionalString(d, "projectId");
  return {
    v: 1,
    kind: kind as NotificationKind,
    coreId,
    coreName: optionalString(d, "coreName") ?? "",
    ...(threadId ? { threadId } : {}),
    ...(runId ? { runId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(projectId ? { projectId } : {}),
  };
}

/** `${coreId}:${runId ?? jobId}`; null when there is nothing to dedupe on. */
export function dedupeKey(
  data: Pick<NotificationData, "coreId" | "runId" | "jobId">,
): string | null {
  const id = data.runId ?? data.jobId;
  return id ? `${data.coreId}:${id}` : null;
}

export const SEEN_KEYS_MAX = 100;

/** Appends a key, most recent last, dropping the oldest beyond `max` and any earlier copy of itself. */
export function rememberKey(seen: readonly string[], key: string, max = SEEN_KEYS_MAX): string[] {
  const next = seen.filter((k) => k !== key);
  next.push(key);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The subset of a saved connection that a tap needs. */
export interface ConnectionLike {
  id: string;
  deviceId: string;
  coreId?: string | undefined;
}

export type NotificationTarget =
  | { kind: "thread"; threadId: string }
  | { kind: "jobs" }
  | { kind: "chats" };

export interface NotificationNavigation {
  /** The connection to make active first, or null when the active one already matches (or none does). */
  switchTo: string | null;
  target: NotificationTarget;
}

/**
 * Finds the connection a notification belongs to: by `coreId` first, then — for connections
 * paired before the daemon minted one (§4.4), whose local notifications carry the device id
 * instead — by `deviceId`/`id`. Null when the phone knows no such daemon.
 */
export function connectionForCore<C extends ConnectionLike>(
  connections: readonly C[],
  coreId: string,
): C | null {
  return (
    connections.find((c) => c.coreId === coreId) ??
    connections.find((c) => c.deviceId === coreId || c.id === coreId) ??
    null
  );
}

/**
 * Where a tap goes (§4.3). An unknown payload lands on Chats without switching anything; a known
 * daemon that is not active is switched to first so the thread loads from the right machine.
 */
export function navigationFor(
  data: NotificationData | null,
  connections: readonly ConnectionLike[],
  activeId: string | null,
): NotificationNavigation {
  if (!data) return { switchTo: null, target: { kind: "chats" } };
  const conn = connectionForCore(connections, data.coreId);
  const switchTo = conn && conn.id !== activeId ? conn.id : null;
  if (data.threadId) return { switchTo, target: { kind: "thread", threadId: data.threadId } };
  if (data.jobId) return { switchTo, target: { kind: "jobs" } };
  return { switchTo, target: { kind: "chats" } };
}

/** §4.1 `DevicePushPrefs`, mirrored here so the phone's store and the daemon agree on the defaults. */
export interface NotificationPrefs {
  onDone: boolean;
  onFailed: boolean;
  onNeedsInput: boolean;
  onJobs: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  onDone: true,
  onFailed: true,
  onNeedsInput: true,
  onJobs: false,
};

export function prefAllows(prefs: NotificationPrefs, kind: NotificationKind): boolean {
  switch (kind) {
    case "run.done":
      return prefs.onDone;
    case "run.failed":
      return prefs.onFailed;
    case "run.needs_input":
      return prefs.onNeedsInput;
    case "job.done":
      return prefs.onJobs;
  }
}

/** The loose shape of a bus event; only the fields that decide whether to notify are read. */
export interface RunEventLike {
  topic: string;
  runId?: string | undefined;
  threadId?: string | undefined;
  status?: string | undefined;
  jobId?: string | undefined;
}

export interface RunNotice {
  kind: NotificationKind;
  runId?: string;
  threadId?: string;
  jobId?: string;
}

/**
 * Which events become a notification. `agent.error` carries no thread, so the run store's
 * `threadByRun` is consulted through `threadForRun`; without a thread there is nowhere to tap
 * to, and the notice is dropped. The approval/input topics are matched by string so this
 * compiles before those events exist in the protocol (they are being added in parallel).
 */
export function noticeForEvent(
  event: RunEventLike,
  threadForRun: (runId: string) => string | undefined,
): RunNotice | null {
  const threadOf = (runId: string | undefined) =>
    event.threadId ?? (runId ? threadForRun(runId) : undefined);
  switch (event.topic) {
    case "agent.done": {
      if (!event.runId) return null;
      const threadId = threadOf(event.runId);
      if (!threadId) return null;
      const kind: NotificationKind = event.status === "completed" ? "run.done" : "run.failed";
      return { kind, runId: event.runId, threadId };
    }
    case "agent.error": {
      if (!event.runId) return null;
      const threadId = threadOf(event.runId);
      if (!threadId) return null;
      return { kind: "run.failed", runId: event.runId, threadId };
    }
    case "agent.approval_requested":
    case "agent.input_requested": {
      if (!event.runId) return null;
      const threadId = threadOf(event.runId);
      if (!threadId) return null;
      return { kind: "run.needs_input", runId: event.runId, threadId };
    }
    case "job.done": {
      if (!event.jobId) return null;
      return { kind: "job.done", jobId: event.jobId };
    }
    default:
      return null;
  }
}

/** What the text needs to know; every field is best-effort from the query cache. */
export interface NoticeContext {
  threadTitle?: string | undefined;
  agent?: string | undefined;
  project?: string | undefined;
  coreName: string;
  /** For `job.done`: the job kind, e.g. `route_run`. */
  jobKind?: string | undefined;
}

/** §4.3's table, verbatim, so a local notification reads exactly like the pushed one. */
export function notificationText(
  kind: NotificationKind,
  ctx: NoticeContext,
): { title: string; body: string } {
  const thread = ctx.threadTitle?.trim() || "Chat";
  const agent = ctx.agent?.trim() || "The agent";
  const project = ctx.project?.trim();
  switch (kind) {
    case "run.done":
      return {
        title: `Done · ${thread}`,
        body: `${agent} finished in ${project ?? "a chat"} on ${ctx.coreName}`,
      };
    case "run.failed":
      return {
        title: `Failed · ${thread}`,
        body: `${agent} stopped in ${project ?? "a chat"} — tap to see why`,
      };
    case "run.needs_input":
      return { title: `Needs you · ${thread}`, body: `${agent} is waiting for an answer` };
    case "job.done": {
      const kindLabel = (ctx.jobKind ?? "Job").replace(/[_-]+/g, " ");
      return {
        title: `${kindLabel.charAt(0).toUpperCase()}${kindLabel.slice(1)} finished`,
        body: `${project ?? "A project"} on ${ctx.coreName}`,
      };
    }
  }
}

export type PushTokenKind = "apns" | "fcm";

/**
 * The §4.1 registration body, built from the phone's state. The token is the native one
 * (`getDevicePushTokenAsync`: APNs on iOS, FCM on Android), so its kind is the platform's.
 */
export function pushRegistration(input: {
  pushToken: string;
  platform: "ios" | "android";
  appVersion?: string | undefined;
  prefs: NotificationPrefs;
}): {
  pushToken: string;
  tokenKind: PushTokenKind;
  platform: "ios" | "android";
  appVersion?: string;
  prefs: NotificationPrefs;
} {
  return {
    pushToken: input.pushToken,
    tokenKind: input.platform === "ios" ? "apns" : "fcm",
    platform: input.platform,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    prefs: { ...input.prefs },
  };
}
