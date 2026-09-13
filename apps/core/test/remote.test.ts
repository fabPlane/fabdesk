import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOTE_DEFAULT_PORT,
  parsePairingUrl,
  type CoreEvent,
  type Device,
  type EndpointKind,
  type PairClaimResult,
  type PairStartResult,
  type RemoteStatus,
} from "@fabdesk/protocol";
import type { AgentEvent, AgentRun } from "@fabdesk/agents";
import type { CoreServices } from "@fabdesk/tools";
import { listenAddresses } from "../src/net";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

let daemon: Daemon;
let home: string;
/** Bound on loopback so the test never opens a port to the network. */
const REMOTE = { enabled: true, host: "127.0.0.1", port: 47821 };
const remoteUrl = `http://${REMOTE.host}:${REMOTE.port}`;
const FAKE_INTERFACES = {
  en0: [{ address: "192.168.1.24", family: "IPv4", internal: false } as never],
  ts0: [{ address: "100.101.102.103", family: "IPv4", internal: false } as never],
  en1: [{ address: "203.0.113.9", family: "IPv4", internal: false } as never],
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-remote-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "remote-test-token-0123456789";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    quiet: true,
    watchProjects: false,
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "public",
      }) as unknown as CoreServices,
    // Just enough of an agent for `POST /threads/:id/messages` to accept a message.
    adapters: {
      claude: {
        id: "claude",
        run: (): AgentRun => ({
          events: (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: "text", delta: "ok" };
            yield { type: "done", exitCode: 0 };
          })(),
          abort() {},
        }),
      },
    },
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
});

afterAll(async () => {
  await daemon.close("tests done");
});

const H = () => ({ authorization: `Bearer ${daemon.token}`, "content-type": "application/json" });
const local = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, { ...init, headers: { ...H(), ...(init.headers ?? {}) } });
const enableRemote = () =>
  local("/settings", { method: "PATCH", body: JSON.stringify({ remote: REMOTE }) });

describe("remote listener", () => {
  test("is off until the setting turns it on", async () => {
    const settings = (await (await local("/settings")).json()) as { remote: typeof REMOTE };
    expect(settings.remote).toEqual({ enabled: false, host: "0.0.0.0", port: REMOTE_DEFAULT_PORT });
    expect((await (await local("/v1/remote")).json()) as { enabled: boolean }).toMatchObject({
      enabled: false,
    });
    expect(fetch(`${remoteUrl}/health`)).rejects.toThrow();
  });

  test("advertises the addresses a phone would try, and a loopback bind is called out as such", async () => {
    // Off, wildcard bind: whatever real interfaces this machine has, none is loopback and the
    // first one is the default. (A CI box with no network gets an empty list, which is also right.)
    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, enabled: false, host: "0.0.0.0" } }),
    });
    const wildcard = (await (await local("/v1/remote")).json()) as RemoteStatus;
    expect(wildcard.endpoints.every((e) => e.kind !== "loopback")).toBe(true);
    expect(wildcard.endpoints.map((e) => e.default)).toEqual(
      wildcard.endpoints.map((_, i) => i === 0),
    );

    // Bound to loopback: exactly one endpoint, flagged so the UI can warn before anyone scans.
    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, enabled: false } }),
    });
    const loop = (await (await local("/v1/remote")).json()) as RemoteStatus;
    expect(loop.endpoints).toEqual([
      { host: "127.0.0.1", port: REMOTE.port, kind: "loopback", iface: "lo0", default: true },
    ]);
    expect(loop.setting.preferredEndpointKind).toBeUndefined();
    await enableRemote();
  });

  test("preferredEndpointKind reorders the advertised endpoints and the pairing URL", async () => {
    // Loopback is the only address this test can bind, so the ordering is checked on the pure
    // helper with a fixed set of interfaces; the setting round-trip is checked on the daemon.
    const kinds = (preferred: EndpointKind | null) =>
      listenAddresses(1, { preferred, interfaces: FAKE_INTERFACES }).map((e) => e.kind);
    expect(kinds(null)).toEqual(["tailscale", "lan", "other"]);
    expect(kinds("lan")).toEqual(["lan", "tailscale", "other"]);
    expect(kinds("other")).toEqual(["other", "tailscale", "lan"]);
    expect(kinds("loopback")).toEqual(["tailscale", "lan", "other"]);

    const patched = (await (
      await local("/settings", {
        method: "PATCH",
        body: JSON.stringify({ remote: { ...REMOTE, preferredEndpointKind: "lan" } }),
      })
    ).json()) as { remote: { preferredEndpointKind?: string | null } };
    expect(patched.remote.preferredEndpointKind).toBe("lan");
    expect(
      (
        await local("/settings", {
          method: "PATCH",
          body: JSON.stringify({ remote: { ...REMOTE, preferredEndpointKind: "wifi" } }),
        })
      ).status,
    ).toBe(400);
    const status = (await (await local("/v1/remote")).json()) as RemoteStatus;
    expect(status.setting.preferredEndpointKind).toBe("lan");
    // Changing only the preference must not rebind the listener.
    expect(status).toMatchObject({ enabled: true, host: REMOTE.host, port: REMOTE.port });

    // The URL lists the default endpoint first, with a parallel `k=` list old phones ignore.
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    expect(start.endpoints.filter((e) => e.default)).toHaveLength(1);
    const parsed = parsePairingUrl(start.url);
    expect(parsed?.hosts[0]).toBe(start.endpoints.find((e) => e.default)?.host);
    expect(parsed?.kinds).toEqual(start.endpoints.map((e) => e.kind));
    expect(start.url).toMatch(/&h=127\.0\.0\.1&k=loopback&c=core_[A-Za-z0-9]+$/);
    expect(parsed?.coreId).toBe(daemon.store.settings.coreId());
    await local("/v1/devices/pair/cancel", { method: "POST" });
    // Sending null, or leaving the key out, both unset the preference.
    for (const remote of [{ ...REMOTE, preferredEndpointKind: null }, REMOTE]) {
      const res = (await (
        await local("/settings", { method: "PATCH", body: JSON.stringify({ remote }) })
      ).json()) as { remote: { preferredEndpointKind?: string | null } };
      expect(res.remote.preferredEndpointKind ?? undefined).toBeUndefined();
    }
  });

  test("a settings patch binds it without restarting the daemon", async () => {
    expect((await enableRemote()).status).toBe(200);
    expect((await (await local("/v1/remote")).json()) as object).toMatchObject({
      enabled: true,
      host: REMOTE.host,
      port: REMOTE.port,
    });
    const health = (await (await fetch(`${remoteUrl}/health`)).json()) as {
      ok: boolean;
      pid: number;
    };
    expect(health.ok).toBe(true);
    expect(health.pid).toBe(process.pid);
  });

  test("still wants a token, and the daemon token works on it", async () => {
    expect((await fetch(`${remoteUrl}/projects`)).status).toBe(401);
    expect((await fetch(`${remoteUrl}/projects`, { headers: H() })).status).toBe(200);
  });

  test("does not serve mcp, shutdown or device administration", async () => {
    for (const [path, init] of [
      ["/mcp/sessions", {}],
      ["/shutdown", { method: "POST" }],
      ["/v1/devices", {}],
      ["/v1/devices/pair/start", { method: "POST" }],
      ["/v1/remote/tailscale-serve", { method: "POST", body: JSON.stringify({ enabled: true }) }],
    ] as const) {
      const res = await fetch(`${remoteUrl}${path}`, { ...init, headers: H() });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    // …all of which the local listener does serve.
    expect((await local("/mcp/sessions")).status).toBe(200);
    expect((await local("/v1/devices")).status).toBe(200);
  });

  test("does serve a device's own routes — they are not administration", async () => {
    // With the daemon token they answer 403 (not a device), which proves they are routed, not hidden.
    for (const [path, init] of [
      ["/v1/devices/me", {}],
      ["/v1/devices/me/push", { method: "PUT", body: "{}" }],
      ["/v1/devices/me/push", { method: "DELETE" }],
    ] as const) {
      const res = await fetch(`${remoteUrl}${path}`, { ...init, headers: H() });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  test("turning the setting off unbinds it", async () => {
    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, enabled: false } }),
    });
    expect(fetch(`${remoteUrl}/health`)).rejects.toThrow();
    await enableRemote();
  });
});

describe("pairing over http", () => {
  test("a phone claims a code on the remote listener and gets a working token", async () => {
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    expect(parsePairingUrl(start.url)?.token).toBe(start.pairingToken);
    expect(start.code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);

    // The claim carries no bearer token — the pairing token is the credential.
    const res = await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingToken: start.pairingToken,
        label: "Maya's iPhone",
        platform: "ios",
      }),
    });
    expect(res.status).toBe(200);
    const claim = (await res.json()) as PairClaimResult;
    expect(claim.device.label).toBe("Maya's iPhone");
    // The daemon's stable identity rides along, and matches what /health says.
    const health = (await (await fetch(`${remoteUrl}/health`)).json()) as { coreId: string };
    expect(claim.core.coreId).toBe(health.coreId);
    expect(health.coreId).toMatch(/^core_/);

    const asDevice = await fetch(`${remoteUrl}/projects`, {
      headers: { authorization: `Bearer ${claim.deviceToken}` },
    });
    expect(asDevice.status).toBe(200);
    // A device sees itself, with no push registration until it makes one.
    const me = await fetch(`${remoteUrl}/v1/devices/me`, {
      headers: { authorization: `Bearer ${claim.deviceToken}` },
    });
    expect(me.status).toBe(200);
    expect((await me.json()) as object).toMatchObject({ id: claim.device.id, push: null });

    const devices = (await (await local("/v1/devices")).json()) as Device[];
    expect(devices.map((d) => d.id)).toContain(claim.device.id);
    expect(devices.find((d) => d.id === claim.device.id)?.lastSeenAt).not.toBeNull();
  });

  test("the event socket admits a native client's own-host Origin and nothing foreign", async () => {
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    const claim = (await (
      await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingToken: start.pairingToken,
          label: "ws phone",
          platform: "android",
        }),
      })
    ).json()) as PairClaimResult;
    const wsUrl = `ws://${REMOTE.host}:${REMOTE.port}/ws?topics=agent.*&token=${encodeURIComponent(claim.deviceToken)}`;

    const open = (headers: Record<string, string>) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(wsUrl, { headers } as never);
        ws.onopen = () => {
          ws.close();
          resolve(true);
        };
        ws.onerror = () => resolve(false);
        ws.onclose = () => resolve(false);
      });

    // React Native's WebSocket sends the URL's own host as its Origin; a bare client sends none.
    expect(await open({})).toBe(true);
    expect(await open({ origin: `http://${REMOTE.host}:${REMOTE.port}` })).toBe(true);
    expect(await open({ origin: "http://evil.example" })).toBe(false);
    expect(await open({ origin: `http://${REMOTE.host}:${REMOTE.port + 1}` })).toBe(false);
  });

  test("a bad or reused code is rejected", async () => {
    const res = await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingToken: "nope", label: "attacker", platform: "other" }),
    });
    expect(res.status).toBe(401);
  });

  test("revoking a device kills its token", async () => {
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    const claim = (await (
      await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingToken: start.pairingToken,
          label: "Old Pixel",
          platform: "android",
        }),
      })
    ).json()) as PairClaimResult;
    expect(
      (
        await fetch(`${remoteUrl}/projects`, {
          headers: { authorization: `Bearer ${claim.deviceToken}` },
        })
      ).status,
    ).toBe(200);

    expect((await local(`/v1/devices/${claim.device.id}`, { method: "DELETE" })).status).toBe(200);
    expect(
      (
        await fetch(`${remoteUrl}/projects`, {
          headers: { authorization: `Bearer ${claim.deviceToken}` },
        })
      ).status,
    ).toBe(401);
  });

  test("a paired phone sees thread lifecycle events for what other clients do", async () => {
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    const claim = (await (
      await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingToken: start.pairingToken,
          label: "events phone",
          platform: "ios",
        }),
      })
    ).json()) as PairClaimResult;

    // The phone listens on the remote socket; the "desktop" acts through the loopback listener.
    const received: CoreEvent[] = [];
    const ws = new WebSocket(
      `ws://${REMOTE.host}:${REMOTE.port}/ws?topics=thread.*&token=${encodeURIComponent(claim.deviceToken)}`,
    );
    ws.onmessage = (m) => received.push((JSON.parse(String(m.data)) as { event: CoreEvent }).event);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    const waitFor = async (pred: () => boolean) => {
      const deadline = Date.now() + 3000;
      while (!pred() && Date.now() < deadline) await Bun.sleep(10);
      expect(pred()).toBe(true);
    };
    const ofTopic = <T extends CoreEvent["topic"]>(topic: T) =>
      received.filter((e): e is Extract<CoreEvent, { topic: T }> => e.topic === topic);

    const thread = (await (
      await local("/threads", { method: "POST", body: JSON.stringify({ agentId: "claude" }) })
    ).json()) as { id: string; title: string };
    await waitFor(() => ofTopic("thread.created").length === 1);
    expect(ofTopic("thread.created")[0]).toMatchObject({ threadId: thread.id, projectId: null });

    // The first message names a "New chat"; the daemon does that on its own and must say so.
    const sent = await local(`/threads/${thread.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "  Design a   blinky board  " }),
    });
    expect(sent.status).toBe(202);
    await waitFor(() => ofTopic("thread.updated").some((e) => e.title !== undefined));
    expect(ofTopic("thread.updated").find((e) => e.title !== undefined)).toMatchObject({
      threadId: thread.id,
      title: "Design a blinky board",
    });

    // A rename through PATCH carries the new title too; a pin does not pretend to.
    received.length = 0;
    await local(`/threads/${thread.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Blinky" }),
    });
    await local(`/threads/${thread.id}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned: true }),
    });
    await waitFor(() => ofTopic("thread.updated").length >= 2);
    expect(ofTopic("thread.updated").map((e) => e.title)).toEqual(["Blinky", undefined]);

    received.length = 0;
    expect((await local(`/threads/${thread.id}`, { method: "DELETE" })).status).toBe(200);
    await waitFor(() => ofTopic("thread.deleted").length === 1);
    expect(ofTopic("thread.deleted")[0]).toMatchObject({ threadId: thread.id });
    // Deleting again is a 404 and announces nothing.
    expect((await local(`/threads/${thread.id}`, { method: "DELETE" })).status).toBe(404);
    await Bun.sleep(50);
    expect(ofTopic("thread.deleted")).toHaveLength(1);
    ws.close();
  });

  test("device tokens survive nothing but the database — they are not the daemon token", async () => {
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    const claim = (await (
      await fetch(`${remoteUrl}/v1/devices/pair/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingToken: start.pairingToken, label: "iPad", platform: "ios" }),
      })
    ).json()) as PairClaimResult;
    expect(claim.deviceToken).not.toBe(daemon.token);
  });
});
