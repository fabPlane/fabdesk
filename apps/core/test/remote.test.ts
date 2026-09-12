import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOTE_DEFAULT_PORT,
  parsePairingUrl,
  type Device,
  type PairClaimResult,
  type PairStartResult,
} from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

let daemon: Daemon;
let home: string;
/** Bound on loopback so the test never opens a port to the network. */
const REMOTE = { enabled: true, host: "127.0.0.1", port: 47821 };
const remoteUrl = `http://${REMOTE.host}:${REMOTE.port}`;

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
    adapters: {},
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
    ] as const) {
      const res = await fetch(`${remoteUrl}${path}`, { ...init, headers: H() });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    // …all of which the local listener does serve.
    expect((await local("/mcp/sessions")).status).toBe(200);
    expect((await local("/v1/devices")).status).toBe(200);
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

    const asDevice = await fetch(`${remoteUrl}/projects`, {
      headers: { authorization: `Bearer ${claim.deviceToken}` },
    });
    expect(asDevice.status).toBe(200);

    const devices = (await (await local("/v1/devices")).json()) as Device[];
    expect(devices.map((d) => d.id)).toContain(claim.device.id);
    expect(devices.find((d) => d.id === claim.device.id)?.lastSeenAt).not.toBeNull();
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
