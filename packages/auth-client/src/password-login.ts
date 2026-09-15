import { AuthHttpError, normalizeOrigin } from "./device-flow";
import { resolveDevAccount } from "./dev-accounts";

export const AUTH_SESSION_COOKIE = "fp_session";

export type PasswordCredentials = {
  email: string;
  password: string;
};

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password.");
    this.name = "InvalidCredentialsError";
  }
}

function isNetworkFailed(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && /network request failed/i.test(err.message));
}

export function cookiesFromResponse(res: Response): string {
  const multi = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const parts = multi
    .map((entry) => entry.split(";")[0]?.trim())
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    const single = res.headers.get("set-cookie");
    const first = single?.split(";")[0]?.trim();
    if (first) parts.push(first);
  }
  return parts.join("; ");
}

export function authErrorFromLocation(location: string | null): string | undefined {
  if (!location) return undefined;
  try {
    return new URL(location, "https://fabplane.invalid/").searchParams.get("auth_error") ?? undefined;
  } catch {
    return undefined;
  }
}

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * `POST /v1/auth/password` with `redirect: "manual"` so the `fp_session` cookie is not lost
 * when Fabplane 302s back to the studio origin.
 */
export async function loginWithPasswordSession(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  credentials: PasswordCredentials,
  signal?: AbortSignal,
): Promise<{ cookies: string }> {
  const account = resolveDevAccount(credentials.email);
  const email = account?.email ?? credentials.email.trim();
  const path = "/v1/auth/password";
  const url = `${normalizeOrigin(apiOrigin)}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password: credentials.password }),
    ...(signal ? { signal } : {}),
  };
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, redirect: "manual" });
  } catch (err) {
    // React Native's fetch throws "Network request failed" for redirect: "manual".
    // Retry without it: JSON password endpoints return 200 + Set-Cookie instead of a 302.
    if (!isNetworkFailed(err)) throw err;
    res = await fetchImpl(url, init);
  }
  if (res.status === 503) throw new AuthHttpError(res.status, path, await bodyText(res));
  if (res.status === 401 || authErrorFromLocation(res.headers.get("location")) === "invalid_credentials") {
    throw new InvalidCredentialsError();
  }
  const cookies = cookiesFromResponse(res);
  if (!cookies.split(/;\s*/).some((part) => part.startsWith(`${AUTH_SESSION_COOKIE}=`))) {
    if (res.status >= 400) throw new AuthHttpError(res.status, path, await bodyText(res));
    throw new InvalidCredentialsError();
  }
  return { cookies };
}

/** Cookie-session `POST /v1/auth/device/approve` used after password login. */
export async function approveDeviceCode(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  opts: { userCode: string; cookies: string; decision?: "approve" | "deny"; signal?: AbortSignal },
): Promise<{ status: string }> {
  const path = "/v1/auth/device/approve";
  const res = await fetchImpl(`${normalizeOrigin(apiOrigin)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: opts.cookies,
    },
    body: JSON.stringify({
      user_code: opts.userCode,
      decision: opts.decision ?? "approve",
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) throw new AuthHttpError(res.status, path, await bodyText(res));
  let status = "approved";
  try {
    const body: unknown = await res.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "status" in body &&
      typeof body.status === "string"
    ) {
      status = body.status;
    }
  } catch {
    /* 200 without JSON is still success */
  }
  return { status };
}
