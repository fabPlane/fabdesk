/**
 * Local fabplane.com stand-in for the Android emulator / iOS simulator.
 *
 *   bun apps/mobile/scripts/mock-cloud-api.ts
 *
 * Then start Expo with:
 *
 *   EXPO_PUBLIC_FABPLANE_API_ORIGIN=http://10.0.2.2:4077 bun run mobile
 *
 * Password: maya / fabplane-dev (or demo). Production password login stays blocked.
 */
const PORT = Number(process.env["MOCK_CLOUD_PORT"] ?? 4077);
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Device = {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  approved: boolean;
  consumed: boolean;
};

type Session = { email: string };

const devices = new Map<string, Device>();
const sessions = new Map<string, Session>();
const tokens = new Map<string, { subject: string; handle: string; displayName: string; email: string }>();
let settings: Record<string, unknown> | null = null;

const ACCOUNTS: Record<string, { email: string; handle: string; displayName: string; password: string }> = {
  maya: {
    email: "maya@fabplane.dev",
    handle: "maya",
    displayName: "Maya Chen",
    password: "fabplane-dev",
  },
  "maya@fabplane.dev": {
    email: "maya@fabplane.dev",
    handle: "maya",
    displayName: "Maya Chen",
    password: "fabplane-dev",
  },
  demo: {
    email: "demo@fabplane.dev",
    handle: "demo",
    displayName: "Demo Engineer",
    password: "fabplane-dev",
  },
  "demo@fabplane.dev": {
    email: "demo@fabplane.dev",
    handle: "demo",
    displayName: "Demo Engineer",
    password: "fabplane-dev",
  },
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = /^Bearer\s+(.+)$/i.exec(h ?? "");
  return m?.[1] ?? null;
}

function sessionCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const part = cookie.split(/;\s*/).find((p) => p.startsWith("fp_session="));
  return part ? part.slice("fp_session=".length) : null;
}

function userCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/livez") return json({ status: "ok" });

    if (path === "/v1/auth/device/code" && req.method === "POST") {
      const deviceCode = `dev_${crypto.randomUUID()}`;
      const code = userCode();
      devices.set(deviceCode, {
        deviceCode,
        userCode: code,
        expiresAt: Date.now() + 900_000,
        approved: false,
        consumed: false,
      });
      return json({
        device_code: deviceCode,
        user_code: code,
        verification_uri: `${ORIGIN}/device`,
        verification_uri_complete: `${ORIGIN}/device?user_code=${code}`,
        expires_in: 900,
        interval: 1,
      });
    }

    if (path === "/v1/auth/device/token" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { device_code?: string };
      const rec = body.device_code ? devices.get(body.device_code) : undefined;
      if (!rec) return json({ error: "invalid_grant" }, 400);
      if (Date.now() > rec.expiresAt) return json({ error: "expired_token" }, 400);
      if (!rec.approved) return json({ error: "authorization_pending" }, 400);
      if (rec.consumed) return json({ error: "invalid_grant" }, 400);
      rec.consumed = true;
      const token = `fpd_mock_${crypto.randomUUID()}`;
      tokens.set(token, {
        subject: "password:maya@fabplane.dev",
        handle: "maya",
        displayName: "Maya Chen",
        email: "maya@fabplane.dev",
      });
      return json({ access_token: token, token_type: "Bearer", expires_in: 86400 });
    }

    if (path === "/v1/auth/password" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
      const account = ACCOUNTS[(body.email ?? "").trim().toLowerCase()];
      if (!account || account.password !== body.password) {
        return new Response(null, {
          status: 302,
          headers: { location: `${ORIGIN}/?auth_error=invalid_credentials` },
        });
      }
      const sid = `sess_${crypto.randomUUID()}`;
      sessions.set(sid, { email: account.email });
      // React Native cannot round-trip the session cookie on a 302, so a successful
      // password login also approves every pending device code. Desktop still uses
      // the cookie + /device/approve path.
      for (const rec of devices.values()) {
        if (!rec.consumed && Date.now() < rec.expiresAt) rec.approved = true;
      }
      return json(
        { status: "ok" },
        200,
        { "set-cookie": `fp_session=${sid}; Path=/; HttpOnly` },
      );
    }

    if (path === "/v1/auth/device/approve" && req.method === "POST") {
      const sid = sessionCookie(req);
      if (!sid || !sessions.has(sid)) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => ({}))) as { user_code?: string };
      const rec = [...devices.values()].find((d) => d.userCode === body.user_code);
      if (!rec) return json({ error: "not_found" }, 404);
      rec.approved = true;
      return json({ status: "approved" });
    }

    if (path === "/v1/auth/me" && req.method === "GET") {
      const token = bearer(req);
      const user = token ? tokens.get(token) : undefined;
      if (!user) return json({ user: null });
      return json({ user });
    }

    if (path === "/v1/auth/session" && req.method === "DELETE") {
      const token = bearer(req);
      if (token) tokens.delete(token);
      return new Response(null, { status: 204 });
    }

    if (path === "/v1/private/settings" && req.method === "GET") {
      const token = bearer(req);
      if (!token || !tokens.has(token)) return json({ error: "unauthorized" }, 401);
      return json(settings ?? { schema: 1, updatedAt: 0 });
    }

    if (path === "/v1/private/settings" && req.method === "PUT") {
      const token = bearer(req);
      if (!token || !tokens.has(token)) return json({ error: "unauthorized" }, 401);
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || body.schema !== 1 || typeof body.updatedAt !== "number") {
        return json({ error: "invalid_settings" }, 400);
      }
      settings = body;
      return json(body);
    }

    return json({ error: "not_found" }, 404);
  },
});

process.stdout.write(`mock fabplane API on ${ORIGIN}\n`);
