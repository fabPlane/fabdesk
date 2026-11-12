import type { AuthState, Principal } from "@fabdesk/protocol";
import { hostname } from "node:os";
import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
  type Credentials,
} from "./credential-store";
import {
  AuthHttpError,
  fetchMe,
  normalizeOrigin,
  pollDeviceToken,
  revokeSession,
  startDeviceAuth,
  type DeviceCodeResponse,
  type MeUser,
} from "./device-flow";
import { isProductionFabplaneOrigin, PRODUCTION_PASSWORD_LOGIN_BLOCKED } from "./dev-accounts";
import { LOCAL_PRINCIPAL } from "./home";
import {
  approveDeviceCode,
  InvalidCredentialsError,
  loginWithPasswordSession,
  type PasswordCredentials,
} from "./password-login";

export interface AuthClientOptions {
  /** FABDESK_HOME: where `credentials.json` lives. */
  home: string;
  apiOrigin: string;
  mode: "fabplane" | "local";
  clientLabel?: string;
  fetchImpl?: typeof fetch;
  onState?(state: AuthState): void;
  openUrl?(url: string): void;
  /** Test hook: replaces the abortable sleep used between token polls. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

/** RFC 8628: a `slow_down` response adds 5 seconds to the polling interval. */
const SLOW_DOWN_STEP_SEC = 5;
const MIN_INTERVAL_SEC = 1;

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function principalFrom(user: MeUser | Credentials): Principal {
  return {
    subject: user.subject,
    ...(user.handle ? { handle: user.handle } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...("email" in user && user.email ? { email: user.email } : {}),
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Owns the fabplane device-authorization session for the daemon: credentials file, device flow,
 * bearer fetches. State machine: `signed_out → pending → signed_in | error`; local mode is always
 * `signed_in` as `LOCAL_PRINCIPAL` and never talks to fabplane.
 */
export class AuthClient {
  private readonly opts: AuthClientOptions;
  private readonly apiOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private current: AuthState;
  private creds: Credentials | undefined;
  private loginInFlight: Promise<AuthState> | undefined;

  constructor(opts: AuthClientOptions) {
    this.opts = opts;
    this.apiOrigin = normalizeOrigin(opts.apiOrigin);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.current =
      opts.mode === "local"
        ? { mode: "local", status: "signed_in", principal: { ...LOCAL_PRINCIPAL } }
        : { mode: "fabplane", status: "signed_out" };
  }

  state(): AuthState {
    return this.current;
  }

  token(): string | undefined {
    return this.opts.mode === "local" ? undefined : this.creds?.token;
  }

  private setState(next: AuthState): AuthState {
    this.current = next;
    this.opts.onState?.(next);
    return next;
  }

  private signedOut(error?: string): AuthState {
    this.creds = undefined;
    return this.setState({ mode: "fabplane", status: "signed_out", ...(error ? { error } : {}) });
  }

  private async clearAndSignOut(error?: string): Promise<AuthState> {
    await deleteCredentials(this.opts.home).catch(() => undefined);
    return this.signedOut(error);
  }

  /**
   * Reads the credentials file and verifies it against `/v1/auth/me`. A network failure keeps the
   * stored identity (offline trust); a 401/403 or `user: null` clears it.
   */
  async load(): Promise<AuthState> {
    if (this.opts.mode === "local") return this.current;
    const creds = await readCredentials(this.opts.home);
    if (!creds || normalizeOrigin(creds.apiOrigin) !== this.apiOrigin) return this.signedOut();
    if (Date.parse(creds.expiresAt) <= Date.now()) return this.clearAndSignOut("Session expired. Sign in again.");
    this.creds = creds;
    let me;
    try {
      me = await fetchMe(this.fetchImpl, this.apiOrigin, creds.token);
    } catch (err) {
      if (err instanceof AuthHttpError) {
        // Server-side trouble (5xx): keep the file, but tell the UI why we cannot confirm.
        return this.setState({
          mode: "fabplane",
          status: "signed_in",
          principal: principalFrom(creds),
          error: err.message,
        });
      }
      return this.setState({
        mode: "fabplane",
        status: "signed_in",
        principal: principalFrom(creds),
      });
    }
    if (!me.ok || me.user === null) return this.clearAndSignOut("Session expired or revoked. Sign in again.");
    const refreshed = await this.storeIdentity(creds, me.user);
    return this.setState({
      mode: "fabplane",
      status: "signed_in",
      principal: principalFrom(refreshed),
    });
  }

  private async storeIdentity(creds: Credentials, user: MeUser): Promise<Credentials> {
    const { handle: _handle, displayName: _name, email: _email, ...session } = creds;
    const next: Credentials = {
      ...session,
      subject: user.subject,
      ...(user.handle ? { handle: user.handle } : {}),
      ...(user.displayName ? { displayName: user.displayName } : {}),
      ...(user.email ? { email: user.email } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(creds))
      await writeCredentials(this.opts.home, next);
    this.creds = next;
    return next;
  }

  /** Runs the device flow; resolves with the resulting state (never rejects for flow outcomes). */
  login(signal?: AbortSignal): Promise<AuthState> {
    return this.startLogin(() => this.runLogin(signal));
  }

  /**
   * Password-assisted device flow: `POST /v1/auth/password` for an `fp_session` cookie,
   * then `POST /v1/auth/device/approve` and the usual token poll. Used by the CLI/UI
   * with fabPlane's local/staging accounts (`demo@fabplane.dev`, `maya@fabplane.dev`).
   */
  loginWithPassword(credentials: PasswordCredentials, signal?: AbortSignal): Promise<AuthState> {
    return this.startLogin(() => this.runPasswordLogin(credentials, signal));
  }

  private startLogin(run: () => Promise<AuthState>): Promise<AuthState> {
    if (this.opts.mode === "local") return Promise.resolve(this.current);
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = run().finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  private async beginDeviceGrant(
    signal?: AbortSignal,
    opts?: { publishPending?: boolean },
  ): Promise<{ device: DeviceCodeResponse; deadline: number } | AuthState> {
    const label = this.opts.clientLabel ?? `fabdesk on ${hostname()}`;
    let device;
    try {
      device = await startDeviceAuth(this.fetchImpl, this.apiOrigin, {
        clientLabel: label,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return this.signedOut();
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: `Could not start sign-in: ${errorMessage(err)}`,
      });
    }
    const deadline = Date.now() + device.expires_in * 1000;
    if (opts?.publishPending !== false) {
      this.setState({
        mode: "fabplane",
        status: "pending",
        pending: {
          userCode: device.user_code,
          verificationUri: device.verification_uri,
          verificationUriComplete: device.verification_uri_complete,
          expiresAt: new Date(deadline).toISOString(),
        },
      });
    }
    return { device, deadline };
  }

  private async runLogin(signal?: AbortSignal): Promise<AuthState> {
    const started = await this.beginDeviceGrant(signal);
    if (!("device" in started)) return started;
    try {
      this.opts.openUrl?.(started.device.verification_uri_complete);
    } catch {
      /* the UI still shows the code */
    }
    return this.pollForToken(started.device, started.deadline, signal);
  }

  private async runPasswordLogin(
    credentials: PasswordCredentials,
    signal?: AbortSignal,
  ): Promise<AuthState> {
    if (!credentials.email.trim() || !credentials.password) {
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: "Email and password are required.",
      });
    }
    if (isProductionFabplaneOrigin(this.apiOrigin)) {
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: PRODUCTION_PASSWORD_LOGIN_BLOCKED,
      });
    }
    const started = await this.beginDeviceGrant(signal, { publishPending: false });
    if (!("device" in started)) return started;
    try {
      const { cookies } = await loginWithPasswordSession(
        this.fetchImpl,
        this.apiOrigin,
        credentials,
        signal,
      );
      await approveDeviceCode(this.fetchImpl, this.apiOrigin, {
        userCode: started.device.user_code,
        cookies,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return this.signedOut();
      if (err instanceof InvalidCredentialsError) {
        return this.setState({ mode: "fabplane", status: "error", error: err.message });
      }
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: describePasswordLoginError(err),
      });
    }
    return this.pollForToken(started.device, started.deadline, signal, { immediate: true });
  }

  private async pollForToken(
    device: DeviceCodeResponse,
    deadline: number,
    signal?: AbortSignal,
    opts?: { immediate?: boolean },
  ): Promise<AuthState> {
    let intervalSec = Math.max(device.interval, MIN_INTERVAL_SEC);
    let wait = opts?.immediate !== true;
    for (;;) {
      if (wait) await this.sleep(intervalSec * 1000, signal);
      wait = true;
      if (signal?.aborted) return this.signedOut();
      if (Date.now() >= deadline)
        return this.setState({
          mode: "fabplane",
          status: "error",
          error: "Sign-in code expired. Start again.",
        });
      let outcome;
      try {
        outcome = await pollDeviceToken(this.fetchImpl, this.apiOrigin, device.device_code, signal);
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) return this.signedOut();
        // Transient network/server trouble: keep polling until the code expires.
        continue;
      }
      switch (outcome.status) {
        case "pending":
          continue;
        case "slow_down":
          intervalSec += SLOW_DOWN_STEP_SEC;
          continue;
        case "error":
          return this.setState({
            mode: "fabplane",
            status: "error",
            error: describeTokenError(outcome.error, outcome.description),
          });
        case "token":
          return this.completeLogin(outcome.token.access_token, outcome.token.expires_in);
      }
    }
  }

  private async completeLogin(token: string, expiresInSec: number): Promise<AuthState> {
    const now = Date.now();
    let user: MeUser | undefined;
    try {
      const me = await fetchMe(this.fetchImpl, this.apiOrigin, token);
      if (!me.ok || me.user === null) {
        return this.setState({
          mode: "fabplane",
          status: "error",
          error: "Sign-in succeeded but the token was rejected. Try again.",
        });
      }
      user = me.user;
    } catch {
      user = undefined; // offline right after approval: store the token, verify on next load()
    }
    const creds: Credentials = {
      version: 1,
      apiOrigin: this.apiOrigin,
      token,
      subject: user?.subject ?? "",
      ...(user?.handle ? { handle: user.handle } : {}),
      ...(user?.displayName ? { displayName: user.displayName } : {}),
      ...(user?.email ? { email: user.email } : {}),
      obtainedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInSec * 1000).toISOString(),
    };
    await writeCredentials(this.opts.home, creds);
    this.creds = creds;
    return this.setState({
      mode: "fabplane",
      status: "signed_in",
      principal: principalFrom(user ?? creds),
    });
  }

  /** Revokes the server session (best effort), deletes the credentials file, emits `signed_out`. */
  async logout(): Promise<void> {
    if (this.opts.mode === "local") return;
    const token = this.creds?.token ?? (await readCredentials(this.opts.home))?.token;
    if (token) await revokeSession(this.fetchImpl, this.apiOrigin, token);
    await this.clearAndSignOut();
  }

  /** `fetch` with the bearer token attached; a 401 clears the stored credentials and emits `signed_out`. */
  async authorizedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const token = this.token();
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const res = await this.fetchImpl(input, { ...init, headers });
    if (res.status === 401 && token && this.opts.mode === "fabplane") {
      await this.clearAndSignOut("Session expired. Sign in again.");
    }
    return res;
  }
}

function describeTokenError(error: string, description?: string): string {
  switch (error) {
    case "expired_token":
      return "Sign-in code expired. Start again.";
    case "access_denied":
      return "Sign-in was denied.";
    case "invalid_grant":
      return "Sign-in request is no longer valid. Start again.";
    default:
      return description ? `${error}: ${description}` : `Sign-in failed (${error}).`;
  }
}

function describePasswordLoginError(err: unknown): string {
  if (err instanceof AuthHttpError) {
    if (err.path === "/v1/auth/password" && err.httpStatus === 503) {
      return "Password login is not available on this fabPlane server.";
    }
    if (err.path === "/v1/auth/device/approve") {
      if (err.httpStatus === 401) return "Sign-in session was rejected. Check the email and password.";
      if (err.httpStatus === 503) return "Device approval is not available on this fabPlane server.";
      if (err.httpStatus === 404) return "Sign-in code was not found. Start again.";
    }
  }
  return `Could not complete password sign-in: ${errorMessage(err)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
