import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePairingUrl,
  REMOTE_DEFAULT_PORT,
  type Device,
  type PairClaimResult,
  type PairStartResult,
} from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { resolveConfig } from "../src/config";
import { connectToDaemon, daemonClient, type Io } from "../src/cli/daemon";
import { devicesCommand, formatDevices, parseDevicesArgs } from "../src/cli/devices";
import { formatPairing, pairCommand, parsePairArgs } from "../src/cli/pair";
import { persistRemoteFlags, remoteSettingFromFlags } from "../src/cli/remote";
import { parseArgs } from "../src/main";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

const DEFAULT_REMOTE = { enabled: false, host: "0.0.0.0", port: REMOTE_DEFAULT_PORT };

/** Captures both streams; `text()` is everything in order for assertions that span them. */
function capture() {
  const out: string[] = [];
  const all: string[] = [];
  const io: Io = {
    out: (s) => {
      out.push(s);
      all.push(s);
    },
    err: (s) => all.push(s),
  };
  return { io, stdout: () => out.join(""), text: () => all.join("") };
}

describe("argument parsing", () => {
  test("serve --remote and its --remote-* flags sit beside the loopback listener's own", () => {
    const f = parseArgs([
      "serve",
      "--port",
      "0",
      "--remote",
      "--remote-port",
      "47821",
      "--data-dir",
      "/tmp/x",
    ]);
    expect(f._).toEqual(["serve"]);
    expect(f["port"]).toBe("0");
    expect(f["remote"]).toBe(true);
    expect(f["remote-port"]).toBe("47821");
    expect(f["data-dir"]).toBe("/tmp/x");
    expect(parseArgs(["serve", "--remote-host=0.0.0.0"])["remote-host"]).toBe("0.0.0.0");
  });

  test("devices and pair positionals and switches", () => {
    expect(parseDevicesArgs(parseArgs(["devices"])._, {})).toEqual({
      sub: undefined,
      id: undefined,
      json: false,
    });
    const revoke = parseArgs(["devices", "revoke", "dev_123", "--json"]);
    expect(parseDevicesArgs(revoke._, revoke)).toEqual({
      sub: "revoke",
      id: "dev_123",
      json: true,
    });
    expect(parsePairArgs(parseArgs(["pair"]))).toEqual({ json: false, wait: true, invert: false });
    expect(parsePairArgs(parseArgs(["pair", "--no-wait", "--invert", "--json"]))).toEqual({
      json: true,
      wait: false,
      invert: true,
    });
  });

  test("remoteSettingFromFlags turns the flags into a setting patch, or nothing", () => {
    expect(remoteSettingFromFlags({}, DEFAULT_REMOTE)).toBeNull();
    expect(remoteSettingFromFlags({ port: "0" }, DEFAULT_REMOTE)).toBeNull();
    expect(remoteSettingFromFlags({ remote: true }, DEFAULT_REMOTE)).toEqual({
      ...DEFAULT_REMOTE,
      enabled: true,
    });
    expect(remoteSettingFromFlags({ "remote-port": "47821" }, DEFAULT_REMOTE)).toEqual({
      ...DEFAULT_REMOTE,
      enabled: true,
      port: 47821,
    });
    expect(
      remoteSettingFromFlags({ remote: true, "remote-host": " 100.64.0.1 " }, DEFAULT_REMOTE),
    ).toEqual({ ...DEFAULT_REMOTE, enabled: true, host: "100.64.0.1" });
    // The preference the desktop saved survives a CLI restart.
    const saved = { ...DEFAULT_REMOTE, enabled: true, preferredEndpointKind: "lan" as const };
    expect(remoteSettingFromFlags({ remote: true }, saved)).toEqual(saved);
    expect(remoteSettingFromFlags({ remote: "false" }, saved)).toEqual({
      ...saved,
      enabled: false,
    });
    expect(() => remoteSettingFromFlags({ "remote-port": "70000" }, DEFAULT_REMOTE)).toThrow(
      /1–65535/,
    );
    expect(() => remoteSettingFromFlags({ "remote-port": "abc" }, DEFAULT_REMOTE)).toThrow(
      /1–65535/,
    );
    expect(() =>
      remoteSettingFromFlags({ remote: true, "remote-host": "" }, DEFAULT_REMOTE),
    ).toThrow(/cannot be empty/);
  });
});

describe("formatting", () => {
  const now = Date.parse("2026-09-13T12:00:00Z");
  const device = (over: Partial<Device>): Device => ({
    id: "dev_a1",
    label: "Maya's iPhone",
    platform: "ios",
    createdAt: "2026-09-01T08:00:00Z",
    lastSeenAt: "2026-09-13T11:58:00Z",
    ...over,
  });

  test("formatDevices aligns columns and ages last-seen", () => {
    expect(formatDevices([], now)).toBe("No paired devices.\n");
    const table = formatDevices(
      [device({}), device({ id: "dev_b2", label: "Pixel", platform: "android", lastSeenAt: null })],
      now,
    );
    expect(table.split("\n")).toEqual([
      "ID      LABEL          PLATFORM  PAIRED      LAST SEEN",
      "dev_a1  Maya's iPhone  ios       2026-09-01  2m ago",
      "dev_b2  Pixel          android   2026-09-01  never",
      "",
    ]);
  });

  test("formatPairing lists the link, the code, the endpoints with kinds, and warns about loopback-only", () => {
    const result: PairStartResult = {
      pairingToken: "tok",
      code: "AB12-CD34",
      expiresAt: new Date(now + 90_000).toISOString(),
      endpoints: [
        {
          host: "mac.tail.ts.net",
          hostname: "mac.tail.ts.net",
          port: 443,
          scheme: "https",
          kind: "tailscale-https",
          iface: "tailscale",
          default: true,
        },
        { host: "192.168.1.24", port: 47820, kind: "lan", iface: "en0", default: false },
      ],
      url: "fabdesk://pair?v=1&t=tok&p=47820&n=Mac&h=mac.tail.ts.net&h=192.168.1.24&k=tailscale-https&k=lan&s=https&s=http",
      coreName: "Mac",
    };
    const text = formatPairing(result, now);
    expect(text).toContain("  fabdesk://pair?v=1&t=tok&p=47820");
    expect(text).toContain("Code: AB12-CD34   (expires in 90s)");
    expect(text).toContain("https://mac.tail.ts.net");
    expect(text).toMatch(/https:\/\/mac\.tail\.ts\.net\s+Tailscale HTTPS  \(default\)/);
    expect(text).toMatch(/http:\/\/192\.168\.1\.24:47820\s+LAN\n/);
    expect(text).not.toContain("Warning");
    const loop = formatPairing(
      {
        ...result,
        endpoints: [
          { host: "127.0.0.1", port: 47820, kind: "loopback", iface: "lo0", default: true },
        ],
      },
      now,
    );
    expect(loop).toContain("Warning: only a loopback address");
  });
});

describe("against a running daemon", () => {
  let daemon: Daemon;
  let home: string;
  const REMOTE = { enabled: true, host: "127.0.0.1", port: 47824 };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "fabdesk-cli-"));
    process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
    process.env["FABDESK_TOKEN"] = "cli-test-token-0123456789abcdef";
    process.env["FABDESK_TAILSCALE_CLI"] = "off";
    // What `serve --remote --remote-host 127.0.0.1 --remote-port 47824` does before binding.
    expect(
      await persistRemoteFlags(join(home, "fabdesk.db"), {
        remote: true,
        "remote-host": REMOTE.host,
        "remote-port": String(REMOTE.port),
      }),
    ).toEqual(REMOTE);
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
    delete process.env["FABDESK_TAILSCALE_CLI"];
  });

  test("serve picked up the persisted remote setting and bound the listener", async () => {
    const health = await fetch(`http://${REMOTE.host}:${REMOTE.port}/health`);
    expect(health.status).toBe(200);
  });

  test("connectToDaemon finds it through the handshake file, and not elsewhere", async () => {
    const io = capture();
    const client = await connectToDaemon(resolveConfig({ dataDir: home }), io.io);
    expect(client?.baseUrl).toBe(daemon.url);
    expect(
      await connectToDaemon(resolveConfig({ dataDir: join(home, "nowhere") }), io.io),
    ).toBeNull();
    expect(io.text()).toContain("No running fabdesk-core found");
  });

  test("pair prints a QR and the link, then reports the phone that claimed the code", async () => {
    const client = daemonClient(daemon.url, daemon.token);
    const io = capture();
    const done = pairCommand(client, { json: false, wait: true, invert: false }, io.io);
    // The link is on stderr (prose); the QR alone is on stdout. Poll until it is there.
    let url: string | undefined;
    for (let i = 0; i < 100 && !url; i++) {
      url = /fabdesk:\/\/pair\?\S+/.exec(io.text())?.[0];
      if (!url) await Bun.sleep(20);
    }
    expect(url).toBeDefined();
    const qr = io.stdout();
    expect(
      qr.split("\n").filter((l) => /^[█▀▄ ]+$/.test(l) && l.length > 20).length,
    ).toBeGreaterThan(10);
    expect(io.text()).toContain("Code: ");
    expect(io.text()).toContain("Waiting for a phone");

    const payload = parsePairingUrl(url!)!;
    const claim = await fetch(`${daemon.url}/v1/devices/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingToken: payload.token,
        label: "Maya's iPhone",
        platform: "ios",
      }),
    });
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as PairClaimResult;
    expect(await done).toBe(0);
    expect(io.text()).toContain(`Paired: Maya's iPhone (${claimed.device.id})`);
  });

  test("pair --json prints the start result and --no-wait returns at once", async () => {
    const client = daemonClient(daemon.url, daemon.token);
    const io = capture();
    expect(await pairCommand(client, { json: true, wait: false, invert: false }, io.io)).toBe(0);
    const result = JSON.parse(io.stdout()) as PairStartResult;
    expect(parsePairingUrl(result.url)?.token).toBe(result.pairingToken);
    await client.request("/v1/devices/pair/cancel", { method: "POST" });
    const quiet = capture();
    expect(await pairCommand(client, { json: false, wait: false, invert: true }, quiet.io)).toBe(0);
    expect(quiet.text()).not.toContain("Waiting");
    await client.request("/v1/devices/pair/cancel", { method: "POST" });
  });

  test("devices list shows the paired phone; revoke by label removes it; a bad id is an error", async () => {
    const client = daemonClient(daemon.url, daemon.token);
    const io = capture();
    expect(await devicesCommand(client, { sub: "list", id: undefined, json: false }, io.io)).toBe(
      0,
    );
    expect(io.stdout()).toMatch(/^ID\s+LABEL\s+PLATFORM/);
    expect(io.stdout()).toContain("Maya's iPhone");
    const json = capture();
    expect(
      await devicesCommand(client, { sub: undefined, id: undefined, json: true }, json.io),
    ).toBe(0);
    const devices = JSON.parse(json.stdout()) as Device[];
    expect(devices).toHaveLength(1);

    const missing = capture();
    expect(
      await devicesCommand(client, { sub: "revoke", id: "nope", json: false }, missing.io),
    ).toBe(1);
    expect(missing.text()).toContain('No paired device with id or label "nope"');
    const noId = capture();
    expect(
      await devicesCommand(client, { sub: "revoke", id: undefined, json: false }, noId.io),
    ).toBe(2);
    const bad = capture();
    expect(
      await devicesCommand(client, { sub: "frobnicate", id: undefined, json: false }, bad.io),
    ).toBe(2);

    const revoke = capture();
    expect(
      await devicesCommand(client, { sub: "revoke", id: "Maya's iPhone", json: false }, revoke.io),
    ).toBe(0);
    expect(revoke.text()).toContain(`Revoked Maya's iPhone (${devices[0]!.id})`);
    expect(await client.request<Device[]>("/v1/devices")).toEqual([]);
  });

  test("pair refuses while remote access is off", async () => {
    const client = daemonClient(daemon.url, daemon.token);
    await client.request("/settings", {
      method: "PATCH",
      json: { remote: { ...REMOTE, enabled: false } },
    });
    const io = capture();
    expect(await pairCommand(client, { json: false, wait: false, invert: false }, io.io)).toBe(1);
    expect(io.text()).toContain("Remote access is off");
    await client.request("/settings", { method: "PATCH", json: { remote: REMOTE } });
  });
});
