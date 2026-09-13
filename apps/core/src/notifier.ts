/**
 * Push notifications to paired phones (docs/mobile-notifications.md §3.2, §4.2, §4.3).
 *
 * Listens to the bus for the handful of events a person in another room cares about, works out
 * which paired devices should hear about each, and hands the messages to fabplane.com
 * (`POST /v1/private/push`, bearer = the daemon's own user session), which forwards them to Expo.
 * One-way and fire-and-forget: no queue, no retries. A missed "run finished" is annoying, not
 * harmful — the phone sees the real state the next time it connects.
 *
 * A device that holds a live `/ws` socket is skipped: the app is up and already saw the event
 * (and, backgrounded with the socket still alive, shows its own local notification).
 */
import {
  PUSH_BATCH_MAX,
  PushResponse,
  type DevicePushPrefs,
  type PushData,
  type PushKind,
  type PushMessage,
} from "@fabdesk/protocol";
import type { AuthFacade } from "./auth-facade";
import type { EventBus, StoredEvent } from "./bus";
import type { Store } from "./db";
import type { DeviceStore, PushTarget } from "./devices";
import { logger, errMsg } from "./log";

export type NotifierDeps = {
  bus: EventBus;
  store: Store;
  devices: DeviceStore;
  auth: AuthFacade;
  /** fabplane.com origin; the outbound call goes to `${apiOrigin}/v1/private/push`. */
  apiOrigin: string;
  coreId: string;
  coreName: string;
  /** Whether a device currently holds an open event socket on either listener. */
  isOnline: (deviceId: string) => boolean;
  /** Tests inject a fetch to capture the outbound call. */
  fetchImpl?: typeof fetch;
  /** Tests: how long the outbound call may take. */
  timeoutMs?: number;
};

/**
 * The topics the Notifier reacts to. `agent.approval_requested` / `agent.input_requested` come
 * from supervised runs (roadmap A1) and may not exist in this build's event union yet, so the
 * subscription is by topic string and the handler reads those events structurally.
 */
export const NOTIFIER_TOPICS = [
  "agent.done",
  "agent.error",
  "agent.approval_requested",
  "agent.input_requested",
  "job.done",
] as const;

/** Job kinds worth a notification: `tool:route_run`, `tool:render_board`, … (`prefs.onJobs`). */
const NOTIFY_JOB_KIND = /^(?:tool:)?(route_run|render_[a-z_]+)$/;

/** Max notifications remembered for dedupe; one per runId (or jobId) per kind. */
const SEEN_MAX = 1000;

type LooseEvent = { topic: string; ts: number } & Record<string, unknown>;

/** A notification before it is addressed to a device. */
export interface PendingNotification {
  kind: PushKind;
  title: string;
  body: string;
  data: PushData;
  /** `${id}:${kind}` — the dedupe key. */
  key: string;
}

export class Notifier {
  private unsubscribe: (() => void) | null = null;
  private readonly seen = new Set<string>();
  private skippedOnce = false;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Outbound calls in flight, so `stop()` (and tests) can wait for them. */
  private inflight = new Set<Promise<void>>();

  constructor(private readonly deps: NotifierDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bus.subscribe(
      [...NOTIFIER_TOPICS],
      (events) => this.onEvents(events),
      { coalesceMs: 0 },
    );
  }

  /** Stops listening. Calls already in flight finish on their own; shutdown does not wait on fabplane.com. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Resolves once every outbound call started so far has finished (tests). */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private onEvents(events: StoredEvent[]): void {
    for (const ev of events) {
      const pending = this.build(ev.event as unknown as LooseEvent);
      if (!pending) continue;
      if (this.seen.has(pending.key)) continue;
      this.remember(pending.key);
      const messages = this.address(pending);
      if (!messages.length) continue;
      for (let i = 0; i < messages.length; i += PUSH_BATCH_MAX)
        this.track(this.send(messages.slice(i, i + PUSH_BATCH_MAX)));
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /* ---------- what to say (§4.3) ---------- */

  /** Turns a bus event into a notification, or null when the event is not one anybody hears about. */
  build(ev: LooseEvent): PendingNotification | null {
    const runId = str(ev["runId"]);
    switch (ev.topic) {
      case "agent.done": {
        const threadId = str(ev["threadId"]);
        if (!runId || !threadId) return null;
        const status = ev["status"];
        return this.runNotification(
          status === "completed" ? "run.done" : "run.failed",
          runId,
          threadId,
        );
      }
      case "agent.error": {
        // Carries no threadId; the run record does. An error mid-run is still worth a tap.
        if (!runId) return null;
        const run = this.deps.store.runs.get(runId);
        return run ? this.runNotification("run.failed", runId, run.threadId) : null;
      }
      case "agent.approval_requested":
      case "agent.input_requested": {
        const threadId =
          str(ev["threadId"]) ?? (runId ? this.deps.store.runs.get(runId)?.threadId : undefined);
        if (!runId || !threadId) return null;
        // One "needs you" per request, not per run: a supervised run can ask several times.
        const requestId = str(ev["requestId"]) ?? runId;
        return this.runNotification("run.needs_input", runId, threadId, `${runId}/${requestId}`);
      }
      case "job.done": {
        const jobId = str(ev["jobId"]);
        if (!jobId) return null;
        const job = this.deps.store.jobs.get(jobId);
        const kind = job ? NOTIFY_JOB_KIND.exec(job.kind)?.[1] : undefined;
        if (!job || !kind) return null;
        const project = job.projectId ? this.deps.store.projects.get(job.projectId) : null;
        const label = kind === "route_run" ? "Routing" : "Render";
        return {
          kind: "job.done",
          key: `${jobId}:job.done`,
          title: clip(`${label} finished`, 80),
          body: clip(`${project?.name ?? "A project"} on ${this.deps.coreName}`, 200),
          data: {
            v: 1,
            kind: "job.done",
            coreId: this.deps.coreId,
            coreName: this.deps.coreName,
            jobId,
            ...(job.projectId ? { projectId: job.projectId } : {}),
          },
        };
      }
      default:
        return null;
    }
  }

  private runNotification(
    kind: Exclude<PushKind, "job.done">,
    runId: string,
    threadId: string,
    dedupeId = runId,
  ): PendingNotification | null {
    const thread = this.deps.store.threads.get(threadId);
    if (!thread) return null;
    const agent = agentName(this.deps.store.runs.get(runId)?.agentId ?? thread.agentId);
    const project = thread.projectId ? this.deps.store.projects.get(thread.projectId) : null;
    const place = project ? project.name : "a chat";
    const text: Record<typeof kind, { title: string; body: string }> = {
      "run.done": {
        title: `Done · ${thread.title}`,
        body: `${agent} finished in ${place} on ${this.deps.coreName}`,
      },
      "run.failed": {
        title: `Failed · ${thread.title}`,
        body: `${agent} stopped in ${place} — tap to see why`,
      },
      "run.needs_input": {
        title: `Needs you · ${thread.title}`,
        body: `${agent} is waiting for an answer`,
      },
    };
    return {
      kind,
      key: `${dedupeId}:${kind}`,
      title: clip(text[kind].title, 80),
      body: clip(text[kind].body, 200),
      data: {
        v: 1,
        kind,
        coreId: this.deps.coreId,
        coreName: this.deps.coreName,
        threadId,
        runId,
        ...(thread.projectId ? { projectId: thread.projectId } : {}),
      },
    };
  }

  /* ---------- whom to tell (§3.2) ---------- */

  /** One message per device that registered for push, is not connected right now, and asked for this kind. */
  address(pending: PendingNotification): PushMessage[] {
    if (!this.deps.store.settings.get().notifications.enabled) return [];
    const out: PushMessage[] = [];
    for (const target of this.deps.devices.pushTargets()) {
      if (this.deps.isOnline(target.device.id)) continue;
      if (!wantsKind(target.prefs, pending.kind)) continue;
      out.push(toMessage(target, pending));
    }
    return out;
  }

  /* ---------- delivery (§4.2) ---------- */

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async send(messages: PushMessage[]): Promise<void> {
    const bearer = this.deps.auth.mode === "local" ? null : this.deps.auth.token();
    if (!bearer) {
      // Local-mode daemons, and fabplane-mode ones nobody has signed in on, cannot push. Say so once.
      if (!this.skippedOnce) {
        this.skippedOnce = true;
        logger.info("push notifications skipped: no fabplane.com session", {
          mode: this.deps.auth.mode,
          devices: messages.length,
        });
      }
      return;
    }
    this.skippedOnce = false;
    const kinds = [...new Set(messages.map((m) => m.data.kind))];
    try {
      const res = await this.fetchImpl(`${this.deps.apiOrigin}/v1/private/push`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        // 429/5xx mean "drop this batch"; 401 means the session is gone and the UI already knows.
        logger.warn("push rejected by fabplane.com", {
          status: res.status,
          count: messages.length,
          kinds,
        });
        return;
      }
      const parsed = PushResponse.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        logger.warn("push response unreadable", { count: messages.length });
        return;
      }
      const failed = parsed.data.tickets
        .map((t, i) => ({ t, i }))
        .filter(({ t }) => t.status === "error");
      for (const { t, i } of failed) {
        if (t.status !== "error") continue;
        logger.warn("push ticket error", {
          kind: messages[i]?.data.kind,
          error: t.details?.error ?? t.message,
        });
      }
      logger.info("push sent", {
        count: messages.length,
        ok: messages.length - failed.length,
        kinds,
      });
    } catch (e) {
      logger.warn("push failed", { error: errMsg(e), count: messages.length, kinds });
    }
  }
}

/* ---------- helpers ---------- */

export function wantsKind(prefs: DevicePushPrefs, kind: PushKind): boolean {
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

function toMessage(target: PushTarget, n: PendingNotification): PushMessage {
  return {
    to: target.token,
    tokenKind: target.tokenKind,
    title: n.title,
    body: n.body,
    data: n.data,
    sound: "default",
    channelId: "runs",
    categoryId: "run",
    priority: "high",
    // A stale "run finished" is worthless after a day.
    ttl: 86_400,
  };
}

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
};

function agentName(id: string): string {
  return AGENT_NAMES[id] ?? id;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
