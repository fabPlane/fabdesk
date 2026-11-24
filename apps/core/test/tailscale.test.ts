import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePairingUrl, type PairStartResult, type RemoteStatus } from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { listenAddresses, serveFor } from "../src/net";
import {
  createTailscaleProvider,
  findTailscaleCli,
  parseServeStatus,
  parseStatus,
  runTailscale,
  serveTarget,
  TAILSCALE_CLI_ENV,
  type TailscaleInfo,
} from "../src/tailscale";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

/** `tailscale status --json` as v1.102 prints it, trimmed to the fields read plus a few neighbours. */
const STATUS_JSON = {
  Version: "1.102.3-t9329c3677-ga522f65e9",
  BackendState: "Running",
  TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::c01:d073"],
  Self: {
    HostName: "Matthew’s MacBook Pro",
    DNSName: "matthews-macbook-pro.tail4f6a7.ts.net.",
    OS: "macOS",
    TailscaleIPs: ["100.101.102.103", "fd7a:115c:a1e0::c01:d073"],
    Online: true,
    CapMap: { funnel: null, https: null },
  },
  MagicDNSSuffix: "tail4f6a7.ts.net",
  CurrentTailnet: {
    Name: "example.com",
    MagicDNSSuffix: "tail4f6a7.ts.net",
    MagicDNSEnabled: true,
  },
  CertDomains: ["matthews-macbook-pro.tail4f6a7.ts.net"],
};
const DNS = "matthews-macbook-pro.tail4f6a7.ts.net";
/** `tailscale serve status --json` after `serve --bg https:443 http://127.0.0.1:47821`: an `ipn.ServeConfig`. */
const serveConfig = (target: string, port = 443) => ({
  TCP: { [String(port)]: { HTTPS: true } },
  Web: { [`${DNS}:${port}`]: { Handlers: { "/": { Proxy: target } } } },
});
const INTERFACES = {
  en0: [{ address: "192.168.1.24", family: "IPv4", internal: false } as never],
  utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false } as never],
};
const info = (over: Partial<TailscaleInfo> = {}): TailscaleInfo => ({
  cli: "/fake/tailscale",
  backendState: "Running",
  ip: "100.101.102.103",
  dnsName: DNS,
  httpsEnabled: true,
  serves: [],
  ...over,
});

describe("tailscale cli output", () => {
  test("remote CLI calls hide the console and keep failure diagnostics", async () => {
    const args = ["-e", 'console.error("diagnostic");process.exit(7)'];
    const spawn = spyOn(Bun, "spawn");
    try {
      const result = await runTailscale(process.execPath, args);
      expect(result.exitCode).toBe(7);
      expect(result.stderr.trim()).toBe("diagnostic");
      expect(spawn).toHaveBeenCalledWith([process.execPath, ...args], expect.objectContaining({ windowsHide: true }));
    } finally {
      spawn.mockRestore();
    }
  });

  test("status --json yields the tailnet IPv4, the MagicDNS name without its dot, and the HTTPS feature", () => {
    expect(parseStatus(JSON.stringify(STATUS_JSON))).toEqual({
      backendState: "Running",
      ip: "100.101.102.103",
      dnsName: DNS,
      httpsEnabled: true,
    });
    // Logged out: no Self addresses, no cert domains, and MagicDNS is not claimed.
    expect(
      parseStatus(
        JSON.stringify({
          BackendState: "NeedsLogin",
          Self: { DNSName: "", TailscaleIPs: [] },
          CertDomains: null,
        }),
      ),
    ).toEqual({
      backendState: "NeedsLogin",
      ip: null,
      dnsName: null,
      httpsEnabled: false,
    });
    // MagicDNS off on the tailnet: the name is not usable even though `DNSName` is filled in.
    expect(
      parseStatus(JSON.stringify({ ...STATUS_JSON, CurrentTailnet: { MagicDNSEnabled: false } }))
        .dnsName,
    ).toBeNull();
    expect(() => parseStatus("tailscale: command not found")).toThrow();
  });

  test("serve status --json lists https proxies and nothing for an empty config", () => {
    expect(parseServeStatus("{}\n")).toEqual([]);
    expect(parseServeStatus("")).toEqual([]);
    expect(parseServeStatus("No serve config")).toEqual([]);
    expect(parseServeStatus(JSON.stringify(serveConfig("http://127.0.0.1:47821")))).toEqual([
      { port: 443, target: "http://127.0.0.1:47821" },
    ]);
    // A plain-HTTP serve, or a path handler rather than a proxy, is not an HTTPS endpoint for us.
    expect(
      parseServeStatus(
        JSON.stringify({
          TCP: { "80": { HTTP: true } },
          Web: { [`${DNS}:80`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } } },
        }),
      ),
    ).toEqual([]);
    expect(
      parseServeStatus(
        JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: { [`${DNS}:443`]: { Handlers: { "/": { Path: "/srv" } } } },
        }),
      ),
    ).toEqual([]);
  });

  test("serveFor matches the listener serve was pointed at, and serveTarget picks loopback for a wildcard bind", () => {
    const serves = [
      { port: 443, target: "http://127.0.0.1:47820" },
      { port: 8443, target: "http://192.168.1.24:47820" },
    ];
    expect(serveFor(serves, { host: "0.0.0.0", port: 47820 })?.port).toBe(443);
    expect(serveFor(serves, { host: "127.0.0.1", port: 47820 })?.port).toBe(443);
    expect(serveFor(serves, { host: "192.168.1.24", port: 47820 })?.port).toBe(8443);
    expect(serveFor(serves, { host: "100.101.102.103", port: 47820 })).toBeNull();
    expect(serveFor(serves, { host: "0.0.0.0", port: 1 })).toBeNull();
    expect(
      serveFor([{ port: 443, target: "not a url" }], { host: "0.0.0.0", port: 47820 }),
    ).toBeNull();
    expect(serveTarget({ host: "0.0.0.0", port: 47820 })).toBe("http://127.0.0.1:47820");
    expect(serveTarget({ host: "localhost", port: 47820 })).toBe("http://127.0.0.1:47820");
    expect(serveTarget({ host: "100.101.102.103", port: 47820 })).toBe(
      "http://100.101.102.103:47820",
    );
  });

  test(`${TAILSCALE_CLI_ENV}=off disables discovery and a missing override is not used`, () => {
    expect(findTailscaleCli({ [TAILSCALE_CLI_ENV]: "off" })).toBeNull();
    expect(findTailscaleCli({ [TAILSCALE_CLI_ENV]: "/nope/tailscale" })).toBeNull();
  });
});

describe("listenAddresses with the tailscale provider", () => {
  test("the tailnet address gets its MagicDNS name; without the CLI the CGNAT guess stands", () => {
    const withCli = listenAddresses(47820, { interfaces: INTERFACES, tailscale: info() });
    expect(withCli).toEqual([
      {
        host: "100.101.102.103",
        port: 47820,
        kind: "tailscale",
        iface: "utun4",
        hostname: DNS,
        default: true,
      },
      { host: "192.168.1.24", port: 47820, kind: "lan", iface: "en0", default: false },
    ]);
    const without = listenAddresses(47820, { interfaces: INTERFACES, tailscale: null });
    expect(without.map((e) => [e.kind, e.hostname])).toEqual([
      ["tailscale", undefined],
      ["lan", undefined],
    ]);
    // Userspace networking: the CLI knows an address no interface carries. It is still offered.
    expect(
      listenAddresses(1, { interfaces: { en0: INTERFACES.en0 }, tailscale: info() })[0],
    ).toMatchObject({ host: "100.101.102.103", kind: "tailscale", hostname: DNS });
  });

  test("a serve entry for this listener adds a tailscale-https endpoint on 443, listed first", () => {
    const ts = info({ serves: [{ port: 443, target: "http://127.0.0.1:47820" }] });
    const endpoints = listenAddresses(47820, { interfaces: INTERFACES, tailscale: ts });
    expect(endpoints[0]).toEqual({
      host: DNS,
      hostname: DNS,
      port: 443,
      scheme: "https",
      kind: "tailscale-https",
      iface: "tailscale",
      default: true,
    });
    expect(endpoints.map((e) => e.kind)).toEqual(["tailscale-https", "tailscale", "lan"]);
    // A LAN preference still wins over it — the user asked.
    expect(
      listenAddresses(47820, { interfaces: INTERFACES, tailscale: ts, preferred: "lan" }).map(
        (e) => e.kind,
      ),
    ).toEqual(["lan", "tailscale-https", "tailscale"]);
    // Serve for some other port is not ours.
    expect(
      listenAddresses(47821, { interfaces: INTERFACES, tailscale: ts }).some(
        (e) => e.kind === "tailscale-https",
      ),
    ).toBe(false);
    // A loopback bind is unreachable by itself, but serve reaches loopback: the https endpoint makes it usable.
    expect(
      listenAddresses(47820, { interfaces: INTERFACES, tailscale: ts, bindHost: "127.0.0.1" }).map(
        (e) => e.kind,
      ),
    ).toEqual(["tailscale-https", "loopback"]);
    // No MagicDNS name, no https endpoint: there is nothing for a certificate to be issued to.
    expect(
      listenAddresses(47820, {
        interfaces: INTERFACES,
        tailscale: info({ ...ts, dnsName: null }),
      }).some((e) => e.kind === "tailscale-https"),
    ).toBe(false);
  });
});

/**
 * A stand-in `tailscale` binary: answers `status` and `serve status` from files next to it,
 * records `serve --bg` / `serve reset` into `calls`, and fails `serve --bg` while `fail` exists.
 */
async function fakeCli(dir: string): Promise<string> {
  const cli = join(dir, "tailscale");
  await writeFile(join(dir, "status.json"), JSON.stringify(STATUS_JSON));
  await writeFile(
    cli,
    `#!/bin/sh
D=$(dirname "$0")
case "$1 $2" in
  "status --json") cat "$D/status.json" ;;
  "serve status") if [ -f "$D/serve.json" ]; then cat "$D/serve.json"; else echo "{}"; fi ;;
  "serve --bg")
    echo "$@" >> "$D/calls"
    if [ -f "$D/fail" ]; then echo "error: ${DNS}: HTTPS is not enabled for this tailnet" >&2; exit 1; fi
    printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${DNS}:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$4" > "$D/serve.json" ;;
  "serve reset") echo "$@" >> "$D/calls"; rm -f "$D/serve.json" ;;
  *) echo "unexpected: $@" >&2; exit 2 ;;
esac
`,
  );
  await chmod(cli, 0o755);
  return cli;
}

describe.skipIf(process.platform === "win32")("tailscale provider against a fake cli", () => {
  let dir: string;
  let cli: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabdesk-tailscale-"));
    cli = await fakeCli(dir);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("info() reads status and serve status, caches, and setServe() drives the CLI", async () => {
    const provider = createTailscaleProvider({ cli, cacheMs: 60_000 });
    expect(await provider.info()).toEqual({
      cli,
      backendState: "Running",
      ip: "100.101.102.103",
      dnsName: DNS,
      httpsEnabled: true,
      serves: [],
    });

    await provider.setServe(true, { host: "0.0.0.0", port: 47821 });
    expect((await readFile(join(dir, "calls"), "utf8")).trim()).toBe(
      "serve --bg https:443 http://127.0.0.1:47821",
    );
    // A serve change drops the cache, so the next read sees it without asking for `fresh`.
    expect((await provider.info())?.serves).toEqual([
      { port: 443, target: "http://127.0.0.1:47821" },
    ]);

    await provider.setServe(false, { host: "0.0.0.0", port: 47821 });
    expect((await provider.info())?.serves).toEqual([]);
    expect((await readFile(join(dir, "calls"), "utf8")).trim().split("\n")).toHaveLength(2);

    // Stale status behind the cache until `fresh` or expiry.
    await writeFile(
      join(dir, "status.json"),
      JSON.stringify({ ...STATUS_JSON, BackendState: "Stopped" }),
    );
    expect((await provider.info())?.backendState).toBe("Running");
    expect((await provider.info({ fresh: true }))?.backendState).toBe("Stopped");
    await writeFile(join(dir, "status.json"), JSON.stringify(STATUS_JSON));
  });

  test("a failing serve surfaces the CLI's stderr and points at the HTTPS feature", async () => {
    const provider = createTailscaleProvider({ cli });
    await writeFile(join(dir, "fail"), "");
    try {
      await expect(provider.setServe(true, { host: "0.0.0.0", port: 47821 })).rejects.toThrow(
        /HTTPS is not enabled for this tailnet.*HTTPS certificates feature/s,
      );
    } finally {
      await rm(join(dir, "fail"));
    }
    expect(await createTailscaleProvider({ cli: null }).info()).toBeNull();
    await expect(
      createTailscaleProvider({ cli: null }).setServe(true, { host: "0.0.0.0", port: 1 }),
    ).rejects.toThrow(/not found/);
  });
});

describe.skipIf(process.platform === "win32")("daemon routes with the fake cli", () => {
  let daemon: Daemon;
  let home: string;
  let dir: string;
  const REMOTE = { enabled: false, host: "127.0.0.1", port: 47823 };
  const previousCli = process.env[TAILSCALE_CLI_ENV];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabdesk-tailscale-daemon-"));
    process.env[TAILSCALE_CLI_ENV] = await fakeCli(dir);
    home = await mkdtemp(join(tmpdir(), "fabdesk-tailscale-home-"));
    process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
    process.env["FABDESK_TOKEN"] = "tailscale-test-token-0123456789";
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
    await local("/settings", { method: "PATCH", body: JSON.stringify({ remote: REMOTE }) });
  });
  afterAll(async () => {
    await daemon.close("tests done");
    if (previousCli === undefined) delete process.env[TAILSCALE_CLI_ENV];
    else process.env[TAILSCALE_CLI_ENV] = previousCli;
    await rm(dir, { recursive: true, force: true });
  });

  const H = () => ({ authorization: `Bearer ${daemon.token}`, "content-type": "application/json" });
  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${daemon.url}${path}`, { ...init, headers: { ...H(), ...(init.headers ?? {}) } });

  test("/v1/remote reports the tailscale state and the serve action adds the https endpoint", async () => {
    const before = (await (await local("/v1/remote")).json()) as RemoteStatus;
    expect(before.tailscale).toEqual({
      ip: "100.101.102.103",
      dnsName: DNS,
      httpsEnabled: true,
      serve: null,
    });
    // Loopback bind: nothing a phone can reach, yet.
    expect(before.endpoints.map((e) => e.kind)).toEqual(["loopback"]);

    const on = await local("/v1/remote/tailscale-serve", {
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    const after = (await on.json()) as RemoteStatus;
    expect(after.tailscale?.serve).toEqual({ port: 443 });
    expect(after.endpoints[0]).toMatchObject({
      kind: "tailscale-https",
      host: DNS,
      scheme: "https",
      port: 443,
      default: true,
    });
    expect((await readFile(join(dir, "calls"), "utf8")).trim()).toBe(
      `serve --bg https:443 http://127.0.0.1:${REMOTE.port}`,
    );

    // The pairing URL now leads with the https name and carries the scheme list.
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    const parsed = parsePairingUrl(start.url)!;
    expect(parsed.hosts[0]).toBe(DNS);
    expect(parsed.schemes).toEqual(["https", "http"]);
    expect(parsed.kinds).toEqual(["tailscale-https", "loopback"]);
    await local("/v1/devices/pair/cancel", { method: "POST" });

    const off = (await (
      await local("/v1/remote/tailscale-serve", {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      })
    ).json()) as RemoteStatus;
    expect(off.tailscale?.serve).toBeNull();
    expect(off.endpoints.map((e) => e.kind)).toEqual(["loopback"]);
    expect((await readFile(join(dir, "calls"), "utf8")).trim().split("\n")[1]).toBe("serve reset");
  });

  test("a serve failure is a 412 carrying the CLI's stderr; a bad body is a 400", async () => {
    await writeFile(join(dir, "fail"), "");
    try {
      const res = await local("/v1/remote/tailscale-serve", {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(412);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("precondition");
      expect(body.error).toContain("HTTPS is not enabled for this tailnet");
      expect(body.error).toContain("HTTPS certificates feature");
    } finally {
      await rm(join(dir, "fail"));
    }
    expect(
      (
        await local("/v1/remote/tailscale-serve", {
          method: "POST",
          body: JSON.stringify({ enabled: "yes" }),
        })
      ).status,
    ).toBe(400);
  });

  test("without a CLI the status says so and the action refuses", async () => {
    process.env[TAILSCALE_CLI_ENV] = "off";
    try {
      const status = (await (await local("/v1/remote")).json()) as RemoteStatus;
      expect(status.tailscale).toBeNull();
      expect(status.endpoints.map((e) => e.kind)).toEqual(["loopback"]);
      const res = await local("/v1/remote/tailscale-serve", {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(412);
      expect(((await res.json()) as { error: string }).error).toContain("not found");
    } finally {
      process.env[TAILSCALE_CLI_ENV] = join(dir, "tailscale");
    }
  });
});
