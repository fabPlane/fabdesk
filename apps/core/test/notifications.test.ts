/**
 * Push notifications, daemon half (docs/mobile-notifications.md §4.1, §4.2, §6): a real daemon in
 * fabplane auth mode over HTTP, a phone paired on the remote listener, and the outbound
 * `POST /v1/private/push` captured through an injected fetch instead of reaching fabplane.com.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DeviceMe,
  DevicePushPrefs,
  DevicePushResult,
  Health,
  PairClaimResult,
  PairStartResult,
  PushRequest,
  Settings,
} from "@fabdesk/protocol";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { CoreServices } from "@fabdesk/tools";
import { machineName } from "../src/net";
import { serve, type Daemon, type ServeOptions } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

/** Where the daemon believes fabplane.com is. Nothing listens there; the injected fetch answers instead. */
const API_ORIGIN = "http://127.0.0.1:1";
const SESSION_TOKEN = "fpd_test_session_token";
const REMOTE = { enabled: true, host: "127.0.0.1", port: 47822 };
const remoteUrl = `http://${REMOTE.host}:${REMOTE.port}`;
const TOKEN_A = "a".repeat(64); // an APNs device token
const TOKEN_FCM = `${"f".repeat(22)}:APA91b${"x".repeat(60)}`;

type Captured = { url: string; authorization: string | null; body: PushRequest };
const sent: Captured[] = [];
const okTickets = (body: PushRequest) =>
  Response.json({ tickets: body.messages.map((_, i) => ({ status: "ok", id: `ticket-${i}` })) });
/** What "fabplane.com" answers; tests swap it to simulate a rejection. */
let respond: (body: PushRequest) => Response = okTickets;
/** What `GET /v1/private/push/:jobId` answers; tests set it alongside a `queued` response. */
let respondJob: (jobId: string) => Response = () =>
  Response.json({ error: "not found" }, { status: 404 });
const verdictsAsked: string[] = [];
const pushFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  if (!init?.body) {
    const jobId = url.slice(url.lastIndexOf("/") + 1);
    verdictsAsked.push(jobId);
    return respondJob(jobId);
  }
  const body = JSON.parse(String(init.body)) as PushRequest;
  sent.push({ url, authorization: headers.get("authorization"), body });
  return respond(body);
};

/** An "agent" whose outcome the prompt picks: `fail` exits 1, `error` also emits an error first. */
const adapters: NonNullable<ServeOptions["adapters"]> = {
  claude: {
    id: "claude",
    run: (session: AgentSession): AgentRun => ({
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "text", delta: "ok" };
        if (session.prompt.includes("error")) yield { type: "error", message: "boom" };
        yield { type: "done", exitCode: /fail|error/.test(session.prompt) ? 1 : 0 };
      })(),
      abort() {},
    }),
  },
};

const baseOptions = (home: string): ServeOptions => ({
  port: 0,
  dataDir: home,
  handshakeFile: join(home, "daemon.json"),
  quiet: true,
  watchProjects: false,
  notifierFetch: pushFetch,
  notifierVerdictDelayMs: 10,
  services: async ({ projects, bus, store }) =>
    mockServices([], {
      projects,
      bus: { emit: (e) => bus.emit(e) },
      routeRuns: store.routeRuns,
      channel: "public",
    }) as unknown as CoreServices,
  adapters,
  doctor: async () => ({
    version: "t",
    channel: "public",
    bun: Bun.version,
    platform: "test",
    kicad: { found: false },
    ngspice: { found: false },
    routers: [],
    agents: [],
    warnings: [],
  }),
});

let daemon: Daemon;
let home: string;
let claim: PairClaimResult;
let projectId: string;
let threadId: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-notify-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "notify-test-token-0123456789";
  process.env["FABPLANE_API_ORIGIN"] = API_ORIGIN;
  delete process.env["FABDESK_AUTH_MODE"];
  // A signed-in fabplane session: the auth client trusts the file when `/v1/auth/me` is unreachable.
  await writeFile(
    join(home, "credentials.json"),
    JSON.stringify({
      version: 1,
      apiOrigin: API_ORIGIN,
      token: SESSION_TOKEN,
      subject: "user_test",
      handle: "maya",
      obtainedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
  daemon = await serve({ ...baseOptions(home), localAuth: false });
  await local("/settings", { method: "PATCH", body: JSON.stringify({ remote: REMOTE }) });

  const project = (await (
    await local("/projects", { method: "POST", body: JSON.stringify({ name: "Blinky" }) })
  ).json()) as { id: string };
  projectId = project.id;
  const thread = (await (
    await local("/threads", {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", projectId, title: "LED driver" }),
    })
  ).json()) as { id: string };
  threadId = thread.id;
  claim = await pair("Maya's iPhone");
});

afterAll(async () => {
  await daemon.close("tests done");
});

const H = () => ({ authorization: `Bearer ${daemon.token}`, "content-type": "application/json" });
const local = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, { ...init, headers: { ...H(), ...(init.headers ?? {}) } });
const asDevice = (path: string, init: RequestInit = {}, token = claim.deviceToken) =>
  fetch(`${remoteUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

async function pair(label: string): Promise<PairClaimResult> {
  const start = (await (
    await local("/v1/devices/pair/start", { method: "POST" })
  ).json()) as PairStartResult;
  const res = await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairingToken: start.pairingToken, label, platform: "ios" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PairClaimResult;
}

const register = (prefs: Partial<DevicePushPrefs> = {}, token = claim.deviceToken) =>
  asDevice(
    "/v1/devices/me/push",
    { method: "PUT", body: JSON.stringify({ pushToken: TOKEN_A, platform: "ios", prefs }) },
    token,
  );

/** Sends a message on the thread and waits for its run to end, then for the Notifier to finish talking. */
async function runOnce(
  d: Daemon,
  thread: string,
  content: string,
): Promise<{ runId: string; status: string }> {
  const done = new Promise<{ runId: string; status: string }>((resolve) => {
    const unsub = d.bus.subscribe(["agent.done"], (events) => {
      for (const ev of events) {
        if (ev.event.topic !== "agent.done" || ev.event.threadId !== thread) continue;
        unsub();
        resolve({ runId: ev.event.runId, status: ev.event.status });
      }
    });
  });
  const res = await fetch(`${d.url}/threads/${thread}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(202);
  const result = await done;
  await d.notifier.settle();
  return result;
}

describe("coreId", () => {
  test("is on /health, in pair/claim, and stable", async () => {
    const health = (await (await fetch(`${remoteUrl}/health`)).json()) as Health;
    expect(health.coreId).toMatch(/^core_[A-Za-z0-9]{12}$/);
    expect(claim.core.coreId).toBe(health.coreId);
    expect(daemon.store.settings.coreId()).toBe(health.coreId);
    // It is not a user setting: patching settings leaves it alone.
    await local("/settings", { method: "PATCH", body: JSON.stringify({ theme: "dark" }) });
    expect(((await (await local("/health")).json()) as Health).coreId).toBe(health.coreId);
  });
});

describe("settings", () => {
  test("a partial PATCH changes only what it names", async () => {
    // The phone patches `notifications` alone; that must not reset the remote listener (or the theme).
    const before = (await (await local("/settings")).json()) as Settings;
    expect(before.remote).toEqual(REMOTE);
    const after = (await (
      await local("/settings", {
        method: "PATCH",
        body: JSON.stringify({ notifications: { enabled: true } }),
      })
    ).json()) as Settings;
    expect(after.remote).toEqual(REMOTE);
    expect(after.theme).toBe(before.theme);
    expect((await fetch(`${remoteUrl}/health`)).status).toBe(200);
  });
});

describe("push registration", () => {
  test("a device registers on the remote listener and sees it on /v1/devices/me", async () => {
    const before = (await (await asDevice("/v1/devices/me")).json()) as DeviceMe;
    expect(before).toMatchObject({ id: claim.device.id, label: "Maya's iPhone", push: null });

    const res = await register({ onJobs: true });
    expect(res.status).toBe(200);
    const result = (await res.json()) as DevicePushResult;
    expect(result.device.id).toBe(claim.device.id);
    expect(Date.parse(result.push.registeredAt)).toBeGreaterThan(Date.now() - 5000);

    const me = (await (await asDevice("/v1/devices/me")).json()) as DeviceMe;
    expect(me.push).toEqual({
      registeredAt: result.push.registeredAt,
      platform: "ios",
      tokenKind: "apns",
      prefs: { onDone: true, onFailed: true, onNeedsInput: true, onJobs: true },
    });
    // The token itself is never echoed back.
    expect(JSON.stringify(me)).not.toContain(TOKEN_A);
  });

  test("a bad token shape is a 400, and the daemon token is not a device", async () => {
    const bad = await asDevice("/v1/devices/me/push", {
      method: "PUT",
      body: JSON.stringify({ pushToken: "not-a-token", platform: "ios" }),
    });
    expect(bad.status).toBe(400);
    expect((await local("/v1/devices/me")).status).toBe(403);
    expect(
      (
        await local("/v1/devices/me/push", {
          method: "PUT",
          body: JSON.stringify({ pushToken: TOKEN_A, platform: "ios" }),
        })
      ).status,
    ).toBe(403);
    // Served on the local listener too (the simulator pairs over loopback).
    const viaLocal = await fetch(`${daemon.url}/v1/devices/me`, {
      headers: { authorization: `Bearer ${claim.deviceToken}` },
    });
    expect(viaLocal.status).toBe(200);
  });

  test("an FCM token registers as fcm without saying so", async () => {
    const res = await asDevice("/v1/devices/me/push", {
      method: "PUT",
      body: JSON.stringify({ pushToken: TOKEN_FCM, platform: "android" }),
    });
    expect(res.status).toBe(200);
    const me = (await (await asDevice("/v1/devices/me")).json()) as {
      push?: { tokenKind?: string };
    };
    expect(me.push?.tokenKind).toBe("fcm");
    await register(); // back to the APNs token the rest of the file expects
  });

  test("DELETE clears it", async () => {
    expect((await asDevice("/v1/devices/me/push", { method: "DELETE" })).status).toBe(200);
    const me = (await (await asDevice("/v1/devices/me")).json()) as DeviceMe;
    expect(me.push).toBeNull();
  });

  test("revoking the device clears it too", async () => {
    const other = await pair("Old Pixel");
    expect((await register({}, other.deviceToken)).status).toBe(200);
    expect((await local(`/v1/devices/${other.device.id}`, { method: "DELETE" })).status).toBe(200);
    const row = daemon.store.db
      .query<
        { push_token: string | null; push_prefs: string | null; revoked_at: string | null },
        [string]
      >("SELECT push_token, push_prefs, revoked_at FROM devices WHERE id = ?")
      .get(other.device.id);
    expect(row).toEqual({ push_token: null, push_prefs: null, revoked_at: expect.any(String) });
  });
});

describe("notifier", () => {
  test("a completed run is exactly one POST /v1/private/push with the §4.2 shape", async () => {
    sent.length = 0;
    expect((await register()).status).toBe(200);
    const { runId, status } = await runOnce(daemon, threadId, "make it blink");
    expect(status).toBe("completed");

    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call?.url).toBe(`${API_ORIGIN}/v1/private/push`);
    expect(call?.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    const coreName = machineName();
    expect(call?.body).toEqual({
      messages: [
        {
          to: TOKEN_A,
          tokenKind: "apns",
          title: "Done · LED driver",
          body: `Claude finished in Blinky on ${coreName}`,
          data: {
            v: 1,
            kind: "run.done",
            coreId: daemon.store.settings.coreId(),
            coreName,
            threadId,
            runId,
            projectId,
          },
          sound: "default",
          channelId: "runs",
          categoryId: "run",
          priority: "high",
          ttl: 86_400,
        },
      ],
    });
  });

  test("a failed run says so once, even when agent.error preceded agent.done", async () => {
    sent.length = 0;
    const { runId, status } = await runOnce(daemon, threadId, "please error out");
    expect(status).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.messages).toHaveLength(1);
    expect(sent[0]?.body.messages[0]).toMatchObject({
      title: "Failed · LED driver",
      body: `Claude stopped in Blinky — tap to see why`,
      data: { kind: "run.failed", runId, threadId },
    });
  });

  test("a chat without a project says 'a chat'", async () => {
    sent.length = 0;
    const bare = (await (
      await local("/threads", {
        method: "POST",
        body: JSON.stringify({ agentId: "claude", title: "Quick question" }),
      })
    ).json()) as { id: string };
    await runOnce(daemon, bare.id, "hi");
    expect(sent[0]?.body.messages[0]).toMatchObject({
      title: "Done · Quick question",
      body: `Claude finished in a chat on ${machineName()}`,
    });
    expect(sent[0]?.body.messages[0]?.data).not.toHaveProperty("projectId");
  });

  test("no POST while the device's event socket is open", async () => {
    sent.length = 0;
    const ws = new WebSocket(
      `ws://${REMOTE.host}:${REMOTE.port}/ws?topics=agent.*&token=${encodeURIComponent(claim.deviceToken)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    await runOnce(daemon, threadId, "while connected");
    expect(sent).toHaveLength(0);

    // Closing the socket makes the phone reachable by push again.
    const closed = new Promise<void>((resolve) => (ws.onclose = () => resolve()));
    ws.close();
    await closed;
    await Bun.sleep(20);
    await runOnce(daemon, threadId, "after disconnect");
    expect(sent).toHaveLength(1);
  });

  test("no POST when notifications are switched off on the daemon", async () => {
    sent.length = 0;
    const off = (await (
      await local("/settings", {
        method: "PATCH",
        body: JSON.stringify({ notifications: { enabled: false } }),
      })
    ).json()) as Settings;
    expect(off.notifications).toEqual({ enabled: false });
    await runOnce(daemon, threadId, "quietly");
    expect(sent).toHaveLength(0);
    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ notifications: { enabled: true } }),
    });
  });

  test("prefs are respected per kind", async () => {
    sent.length = 0;
    expect((await register({ onDone: false, onFailed: true })).status).toBe(200);
    await runOnce(daemon, threadId, "done but muted");
    expect(sent).toHaveLength(0);
    await runOnce(daemon, threadId, "fail loudly");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.messages[0]?.data.kind).toBe("run.failed");

    sent.length = 0;
    expect((await register({ onDone: true, onFailed: false })).status).toBe(200);
    await runOnce(daemon, threadId, "fail quietly");
    expect(sent).toHaveLength(0);
  });

  test("job.done goes out only with onJobs, and only for long jobs", async () => {
    const job = (kind: string) =>
      new Promise<void>((resolve) => {
        const { id } = daemon.jobs.enqueue({
          kind,
          jobClass: "default",
          projectId,
          run: async () => ({ ok: true }),
        });
        const unsub = daemon.bus.subscribe(["job.done"], (events) => {
          if (!events.some((e) => e.event.topic === "job.done" && e.event.jobId === id)) return;
          unsub();
          resolve();
        });
      });

    sent.length = 0;
    expect((await register({ onJobs: false })).status).toBe(200);
    await job("tool:route_run");
    await daemon.notifier.settle();
    expect(sent).toHaveLength(0);

    expect((await register({ onJobs: true })).status).toBe(200);
    await job("tool:route_run");
    await job("tool:render_board");
    await job("tool:drc_run");
    await daemon.notifier.settle();
    expect(sent.map((s) => s.body.messages[0]?.title)).toEqual([
      "Routing finished",
      "Render finished",
    ]);
    expect(sent[0]?.body.messages[0]).toMatchObject({
      body: `Blinky on ${machineName()}`,
      data: { v: 1, kind: "job.done", projectId, jobId: expect.any(String) },
    });
    expect(sent[0]?.body.messages[0]?.data).not.toHaveProperty("runId");
  });

  test("a supervised run's approval request is a 'needs you' (read structurally)", async () => {
    sent.length = 0;
    expect((await register()).status).toBe(200);
    const run = daemon.store.runs.create({ threadId, agentId: "claude" });
    // Not in this build's CoreEvent union yet; the bus validates, so go through the Notifier directly.
    const pending = daemon.notifier.build({
      topic: "agent.approval_requested",
      ts: Date.now(),
      runId: run.id,
      threadId,
      requestId: "req_1",
      tool: "Bash",
      input: {},
      summary: "rm -rf build",
    });
    expect(pending).toMatchObject({
      kind: "run.needs_input",
      key: `${run.id}/req_1:run.needs_input`,
      title: "Needs you · LED driver",
      body: "Claude is waiting for an answer",
      data: { kind: "run.needs_input", runId: run.id, threadId, projectId },
    });
    expect(daemon.notifier.address(pending!).map((a) => a.message.to)).toEqual([TOKEN_A]);
  });

  test("after DELETE nothing goes out", async () => {
    sent.length = 0;
    expect((await asDevice("/v1/devices/me/push", { method: "DELETE" })).status).toBe(200);
    await runOnce(daemon, threadId, "nobody listening");
    expect(sent).toHaveLength(0);
  });

  test("a queued batch is followed up, and a dead token is forgotten", async () => {
    sent.length = 0;
    verdictsAsked.length = 0;
    expect((await register()).status).toBe(200);
    respond = (body) =>
      Response.json({
        tickets: body.messages.map(() => ({ status: "ok", id: "job-7" })),
        queued: { jobId: "job-7", expiresAt: new Date(Date.now() + 600_000).toISOString() },
      });
    let asks = 0;
    respondJob = (jobId) =>
      Response.json(
        ++asks === 1
          ? { jobId, status: "running", outcomes: [] }
          : {
              jobId,
              status: "completed",
              outcomes: [
                {
                  index: 0,
                  provider: "apns",
                  outcome: "device_not_registered",
                  error: "DeviceNotRegistered",
                },
              ],
            },
      );
    try {
      await runOnce(daemon, threadId, "phone was wiped");
    } finally {
      respond = okTickets;
      respondJob = () => Response.json({ error: "not found" }, { status: 404 });
    }
    expect(sent).toHaveLength(1);
    // Asked while running, asked again, then acted on the verdict.
    expect(verdictsAsked).toEqual(["job-7", "job-7"]);
    const me = (await (await asDevice("/v1/devices/me")).json()) as DeviceMe;
    expect(me.push).toBeNull();
    // With the token gone the next run has nobody to tell.
    await runOnce(daemon, threadId, "nobody left");
    expect(sent).toHaveLength(1);
  });

  test("a rejected batch is dropped, not retried", async () => {
    sent.length = 0;
    expect((await register()).status).toBe(200);
    respond = () =>
      Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "30" } });
    try {
      await runOnce(daemon, threadId, "over the limit");
    } finally {
      respond = okTickets;
    }
    expect(sent).toHaveLength(1);
    // The next event goes out as usual: a 429 does not switch anything off.
    await runOnce(daemon, threadId, "back under");
    expect(sent).toHaveLength(2);
  });
});

describe("local auth mode", () => {
  test("registers devices but never posts", async () => {
    const localHome = await mkdtemp(join(tmpdir(), "fabdesk-notify-local-"));
    // A public build only honours local auth mode with the dev marker in place.
    await writeFile(join(localHome, ".fabdesk-dev"), "");
    const calls: Captured[] = [];
    const d = await serve({
      ...baseOptions(localHome),
      localAuth: true,
      notifierFetch: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: null,
          body: JSON.parse(String(init?.body)) as PushRequest,
        });
        return Response.json({ tickets: [] });
      },
    });
    try {
      const localRemote = { enabled: true, host: "127.0.0.1", port: 47823 };
      const h = { authorization: `Bearer ${d.token}`, "content-type": "application/json" };
      await fetch(`${d.url}/settings`, {
        method: "PATCH",
        headers: h,
        body: JSON.stringify({ remote: localRemote }),
      });
      const start = (await (
        await fetch(`${d.url}/v1/devices/pair/start`, { method: "POST", headers: h })
      ).json()) as PairStartResult;
      const c = (await (
        await fetch(`http://127.0.0.1:${localRemote.port}/v1/devices/pair/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairingToken: start.pairingToken, label: "sim", platform: "ios" }),
        })
      ).json()) as PairClaimResult;
      const reg = await fetch(`http://127.0.0.1:${localRemote.port}/v1/devices/me/push`, {
        method: "PUT",
        headers: { authorization: `Bearer ${c.deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ pushToken: TOKEN_A, platform: "ios" }),
      });
      expect(reg.status).toBe(200);
      const thread = (await (
        await fetch(`${d.url}/threads`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({ agentId: "claude" }),
        })
      ).json()) as { id: string };
      const { status } = await runOnce(d, thread.id, "local only");
      expect(status).toBe("completed");
      expect(calls).toHaveLength(0);
    } finally {
      await d.close("local done");
    }
  });
});
