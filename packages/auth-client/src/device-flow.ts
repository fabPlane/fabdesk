import { z } from "zod/v4";

export const CLIENT_ID = "fabdesk";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const DeviceCodeResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1),
  expires_in: z.number().nonnegative(),
  interval: z.number().nonnegative().default(5),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponse>;

export const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("Bearer"),
  expires_in: z.number().nonnegative(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

const TokenErrorBody = z.object({ error: z.string(), error_description: z.string().optional() });

export const MeUser = z.object({
  subject: z.string(),
  handle: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().optional(),
});
export type MeUser = z.infer<typeof MeUser>;
const MeResponse = z.object({ user: MeUser.nullable() });

export type PollOutcome =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "token"; token: TokenResponse }
  | { status: "error"; error: string; description?: string };

export class AuthHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly path: string,
    detail?: string,
  ) {
    super(`${path} failed with HTTP ${httpStatus}${detail ? `: ${detail}` : ""}`);
    this.name = "AuthHttpError";
  }
}

export function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** `POST /v1/auth/device/code` */
export async function startDeviceAuth(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  opts: { clientLabel: string; scope?: string; signal?: AbortSignal },
): Promise<DeviceCodeResponse> {
  const path = "/v1/auth/device/code";
  const res = await postJson(
    fetchImpl,
    `${normalizeOrigin(apiOrigin)}${path}`,
    {
      client_id: CLIENT_ID,
      client_label: opts.clientLabel,
      ...(opts.scope ? { scope: opts.scope } : {}),
    },
    opts.signal,
  );
  if (!res.ok) throw new AuthHttpError(res.status, path, await bodyText(res));
  return DeviceCodeResponse.parse(await res.json());
}

/** One `POST /v1/auth/device/token` poll; never throws for the RFC 8628 error codes. */
export async function pollDeviceToken(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<PollOutcome> {
  const path = "/v1/auth/device/token";
  const res = await postJson(
    fetchImpl,
    `${normalizeOrigin(apiOrigin)}${path}`,
    { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLIENT_ID },
    signal,
  );
  if (res.ok) return { status: "token", token: TokenResponse.parse(await res.json()) };
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const parsed = TokenErrorBody.safeParse(body);
    const error = parsed.success ? parsed.data.error : `http_${res.status}`;
    if (error === "authorization_pending") return { status: "pending" };
    if (error === "slow_down") return { status: "slow_down" };
    return {
      status: "error",
      error,
      ...(parsed.success && parsed.data.error_description
        ? { description: parsed.data.error_description }
        : {}),
    };
  }
  throw new AuthHttpError(res.status, path, await bodyText(res));
}

export type MeResult = { ok: true; user: MeUser | null } | { ok: false; status: number };

/** `GET /v1/auth/me`; resolves `{ok:false}` for 401/403, throws on network failure or other errors. */
export async function fetchMe(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  token: string,
  signal?: AbortSignal,
): Promise<MeResult> {
  const path = "/v1/auth/me";
  const res = await fetchImpl(`${normalizeOrigin(apiOrigin)}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401 || res.status === 403) return { ok: false, status: res.status };
  if (!res.ok) throw new AuthHttpError(res.status, path, await bodyText(res));
  return { ok: true, user: MeResponse.parse(await res.json()).user };
}

/** `DELETE /v1/auth/session`; best effort, never throws. */
export async function revokeSession(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${normalizeOrigin(apiOrigin)}/v1/auth/session`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}
