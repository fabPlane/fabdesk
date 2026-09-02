import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthState } from "@fabdesk/protocol";
import { AuthClient } from "./client";
import { readCredentials } from "./credential-store";
import {
  DEV_PASSWORD,
  DEV_PASSWORD_ACCOUNTS,
  PRODUCTION_PASSWORD_LOGIN_BLOCKED,
  isProductionFabplaneOrigin,
  isSharedDevPasswordLogin,
  passwordSubjectFor,
  resolveDevAccount,
} from "./dev-accounts";
import { DEVICE_GRANT } from "./device-flow";
import {
  AUTH_SESSION_COOKIE,
  authErrorFromLocation,
  cookiesFromResponse,
} from "./password-login";

const ORIGIN = "https://api.fabplane.test";

let home: string;
beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "fabdesk-pw-")), "home");
});
afterEach(() => {
  rmSync(join(home, ".."), { recursive: true, force: true });
});

type Account = (typeof DEV_PASSWORD_ACCOUNTS)[number];

type Grant = {
  deviceCode: string;
  userCode: string;
  status: "pending" | "approved" | "denied";
  user?: Account;
};

type Recorded = { method: string; url: string; body?: unknown; cookie?: string; auth?: string };

function fabplaneFake(opts: { passwordEnabled?: boolean } = {}) {
  let passwordEnabled = opts.passwordEnabled ?? true;
  let seq = 0;
  const sessions = new Map<string, Account>();
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, Account>();
  const requests: Recorded[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? undefined;
    const cookie = headers.get("cookie") ?? undefined;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({
      method,
      url,
      ...(body !== undefined ? { body } : {}),
      ...(cookie ? { cookie } : {}),
      ...(auth ? { auth } : {}),
    });
    const path = new URL(url).pathname;

    if (path === "/v1/auth/device/code" && method === "POST") {
      expect(body).toMatchObject({ client_id: "fabdesk" });
      seq += 1;
      const deviceCode = `dev-${seq}`;
      const userCode = `ABCD-${String(seq).padStart(4, "0")}`;
      grants.set(deviceCode, { deviceCode, userCode, status: "pending" });
      return Response.json({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${ORIGIN}/device`,
        verification_uri_complete: `${ORIGIN}/device?user_code=${userCode}`,
        expires_in: 900,
        interval: 0,
      });
    }

    if (path === "/v1/auth/password" && method === "POST") {
      if (!passwordEnabled) {
        return Response.json({ error: "authentication_unavailable" }, { status: 503 });
      }
      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const email = typeof record.email === "string" ? record.email : "";
      const password = typeof record.password === "string" ? record.password : "";
      const account = DEV_PASSWORD_ACCOUNTS.find((a) => a.email === email);
      const headersOut = new Headers();
      if (!account || account.password !== password) {
        headersOut.set("location", "https://app.fabplane.test/login?auth_error=invalid_credentials");
        return new Response(null, { status: 302, headers: headersOut });
      }
      const session = `sess_${account.handle}_${seq + 1}`;
      sessions.set(session, account);
      headersOut.append("set-cookie", `${AUTH_SESSION_COOKIE}=${session}; HttpOnly; Path=/`);
      headersOut.append("set-cookie", `fp_user=${account.handle}; Path=/`);
      headersOut.set("location", "https://app.fabplane.test/");
      return new Response(null, { status: 302, headers: headersOut });
    }

    if (path === "/v1/auth/device/approve" && method === "POST") {
      const contentType = headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return Response.json({ error: "invalid_request" }, { status: 415 });
      }
      const session = cookie
        ?.split(/;\s*/)
        .find((part) => part.startsWith(`${AUTH_SESSION_COOKIE}=`))
        ?.slice(`${AUTH_SESSION_COOKIE}=`.length);
      const user = session ? sessions.get(session) : undefined;
      if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
      const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const userCode = typeof rec.user_code === "string" ? rec.user_code : "";
      const decision = rec.decision === "deny" ? "deny" : rec.decision === "approve" ? "approve" : "";
      if (!userCode || !decision) return Response.json({ error: "invalid_request" }, { status: 400 });
      const grant = [...grants.values()].find((g) => g.userCode === userCode);
      if (!grant || grant.status !== "pending") return Response.json({ error: "not_found" }, { status: 404 });
      grant.status = decision === "approve" ? "approved" : "denied";
      grant.user = user;
      return Response.json({ status: grant.status });
    }

    if (path === "/v1/auth/device/token" && method === "POST") {
      expect(body).toMatchObject({
        grant_type: DEVICE_GRANT,
        client_id: "fabdesk",
      });
      const deviceCode =
        body && typeof body === "object" && "device_code" in body && typeof body.device_code === "string"
          ? body.device_code
          : "";
      const grant = grants.get(deviceCode);
      if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (grant.status === "denied") return Response.json({ error: "access_denied" }, { status: 400 });
      if (grant.status !== "approved" || !grant.user) {
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      const token = `fpd_${grant.user.handle}_${grant.deviceCode}`;
      tokens.set(token, grant.user);
      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 2592000 });
    }

    if (path === "/v1/auth/me" && method === "GET") {
      const token = auth?.replace(/^Bearer /, "");
      const user = token ? tokens.get(token) : undefined;
      if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({
        user: {
          subject: passwordSubjectFor(user.email),
          handle: user.handle,
          displayName: user.displayName,
          email: user.email,
        },
      });
    }

    if (path === "/v1/auth/session" && method === "DELETE") {
      const token = auth?.replace(/^Bearer /, "") ?? "";
      tokens.delete(token);
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    setPasswordEnabled(value: boolean) {
      passwordEnabled = value;
    },
  };
}

function makeClient(server: ReturnType<typeof fabplaneFake>) {
  const states: AuthState[] = [];
  const client = new AuthClient({
    home,
    apiOrigin: `${ORIGIN}/`,
    mode: "fabplane",
    clientLabel: "fabdesk test",
    fetchImpl: server.fetch,
    onState: (s) => states.push(s),
    sleep: async () => {},
  });
  return { client, states };
}

describe("Fabplane test accounts", () => {
  test("resolve demo and maya by email or handle", () => {
    expect(resolveDevAccount("demo")).toEqual(DEV_PASSWORD_ACCOUNTS[0]);
    expect(resolveDevAccount("MAYA@fabplane.dev")).toEqual(DEV_PASSWORD_ACCOUNTS[1]);
    expect(resolveDevAccount("unknown")).toBeUndefined();
    expect(passwordSubjectFor("Maya@fabplane.dev")).toBe("password:maya@fabplane.dev");
    expect(isSharedDevPasswordLogin("maya", DEV_PASSWORD)).toBe(true);
    expect(isSharedDevPasswordLogin("maya@fabplane.dev", "other")).toBe(false);
    expect(isProductionFabplaneOrigin("https://api.fabplane.com/")).toBe(true);
    expect(isProductionFabplaneOrigin("https://api-staging.fabplane.com")).toBe(false);
  });

  test("cookiesFromResponse and auth_error parsing match Fabplane redirects", () => {
    const headers = new Headers();
    headers.append("set-cookie", `${AUTH_SESSION_COOKIE}=sess_maya; HttpOnly; Path=/`);
    headers.append("set-cookie", "fp_user=maya; Path=/");
    headers.set("location", "https://app.fabplane.test/device?ok=1");
    const res = new Response(null, { status: 302, headers });
    expect(cookiesFromResponse(res)).toBe(`${AUTH_SESSION_COOKIE}=sess_maya; fp_user=maya`);
    expect(authErrorFromLocation(res.headers.get("location"))).toBeUndefined();
    expect(authErrorFromLocation("https://app.fabplane.test/login?auth_error=invalid_credentials")).toBe(
      "invalid_credentials",
    );
  });
});

describe("AuthClient.loginWithPassword", () => {
  test("logs in every Fabplane test account through password + device approve", async () => {
    const server = fabplaneFake();
    expect(DEV_PASSWORD_ACCOUNTS).toHaveLength(2);

    for (const account of DEV_PASSWORD_ACCOUNTS) {
      const { client, states } = makeClient(server);
      const result = await client.loginWithPassword({
        email: account.handle,
        password: account.password,
      });
      expect(result).toEqual({
        mode: "fabplane",
        status: "signed_in",
        principal: {
          subject: passwordSubjectFor(account.email),
          handle: account.handle,
          displayName: account.displayName,
          email: account.email,
        },
      });
      expect(client.token()?.startsWith("fpd_")).toBe(true);
      expect(client.token()).toContain(account.handle);

      const stored = await readCredentials(home);
      expect(stored).toMatchObject({
        apiOrigin: ORIGIN,
        subject: passwordSubjectFor(account.email),
        handle: account.handle,
        displayName: account.displayName,
      });
      expect(stored?.token.startsWith("fpd_")).toBe(true);

      const passwordReq = server.requests.find(
        (r) => r.url.endsWith("/v1/auth/password") && (r.body as { email?: string }).email === account.email,
      );
      expect(passwordReq?.body).toEqual({ email: account.email, password: DEV_PASSWORD });

      const approveReq = server.requests.filter((r) => r.url.endsWith("/v1/auth/device/approve")).at(-1);
      expect(approveReq?.cookie).toContain(`${AUTH_SESSION_COOKIE}=`);
      expect(approveReq?.body).toMatchObject({ decision: "approve" });

      const meReq = server.requests.filter((r) => r.url.endsWith("/v1/auth/me")).at(-1);
      expect(meReq?.auth).toBe(`Bearer ${client.token()}`);

      expect(states.some((s) => s.status === "pending")).toBe(false);
      expect(states.at(-1)?.status).toBe("signed_in");

      await client.logout();
      expect(client.state()).toEqual({ mode: "fabplane", status: "signed_out" });
      expect(await readCredentials(home)).toBeUndefined();
    }
  });

  test("rejects the wrong password without storing credentials", async () => {
    const server = fabplaneFake();
    const { client } = makeClient(server);
    expect(
      await client.loginWithPassword({ email: "maya@fabplane.dev", password: "wrong" }),
    ).toEqual({
      mode: "fabplane",
      status: "error",
      error: "Invalid email or password.",
    });
    expect(client.token()).toBeUndefined();
    expect(await readCredentials(home)).toBeUndefined();
    expect(server.requests.some((r) => r.url.endsWith("/v1/auth/device/approve"))).toBe(false);
  });

  test("surfaces production-style password-login 503", async () => {
    const server = fabplaneFake({ passwordEnabled: false });
    const { client } = makeClient(server);
    expect(
      await client.loginWithPassword({ email: "demo@fabplane.dev", password: DEV_PASSWORD }),
    ).toEqual({
      mode: "fabplane",
      status: "error",
      error: "Password login is not available on this Fabplane server.",
    });
  });

  test("requires email and password", async () => {
    const server = fabplaneFake();
    const { client } = makeClient(server);
    expect(await client.loginWithPassword({ email: "  ", password: DEV_PASSWORD })).toMatchObject({
      status: "error",
      error: "Email and password are required.",
    });
    expect(server.requests).toHaveLength(0);
  });

  test("refuses every password login against production before any request", async () => {
    const server = fabplaneFake();
    const client = new AuthClient({
      home,
      apiOrigin: "https://api.fabplane.com",
      mode: "fabplane",
      fetchImpl: server.fetch,
      sleep: async () => {},
    });
    for (const credentials of [
      { email: "maya", password: DEV_PASSWORD },
      { email: "someone@fabplane.com", password: "not-the-seed" },
    ]) {
      expect(await client.loginWithPassword(credentials)).toEqual({
        mode: "fabplane",
        status: "error",
        error: PRODUCTION_PASSWORD_LOGIN_BLOCKED,
      });
    }
    expect(server.requests).toHaveLength(0);
    expect(await readCredentials(home)).toBeUndefined();
  });
});
