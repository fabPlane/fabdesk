import { describe, expect, test } from "bun:test";
import { AccountSession, type AccountTokenStore, type StoredAccount } from "./account-session";

const ORIGIN = "https://api.fabplane.test";

function memoryStore(initial: StoredAccount | null = null): AccountTokenStore & { value: StoredAccount | null } {
  const store = {
    value: initial,
    async read() {
      return store.value;
    },
    async write(account: StoredAccount) {
      store.value = account;
    },
    async clear() {
      store.value = null;
    },
  };
  return store;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("AccountSession", () => {
  test("device flow stores the token and reports the principal", async () => {
    const store = memoryStore();
    const opened: string[] = [];
    let tokenPolls = 0;
    const session = new AccountSession({
      apiOrigin: ORIGIN,
      store,
      clientLabel: "fabdesk-mobile test",
      openUrl: (u) => opened.push(u),
      sleep: async () => {},
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const path = new URL(url).pathname;
        const method = init?.method ?? "GET";
        if (path === "/v1/auth/device/code" && method === "POST") {
          return json({
            device_code: "dev-1",
            user_code: "ABCD-EFGH",
            verification_uri: `${ORIGIN}/device`,
            verification_uri_complete: `${ORIGIN}/device?user_code=ABCD-EFGH`,
            expires_in: 900,
            interval: 0,
          });
        }
        if (path === "/v1/auth/device/token") {
          tokenPolls += 1;
          if (tokenPolls === 1) return json({ error: "authorization_pending" }, 400);
          return json({ access_token: "fpd_ok", token_type: "Bearer", expires_in: 3600 });
        }
        if (path === "/v1/auth/me") {
          return json({
            user: { subject: "user_1", handle: "maya", displayName: "Maya Chen" },
          });
        }
        return new Response("nope", { status: 404 });
      }) as typeof fetch,
    });

    const state = await session.login();
    expect(state.status).toBe("signed_in");
    expect(state.principal).toEqual({
      subject: "user_1",
      handle: "maya",
      displayName: "Maya Chen",
    });
    expect(opened).toEqual([`${ORIGIN}/device?user_code=ABCD-EFGH`]);
    expect(store.value?.token).toBe("fpd_ok");
    expect(session.token()).toBe("fpd_ok");
  });

  test("load trusts a stored session and signs out on 401", async () => {
    const store = memoryStore({
      version: 1,
      apiOrigin: ORIGIN,
      token: "fpd_stale",
      subject: "user_1",
      handle: "maya",
      obtainedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const session = new AccountSession({
      apiOrigin: ORIGIN,
      store,
      fetchImpl: (async () => json({ user: null }, 401)) as unknown as typeof fetch,
    });
    const state = await session.load();
    expect(state.status).toBe("signed_out");
    expect(store.value).toBeNull();
  });

  test("password login against a JSON API stores the token", async () => {
    const store = memoryStore();
    const session = new AccountSession({
      apiOrigin: ORIGIN,
      store,
      sleep: async () => {},
      fetchImpl: (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const path = new URL(url).pathname;
        if (path === "/v1/auth/device/code") {
          return json({
            device_code: "dev-1",
            user_code: "ABCD-EFGH",
            verification_uri: `${ORIGIN}/device`,
            verification_uri_complete: `${ORIGIN}/device?user_code=ABCD-EFGH`,
            expires_in: 900,
            interval: 0,
          });
        }
        if (path === "/v1/auth/password") {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json", "set-cookie": "fp_session=sess; Path=/" },
          });
        }
        if (path === "/v1/auth/device/approve") return json({ status: "approved" });
        if (path === "/v1/auth/device/token") {
          return json({ access_token: "fpd_pw", token_type: "Bearer", expires_in: 3600 });
        }
        if (path === "/v1/auth/me") {
          return json({ user: { subject: "user_1", handle: "maya", displayName: "Maya Chen" } });
        }
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch,
    });
    const state = await session.loginWithPassword({ email: "maya", password: "fabplane-dev" });
    expect(state.status).toBe("signed_in");
    expect(store.value?.token).toBe("fpd_pw");
  });

  test("password login is blocked on production", async () => {
    const session = new AccountSession({
      apiOrigin: "https://api.fabplane.com",
      store: memoryStore(),
      fetchImpl: (async () => new Response("should not be called")) as unknown as typeof fetch,
    });
    const state = await session.loginWithPassword({ email: "maya", password: "fabplane-dev" });
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/Password login is not available on production/);
  });
});
