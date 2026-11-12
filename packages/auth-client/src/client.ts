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

type AuthOperation = { controller: AbortController; signal: AbortSignal };

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
  private operation: AuthOperation | undefined;
  private credentialWork: Promise<void> = Promise.resolve();

  private beginOperation(signal?: AbortSignal): AuthOperation {
    const previous = this.operation;
    const controller = new AbortController();
    const operation = { controller, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal };
    this.operation = operation;
    this.loginInFlight = undefined;
    previous?.controller.abort();
    return operation;
  }

  private isActive(operation: AuthOperation): boolean {
    return this.operation === operation && !operation.signal.aborted;
  }

  // Serialize disk mutations: an old write must finish before logout deletes it,
  // and that deletion must finish before a replacement session writes its token.
  private credentialsTask<T>(run: () => Promise<T>): Promise<T> {
    const next = this.credentialWork.then(run);
    this.credentialWork = next.then(() => undefined, () => undefined);
    return next;
  }

  private async saveCredentials(creds: Credentials, operation: AuthOperation): Promise<void> {
    await this.credentialsTask(async () => {
      if (!this.isActive(operation)) return;
      await writeCredentials(this.opts.home, creds);
      if (this.isActive(operation)) this.creds = creds;
    });
  }

  private cancelOperation(operation: AuthOperation): Promise<AuthState> {
    return this.clearAndSignOut(undefined, operation);
  }

  private async discardToken(operation: AuthOperation, token: string): Promise<AuthState> {
    await this.cancelOperation(operation);
    if (token !== this.token()) await revokeSession(this.fetchImpl, this.apiOrigin, token);
    return this.current;
  }

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

  private setState(next: AuthState, operation?: AuthOperation): AuthState {
    if (operation && !this.isActive(operation)) return this.current;
    this.current = next;
    this.opts.onState?.(next);
    return next;
  }

  private signedOut(error?: string): AuthState {
    this.creds = undefined;
    return this.setState({ mode: "fabplane", status: "signed_out", ...(error ? { error } : {}) });
  }

  private async clearAndSignOut(error?: string, operation = this.operation): Promise<AuthState> {
    if (operation !== this.operation) return this.current;
    const cleared = this.credentialsTask(() => deleteCredentials(this.opts.home)).catch(() => undefined);
    this.signedOut(error);
    await cleared;
    return this.current;
  }

  /**
   * Reads the credentials file and verifies it against `/v1/auth/me`. A network failure keeps the
   * stored identity (offline trust); a 401/403 or `user: null` clears it.
   */
  async load(): Promise<AuthState> {
    if (this.opts.mode === "local") return this.current;
    const operation = this.beginOperation();
    const creds = await this.credentialsTask(() => readCredentials(this.opts.home));
    if (!this.isActive(operation)) return this.cancelOperation(operation);
    if (!creds || normalizeOrigin(creds.apiOrigin) !== this.apiOrigin) return this.signedOut();
    if (Date.parse(creds.expiresAt) <= Date.now()) return this.clearAndSignOut("Session expired. Sign in again.", operation);
    this.creds = creds;
    let me;
    try {
      me = await fetchMe(this.fetchImpl, this.apiOrigin, creds.token, operation.signal);
    } catch (err) {
      if (!this.isActive(operation)) return this.cancelOperation(operation);
      return this.setState({
        mode: "fabplane",
        status: "signed_in",
        principal: principalFrom(creds),
        ...(err instanceof AuthHttpError ? { error: err.message } : {}),
      }, operation);
    }
    if (!this.isActive(operation)) return this.cancelOperation(operation);
    if (!me.ok || me.user === null) return this.clearAndSignOut("Session expired or revoked. Sign in again.", operation);
    const refreshed = await this.storeIdentity(creds, me.user, operation);
    if (!this.isActive(operation)) return this.cancelOperation(operation);
    return this.setState({
      mode: "fabplane",
      status: "signed_in",
      principal: principalFrom(refreshed),
    }, operation);
  }

  private async storeIdentity(creds: Credentials, user: MeUser, operation: AuthOperation): Promise<Credentials> {
    const { handle: _handle, displayName: _name, email: _email, ...session } = creds;
    const next: Credentials = {
      ...session,
      subject: user.subject,
      ...(user.handle ? { handle: user.handle } : {}),
      ...(user.displayName ? { displayName: user.displayName } : {}),
      ...(user.email ? { email: user.email } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(creds))
      await this.saveCredentials(next, operation);
    if (this.isActive(operation)) this.creds = next;
    return next;
  }

  /** Runs the device flow; resolves with the resulting state (never rejects for flow outcomes). */
  login(signal?: AbortSignal): Promise<AuthState> {
    return this.startLogin(operation => this.runLogin(operation), signal);
  }

  /**
   * Password-assisted device flow: `POST /v1/auth/password` for an `fp_session` cookie,
   * then `POST /v1/auth/device/approve` and the usual token poll. Used by the CLI/UI
   * with fabPlane's local/staging accounts (`demo@fabplane.dev`, `maya@fabplane.dev`).
   */
  loginWithPassword(credentials: PasswordCredentials, signal?: AbortSignal): Promise<AuthState> {
    return this.startLogin(operation => this.runPasswordLogin(credentials, operation), signal);
  }

  private startLogin(run: (operation: AuthOperation) => Promise<AuthState>, signal?: AbortSignal): Promise<AuthState> {
    if (this.opts.mode === "local") return Promise.resolve(this.current);
    if (this.loginInFlight && this.operation && this.isActive(this.operation)) return this.loginInFlight;
    const operation = this.beginOperation(signal);
    const pending = run(operation).catch(error => {
      if (!this.isActive(operation)) return this.cancelOperation(operation);
      throw error;
    }).finally(() => {
      if (this.loginInFlight === pending) this.loginInFlight = undefined;
    });
    this.loginInFlight = pending;
    return pending;
  }

  private async beginDeviceGrant(
    operation: AuthOperation,
    opts?: { publishPending?: boolean },
  ): Promise<{ device: DeviceCodeResponse; deadline: number } | AuthState> {
    const { signal } = operation;
    if (!this.isActive(operation)) return this.cancelOperation(operation);
    const label = this.opts.clientLabel ?? `fabdesk on ${hostname()}`;
    let device;
    try {
      device = await startDeviceAuth(this.fetchImpl, this.apiOrigin, {
        clientLabel: label,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err) || !this.isActive(operation)) return this.cancelOperation(operation);
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: `Could not start sign-in: ${errorMessage(err)}`,
      }, operation);
    }
    if (!this.isActive(operation)) return this.cancelOperation(operation);
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
      }, operation);
    }
    return { device, deadline };
  }

  private async runLogin(operation: AuthOperation): Promise<AuthState> {
    const started = await this.beginDeviceGrant(operation);
    if (!("device" in started)) return started;
    if (!this.isActive(operation)) return this.cancelOperation(operation);
    try {
      this.opts.openUrl?.(started.device.verification_uri_complete);
    } catch {
      /* the UI still shows the code */
    }
    return this.pollForToken(started.device, started.deadline, operation);
  }

  private async runPasswordLogin(
    credentials: PasswordCredentials,
    operation: AuthOperation,
  ): Promise<AuthState> {
    const { signal } = operation;
    if (!this.isActive(operation)) return this.cancelOperation(operation);
    if (!credentials.email.trim() || !credentials.password) {
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: "Email and password are required.",
      }, operation);
    }
    if (isProductionFabplaneOrigin(this.apiOrigin)) {
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: PRODUCTION_PASSWORD_LOGIN_BLOCKED,
      }, operation);
    }
    const started = await this.beginDeviceGrant(operation, { publishPending: false });
    if (!("device" in started)) return started;
    try {
      const { cookies } = await loginWithPasswordSession(
        this.fetchImpl,
        this.apiOrigin,
        credentials,
        signal,
      );
      if (!this.isActive(operation)) return this.cancelOperation(operation);
      await approveDeviceCode(this.fetchImpl, this.apiOrigin, {
        userCode: started.device.user_code,
        cookies,
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err) || !this.isActive(operation)) return this.cancelOperation(operation);
      if (err instanceof InvalidCredentialsError) {
        return this.setState({ mode: "fabplane", status: "error", error: err.message }, operation);
      }
      return this.setState({
        mode: "fabplane",
        status: "error",
        error: describePasswordLoginError(err),
      }, operation);
    }
    return this.pollForToken(started.device, started.deadline, operation, { immediate: true });
  }

  private async pollForToken(
    device: DeviceCodeResponse,
    deadline: number,
    operation: AuthOperation,
    opts?: { immediate?: boolean },
  ): Promise<AuthState> {
    const { signal } = operation;
    let intervalSec = Math.max(device.interval, MIN_INTERVAL_SEC);
    let wait = opts?.immediate !== true;
    for (;;) {
      if (!this.isActive(operation)) return this.cancelOperation(operation);
      if (wait) await this.sleep(intervalSec * 1000, signal);
      wait = true;
      if (!this.isActive(operation)) return this.cancelOperation(operation);
      if (Date.now() >= deadline)
        return this.setState({
          mode: "fabplane",
          status: "error",
          error: "Sign-in code expired. Start again.",
        }, operation);
      let outcome;
      try {
        outcome = await pollDeviceToken(this.fetchImpl, this.apiOrigin, device.device_code, signal);
      } catch (err) {
        if (isAbortError(err) || !this.isActive(operation)) return this.cancelOperation(operation);
        // Transient network/server trouble: keep polling until the code expires.
        continue;
      }
      if (!this.isActive(operation)) return outcome.status === "token"
        ? this.discardToken(operation, outcome.token.access_token)
        : this.cancelOperation(operation);
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
          }, operation);
        case "token":
          return this.completeLogin(outcome.token.access_token, outcome.token.expires_in, operation);
      }
    }
  }

  private async completeLogin(token: string, expiresInSec: number, operation: AuthOperation): Promise<AuthState> {
    const now = Date.now();
    let user: MeUser | undefined;
    try {
      const me = await fetchMe(this.fetchImpl, this.apiOrigin, token, operation.signal);
      if (!this.isActive(operation)) return this.discardToken(operation, token);
      if (!me.ok || me.user === null) {
        return this.setState({
          mode: "fabplane",
          status: "error",
          error: "Sign-in succeeded but the token was rejected. Try again.",
        }, operation);
      }
      user = me.user;
    } catch {
      user = undefined; // offline right after approval: store the token, verify on next load()
    }
    if (!this.isActive(operation)) return this.discardToken(operation, token);
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
    await this.saveCredentials(creds, operation);
    if (!this.isActive(operation)) return this.discardToken(operation, token);
    return this.setState({
      mode: "fabplane",
      status: "signed_in",
      principal: principalFrom(user ?? creds),
    }, operation);
  }

  /** Revokes the server session (best effort), deletes the credentials file, emits `signed_out`. */
  async logout(): Promise<void> {
    if (this.opts.mode === "local") return;
    const operation = this.beginOperation();
    const token = this.creds?.token;
    const stored = token ? Promise.resolve(token) : this.credentialsTask(async () => (await readCredentials(this.opts.home))?.token);
    const cleared = this.clearAndSignOut(undefined, operation);
    const revoke = token ?? await stored;
    await cleared;
    if (revoke) await revokeSession(this.fetchImpl, this.apiOrigin, revoke);
  }

  /** `fetch` with the bearer token attached; a 401 clears the stored credentials and emits `signed_out`. */
  async authorizedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const token = this.token();
    const operation = this.operation;
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const res = await this.fetchImpl(input, { ...init, headers });
    if (res.status === 401 && token && token === this.token() && operation === this.operation && this.opts.mode === "fabplane") {
      await this.clearAndSignOut("Session expired. Sign in again.", operation);
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
