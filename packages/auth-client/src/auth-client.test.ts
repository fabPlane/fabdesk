import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
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
  user: { subject: string; handle?: string; displayName?: string; email?: string } | null;
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
    ).toBe(win32.join("C:/Users/me/AppData/Roaming", "fabdesk"));
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
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect(statSync(home).mode & 0o777).toBe(0o700);
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
    if (process.platform !== "win32") expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
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
    expect(await client.load()).toEqual({ mode: "fabplane", status: "signed_out", error: "Session expired or revoked. Sign in again." });
    expect(await readCredentials(home)).toBeUndefined();
    expect(states).toEqual([{ mode: "fabplane", status: "signed_out", error: "Session expired or revoked. Sign in again." }]);
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


test("profile email survives online and offline reloads and is replaced by the verified identity", async () => {
  const server = fakeServer([{ access_token: "profile-token", expires_in: 3600 }]);
  server.user = { subject: "taylor", displayName: "Taylor Morgan", email: "taylor@example.test" };
  const { client } = makeClient(server);
  expect((await client.login()).principal?.email).toBe("taylor@example.test");
  expect((await readCredentials(home))?.email).toBe("taylor@example.test");
  expect((await makeClient(server).client.load()).principal?.email).toBe("taylor@example.test");
  server.offline = true;
  expect((await makeClient(server).client.load()).principal?.email).toBe("taylor@example.test");
  server.offline = false;
  server.user = { subject: "taylor", displayName: "Taylor", email: "updated@example.test" };
  expect((await makeClient(server).client.load()).principal?.email).toBe("updated@example.test");
  server.user = { subject: "taylor" };
  expect((await makeClient(server).client.load()).principal).toEqual({ subject: "taylor" });
  expect((await readCredentials(home))?.email).toBeUndefined();
});

test("a late 401 from the previous account cannot sign out the replacement session", async () => {
  const server = fakeServer([{ access_token: "old-token", expires_in: 3600 }]);
  let finish!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { finish = resolve; });
  const { client } = makeClient(server, { fetchImpl: (async (input, init) =>
    String(input).endsWith('/delayed-old-request') ? delayed : server.fetch(input, init)) as typeof fetch });
  await client.login();
  const oldRequest = client.authorizedFetch(`${ORIGIN}/delayed-old-request`);
  await client.logout();
  server.user = { subject: "replacement-account", email: "new@example.test" };
  server.tokenSteps.push({ access_token: "new-token", expires_in: 3600 });
  await client.login();
  finish(new Response(null, { status: 401 }));
  expect((await oldRequest).status).toBe(401);
  expect(client.state().principal?.subject).toBe("replacement-account");
  expect(client.token()).toBe("new-token");
  expect((await readCredentials(home))?.token).toBe("new-token");
});

test("approval during an identity-service outage still allows explicit sign-out", async () => {
  const server = fakeServer([{ access_token: "approved-offline", expires_in: 3600 }]);
  const { client } = makeClient(server, { fetchImpl: (async (input, init) => {
    if (String(input).endsWith('/v1/auth/me')) throw new TypeError('identity service offline');
    return server.fetch(input, init);
  }) as typeof fetch });
  expect(await client.login()).toMatchObject({ status: 'signed_in', principal: { subject: '' } });
  expect(client.token()).toBe('approved-offline');
  await client.logout();
  expect(client.state().status).toBe('signed_out');
  expect(await readCredentials(home)).toBeUndefined();
});

function deferredAuth<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("interrupted account lifecycle", () => {
  test("abort during identity lookup cannot persist the approved token", async () => {
    const server = fakeServer([{ access_token: "aborted-token", expires_in: 3600 }]);
    const entered = deferredAuth<void>(), identity = deferredAuth<Response>();
    const { client } = makeClient(server, { fetchImpl: (async (input, init) => {
      if (String(input).endsWith("/v1/auth/me")) { entered.resolve(); return identity.promise; }
      return server.fetch(input, init);
    }) as typeof fetch });
    const controller = new AbortController();
    const login = client.login(controller.signal);
    await entered.promise;
    controller.abort();
    identity.resolve(Response.json({ user: server.user }));
    await login;
    expect(server.revoked).toEqual(["aborted-token"]);
    expect(client.state().status).toBe("signed_out");
    expect(client.token()).toBeUndefined();
    expect(await readCredentials(home)).toBeUndefined();
  });

  test("logout cancels a pending grant even when a token response arrives late", async () => {
    const server = fakeServer();
    const entered = deferredAuth<void>(), token = deferredAuth<Response>();
    server.validTokens.add("late-token");
    const { client } = makeClient(server, { fetchImpl: (async (input, init) => {
      if (String(input).endsWith("/v1/auth/device/token")) { entered.resolve(); return token.promise; }
      return server.fetch(input, init);
    }) as typeof fetch });
    const login = client.login();
    await entered.promise;
    await client.logout();
    token.resolve(Response.json({ access_token: "late-token", token_type: "Bearer", expires_in: 3600 }));
    await login;
    expect(server.revoked).toEqual(["late-token"]);
    expect(client.state().status).toBe("signed_out");
    expect(client.token()).toBeUndefined();
    expect(await readCredentials(home)).toBeUndefined();
  });

  test("late revocation completion cannot remove a replacement account", async () => {
    const server = fakeServer([{ access_token: "old-session", expires_in: 3600 }]);
    const entered = deferredAuth<void>(), revoke = deferredAuth<Response>();
    const { client } = makeClient(server, { fetchImpl: (async (input, init) => {
      if (String(input).endsWith("/v1/auth/session")) { entered.resolve(); return revoke.promise; }
      return server.fetch(input, init);
    }) as typeof fetch });
    await client.login();
    const logout = client.logout();
    await entered.promise;
    server.user = { subject: "new-account" };
    server.tokenSteps.push({ access_token: "replacement-session", expires_in: 3600 });
    await client.login();
    revoke.resolve(new Response(null, { status: 204 }));
    await logout;
    expect(client.state().principal?.subject).toBe("new-account");
    expect(client.token()).toBe("replacement-session");
    expect((await readCredentials(home))?.token).toBe("replacement-session");
  });

  test("a late credential reload cannot restore the previous identity", async () => {
    const server = fakeServer([{ access_token: "old-session", expires_in: 3600 }]);
    const entered = deferredAuth<void>(), identity = deferredAuth<Response>();
    let delay = false;
    const { client } = makeClient(server, { fetchImpl: (async (input, init) => {
      if (delay && String(input).endsWith("/v1/auth/me") && new Headers(init?.headers).get("authorization") === "Bearer old-session") {
        entered.resolve(); return identity.promise;
      }
      return server.fetch(input, init);
    }) as typeof fetch });
    await client.login();
    delay = true;
    const load = client.load();
    await entered.promise;
    await client.logout();
    server.user = { subject: "new-account" };
    server.tokenSteps.push({ access_token: "replacement-session", expires_in: 3600 });
    await client.login();
    identity.resolve(Response.json({ user: { subject: "old-account", email: "old@example.test" } }));
    await load;
    expect(client.state().principal?.subject).toBe("new-account");
    expect(client.token()).toBe("replacement-session");
    expect((await readCredentials(home))?.token).toBe("replacement-session");
  });

  test("an already aborted sign-in never requests a device code or opens a browser", async () => {
    const server = fakeServer();
    const { client, opened } = makeClient(server);
    const controller = new AbortController();
    controller.abort();
    expect((await client.login(controller.signal)).status).toBe("signed_out");
    expect(server.requests).toHaveLength(0);
    expect(opened).toHaveLength(0);
  });

  test("an aborted grant cannot join or clear the replacement login", async () => {
    const server = fakeServer();
    const firstEntered = deferredAuth<void>(), secondEntered = deferredAuth<void>();
    const firstToken = deferredAuth<Response>(), secondToken = deferredAuth<Response>();
    let polls = 0;
    server.validTokens.add("new-token");
    const { client } = makeClient(server, { fetchImpl: (async (input, init) => {
      if (String(input).endsWith("/v1/auth/device/token")) {
        if (++polls === 1) { firstEntered.resolve(); return firstToken.promise; }
        secondEntered.resolve(); return secondToken.promise;
      }
      return server.fetch(input, init);
    }) as typeof fetch });
    const controller = new AbortController();
    const oldLogin = client.login(controller.signal);
    await firstEntered.promise;
    controller.abort();
    const newLogin = client.login();
    await secondEntered.promise;
    firstToken.resolve(Response.json({ error: "access_denied" }, { status: 400 }));
    await oldLogin;
    expect(client.state().status).toBe("pending");
    expect(client.login()).toBe(newLogin);
    secondToken.resolve(Response.json({ access_token: "new-token", token_type: "Bearer", expires_in: 3600 }));
    await newLogin;
    expect(client.token()).toBe("new-token");
    expect((await readCredentials(home))?.token).toBe("new-token");
  });

  test("sign-in triggered by sign-out notification survives credential cleanup and restart", async () => {
    const server = fakeServer([{ access_token: "old-token", expires_in: 3600 }]);
    let armed = false, replacement: Promise<AuthState> | undefined;
    const { client } = makeClient(server, { onState: state => {
      if (armed && state.status === "signed_out") { armed = false; replacement = client.login(); }
    } });
    await client.login();
    server.user = { subject: "replacement" };
    server.tokenSteps.push({ access_token: "new-token", expires_in: 3600 });
    armed = true;
    await client.logout();
    expect(replacement).toBeDefined();
    await replacement;
    expect(client.token()).toBe("new-token");
    const restarted = makeClient(server).client;
    expect((await restarted.load()).principal?.subject).toBe("replacement");
    expect(restarted.token()).toBe("new-token");
  });

  test("unresponsive revocation cannot block sign-out indefinitely", async () => {
    const server = fakeServer([{ access_token: "old-token", expires_in: 3600 }]);
    const entered = deferredAuth<void>();
    let revokeSignal: AbortSignal | null | undefined;
    const { client } = makeClient(server, { fetchImpl: (async (input, init) => {
      if (String(input).endsWith("/v1/auth/session")) {
        revokeSignal = init?.signal;
        entered.resolve();
        return new Promise<Response>((_resolve, reject) => {
          revokeSignal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
        });
      }
      return server.fetch(input, init);
    }) as typeof fetch });
    await client.login();
    const logout = client.logout();
    await entered.promise;
    expect(client.state().status).toBe("signed_out");
    expect(client.token()).toBeUndefined();
    expect(await readCredentials(home)).toBeUndefined();
    await logout;
    expect(revokeSignal?.aborted).toBe(true);
  }, 10_000);

});
