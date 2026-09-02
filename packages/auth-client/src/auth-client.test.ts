import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthState } from "@fabdesk/protocol";
import { AuthClient } from "./client";
import { credentialsPath, readCredentials, writeCredentials } from "./credential-store";
import { fabdeskHome, localModeAllowed, LOCAL_PRINCIPAL } from "./home";

const ORIGIN = "https://api.fabplane.test";
let home: string;

beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "fabdesk-auth-")), "home");
});
afterEach(() => {
  rmSync(join(home, ".."), { recursive: true, force: true });
});

type TokenStep =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "invalid_grant"
  | { access_token: string; expires_in: number }
  | "network";

interface FakeServer {
  fetch: typeof fetch;
  requests: Array<{ method: string; url: string; body?: unknown; auth?: string }>;
  tokenSteps: TokenStep[];
  validTokens: Set<string>;
  user: { subject: string; handle?: string; displayName?: string } | null;
  offline: boolean;
  revoked: string[];
}

function fakeServer(steps: TokenStep[] = []): FakeServer {
  const server: FakeServer = {
    requests: [],
    tokenSteps: steps,
    validTokens: new Set(),
    user: { subject: "user_123", handle: "hyper", displayName: "Hyper" },
    offline: false,
    revoked: [],
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? undefined;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      server.requests.push({
        method,
        url,
        ...(body !== undefined ? { body } : {}),
        ...(auth ? { auth } : {}),
      });
      if (server.offline) throw new TypeError("fetch failed: ECONNREFUSED");
      const path = new URL(url).pathname;
      if (path === "/v1/auth/device/code" && method === "POST") {
        expect(body).toMatchObject({ client_id: "fabdesk", client_label: expect.any(String) });
        return Response.json({
          device_code: "dev-code-1",
          user_code: "ABCD-EFGH",
          verification_uri: `${ORIGIN}/device`,
          verification_uri_complete: `${ORIGIN}/device?user_code=ABCD-EFGH`,
          expires_in: 900,
          interval: 5,
        });
      }
      if (path === "/v1/auth/device/token" && method === "POST") {
        expect(body).toEqual({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "dev-code-1",
          client_id: "fabdesk",
        });
        const step = server.tokenSteps.shift() ?? "authorization_pending";
        if (step === "network") throw new TypeError("fetch failed");
        if (typeof step === "string") return Response.json({ error: step }, { status: 400 });
        server.validTokens.add(step.access_token);
        return Response.json({ ...step, token_type: "Bearer" });
      }
      if (path === "/v1/auth/me" && method === "GET") {
        const token = auth?.replace(/^Bearer /, "");
        if (!token || !server.validTokens.has(token))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json({ user: server.user });
      }
      if (path === "/v1/auth/session" && method === "DELETE") {
        const token = auth?.replace(/^Bearer /, "") ?? "";
        server.revoked.push(token);
        server.validTokens.delete(token);
        return new Response(null, { status: 204 });
      }
      if (path === "/v1/projects") {
        const token = auth?.replace(/^Bearer /, "");
        if (!token || !server.validTokens.has(token))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        return Response.json({ projects: [] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  return server;
}

function makeClient(
  server: FakeServer,
  extra: Partial<ConstructorParameters<typeof AuthClient>[0]> = {},
) {
  const states: AuthState[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const client = new AuthClient({
    home,
    apiOrigin: `${ORIGIN}/`,
    mode: "fabplane",
    clientLabel: "fabdesk test",
    fetchImpl: server.fetch,
    onState: (s) => states.push(s),
    openUrl: (u) => opened.push(u),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, states, sleeps, opened };
}

describe("fabdeskHome / localModeAllowed", () => {
  test("honors FABDESK_HOME, then platform defaults", () => {
    expect(fabdeskHome({ FABDESK_HOME: "/x/fab" }, "linux")).toBe("/x/fab");
    expect(fabdeskHome({ HOME: "/Users/me" }, "darwin")).toBe(
      "/Users/me/Library/Application Support/fabdesk",
    );
    expect(
      fabdeskHome({ HOME: "C:/Users/me", APPDATA: "C:/Users/me/AppData/Roaming" }, "win32"),
    ).toBe(join("C:/Users/me/AppData/Roaming", "fabdesk"));
    expect(fabdeskHome({ HOME: "/home/me", XDG_CONFIG_HOME: "/home/me/.cfg" }, "linux")).toBe(
      "/home/me/.cfg/fabdesk",
    );
    expect(fabdeskHome({ HOME: "/home/me" }, "linux")).toBe("/home/me/.config/fabdesk");
  });

  test("local mode needs a non-public channel or a .fabdesk-dev marker", () => {
    expect(localModeAllowed({ channel: "internal", home })).toBe(true);
    expect(localModeAllowed({ channel: "public", home })).toBe(false);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".fabdesk-dev"), "");
    expect(localModeAllowed({ channel: "public", home })).toBe(true);
    expect(LOCAL_PRINCIPAL).toEqual({
      subject: "local:dev",
      handle: "local",
      displayName: "Local developer",
    });
  });
});

describe("credential store", () => {
  test("writes 0600 inside a 0700 directory, atomically, and reads back", async () => {
    await writeCredentials(home, {
      version: 1,
      apiOrigin: ORIGIN,
      token: "fpd_abc",
      subject: "u1",
      obtainedAt: "2026-09-02T00:00:00.000Z",
      expiresAt: "2026-10-02T00:00:00.000Z",
    });
    const path = credentialsPath(home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toContain('"token": "fpd_abc"');
    expect((await readCredentials(home))?.token).toBe("fpd_abc");
    writeFileSync(path, "{not json");
    expect(await readCredentials(home)).toBeUndefined();
    writeFileSync(path, JSON.stringify({ version: 2, token: "x" }));
    expect(await readCredentials(home)).toBeUndefined();
  });
});

describe("AuthClient.login (device flow)", () => {
  test("pending → slow_down → success stores the token and honors the interval", async () => {
    const server = fakeServer([
      "authorization_pending",
      "slow_down",
      "authorization_pending",
      { access_token: "fpd_tok1", expires_in: 3600 },
    ]);
    const { client, states, sleeps, opened } = makeClient(server);
    expect(client.state()).toEqual({ mode: "fabplane", status: "signed_out" });

    const result = await client.login();
    expect(result).toEqual({
      mode: "fabplane",
      status: "signed_in",
      principal: { subject: "user_123", handle: "hyper", displayName: "Hyper" },
    });
    expect(states[0]).toMatchObject({
      status: "pending",
      pending: {
        userCode: "ABCD-EFGH",
        verificationUri: `${ORIGIN}/device`,
        verificationUriComplete: `${ORIGIN}/device?user_code=ABCD-EFGH`,
      },
    });
    expect(Date.parse(states[0]?.pending?.expiresAt ?? "")).toBeGreaterThan(Date.now() + 800_000);
    expect(opened).toEqual([`${ORIGIN}/device?user_code=ABCD-EFGH`]);
    // 5 s, 5 s, then +5 s after slow_down for the remaining polls.
    expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
    expect(client.token()).toBe("fpd_tok1");

    const stored = await readCredentials(home);
    expect(stored).toMatchObject({
      version: 1,
      apiOrigin: ORIGIN,
      token: "fpd_tok1",
      subject: "user_123",
      handle: "hyper",
      displayName: "Hyper",
    });
    expect(Date.parse(stored?.expiresAt ?? "") - Date.parse(stored?.obtainedAt ?? "")).toBe(
      3600_000,
    );
    expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
    expect(server.requests.filter((r) => r.url.endsWith("/v1/auth/device/token"))).toHaveLength(4);
    expect(states.at(-1)?.status).toBe("signed_in");
  });

  test("expired_token ends in an error state without credentials", async () => {
    const server = fakeServer(["authorization_pending", "expired_token"]);
    const { client } = makeClient(server);
    const result = await client.login();
    expect(result).toEqual({
      mode: "fabplane",
      status: "error",
      error: "Sign-in code expired. Start again.",
    });
    expect(client.token()).toBeUndefined();
    expect(await readCredentials(home)).toBeUndefined();
  });

  test("access_denied ends in an error state", async () => {
    const { client } = makeClient(fakeServer(["access_denied"]));
    expect(await client.login()).toEqual({
      mode: "fabplane",
      status: "error",
      error: "Sign-in was denied.",
    });
  });

  test("transient network errors while polling are retried; abort signs out", async () => {
    const server = fakeServer(["network", { access_token: "fpd_tok2", expires_in: 60 }]);
    const { client } = makeClient(server);
    expect((await client.login()).status).toBe("signed_in");

    const server2 = fakeServer([
      "authorization_pending",
      "authorization_pending",
      "authorization_pending",
    ]);
    const controller = new AbortController();
    let polls = 0;
    const { client: client2 } = makeClient(server2, {
      sleep: async () => {
        polls += 1;
        if (polls === 2) controller.abort();
      },
    });
    expect(await client2.login(controller.signal)).toEqual({
      mode: "fabplane",
      status: "signed_out",
    });
  });

  test("local mode never talks to fabplane", async () => {
    const server = fakeServer();
    const client = new AuthClient({
      home,
      apiOrigin: ORIGIN,
      mode: "local",
      fetchImpl: server.fetch,
    });
    expect(client.state()).toEqual({
      mode: "local",
      status: "signed_in",
      principal: LOCAL_PRINCIPAL,
    });
    expect(await client.load()).toMatchObject({ mode: "local", status: "signed_in" });
    expect(await client.login()).toMatchObject({ mode: "local", status: "signed_in" });
    await client.logout();
    expect(client.token()).toBeUndefined();
    const res = await client.authorizedFetch(`${ORIGIN}/v1/projects`);
    expect(res.status).toBe(401); // no token attached, and state is untouched
    expect(client.state().status).toBe("signed_in");
    expect(server.requests.filter((r) => r.url.includes("/v1/auth/"))).toHaveLength(0);
  });
});

describe("AuthClient.load", () => {
  async function seed(
    token = "fpd_seed",
    expiresAt = new Date(Date.now() + 86_400_000).toISOString(),
  ) {
    await writeCredentials(home, {
      version: 1,
      apiOrigin: ORIGIN,
      token,
      subject: "user_123",
      handle: "old",
      obtainedAt: new Date().toISOString(),
      expiresAt,
    });
  }

  test("verifies with /me and refreshes the stored profile", async () => {
    const server = fakeServer();
    server.validTokens.add("fpd_seed");
    await seed();
    const { client, states } = makeClient(server);
    expect(await client.load()).toEqual({
      mode: "fabplane",
      status: "signed_in",
      principal: { subject: "user_123", handle: "hyper", displayName: "Hyper" },
    });
    expect((await readCredentials(home))?.handle).toBe("hyper");
    expect(states).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: `${ORIGIN}/v1/auth/me`,
      auth: "Bearer fpd_seed",
    });
  });

  test("offline: trusts the file until fabplane says otherwise", async () => {
    const server = fakeServer();
    server.offline = true;
    await seed();
    const { client } = makeClient(server);
    expect(await client.load()).toEqual({
      mode: "fabplane",
      status: "signed_in",
      principal: { subject: "user_123", handle: "old" },
    });
    expect(client.token()).toBe("fpd_seed");
  });

  test("401 from /me clears the credentials file", async () => {
    const server = fakeServer(); // token not registered → 401
    await seed();
    const { client, states } = makeClient(server);
    expect(await client.load()).toEqual({ mode: "fabplane", status: "signed_out" });
    expect(await readCredentials(home)).toBeUndefined();
    expect(states).toEqual([{ mode: "fabplane", status: "signed_out" }]);
  });

  test("missing, foreign-origin or expired credentials mean signed_out", async () => {
    const server = fakeServer();
    server.validTokens.add("fpd_seed");
    const { client } = makeClient(server);
    expect(await client.load()).toEqual({ mode: "fabplane", status: "signed_out" });

    await writeCredentials(home, {
      version: 1,
      apiOrigin: "https://other.test",
      token: "fpd_seed",
      subject: "u",
      obtainedAt: "",
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect((await client.load()).status).toBe("signed_out");
    expect(server.requests).toHaveLength(0);

    await seed("fpd_seed", new Date(Date.now() - 1000).toISOString());
    expect((await client.load()).status).toBe("signed_out");
    expect(await readCredentials(home)).toBeUndefined();
    expect(server.requests).toHaveLength(0);
  });
});

describe("authorizedFetch / logout", () => {
  test("adds the bearer header and clears state on 401", async () => {
    const server = fakeServer([{ access_token: "fpd_live", expires_in: 3600 }]);
    const { client, states } = makeClient(server);
    await client.login();

    const ok = await client.authorizedFetch(`${ORIGIN}/v1/projects`, {
      headers: { "x-extra": "1" },
    });
    expect(ok.status).toBe(200);
    expect(server.requests.at(-1)).toMatchObject({ auth: "Bearer fpd_live" });

    server.validTokens.delete("fpd_live"); // revoked server-side
    const res = await client.authorizedFetch(new URL(`${ORIGIN}/v1/projects`));
    expect(res.status).toBe(401);
    expect(client.state()).toEqual({
      mode: "fabplane",
      status: "signed_out",
      error: "Session expired. Sign in again.",
    });
    expect(client.token()).toBeUndefined();
    expect(await readCredentials(home)).toBeUndefined();
    expect(states.at(-1)?.status).toBe("signed_out");
  });

  test("logout revokes the session, deletes the file and emits signed_out", async () => {
    const server = fakeServer([{ access_token: "fpd_bye", expires_in: 3600 }]);
    const { client, states } = makeClient(server);
    await client.login();
    await client.logout();
    expect(server.revoked).toEqual(["fpd_bye"]);
    expect(await readCredentials(home)).toBeUndefined();
    expect(client.state()).toEqual({ mode: "fabplane", status: "signed_out" });
    expect(states.at(-1)).toEqual({ mode: "fabplane", status: "signed_out" });
  });
});
