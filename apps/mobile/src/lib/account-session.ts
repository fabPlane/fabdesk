/**
 * fabplane.com session for the phone: device-code (and staging password) login, SecureStore-backed
 * token, no Node filesystem. Mirrors `AuthClient` without importing it.
 */
import type { Principal } from "@fabdesk/protocol";
import {
  approveDeviceCode,
  AuthHttpError,
  fetchMe,
  InvalidCredentialsError,
  isProductionFabplaneOrigin,
  loginWithPasswordSession,
  normalizeOrigin,
  pollDeviceToken,
  PRODUCTION_PASSWORD_LOGIN_BLOCKED,
  revokeSession,
  startDeviceAuth,
  type DeviceCodeResponse,
  type MeUser,
  type PasswordCredentials,
} from "@fabdesk/auth-client/browser";

export type AccountStatus = "signed_out" | "pending" | "signed_in" | "error";

export type AccountPending = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
};

export type AccountSnapshot = {
  status: AccountStatus;
  principal?: Principal;
  pending?: AccountPending;
  error?: string;
};

export type StoredAccount = {
  version: 1;
  apiOrigin: string;
  token: string;
  subject: string;
  handle?: string;
  displayName?: string;
  email?: string;
  obtainedAt: string;
  expiresAt: string;
};

export interface AccountTokenStore {
  read(): Promise<StoredAccount | null>;
  write(account: StoredAccount): Promise<void>;
  clear(): Promise<void>;
}

export interface AccountSessionOptions {
  apiOrigin: string;
  store: AccountTokenStore;
  clientLabel?: string;
  fetchImpl?: typeof fetch;
  openUrl?(url: string): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  onState?(state: AccountSnapshot): void;
}

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

function principalFrom(user: MeUser | StoredAccount): Principal {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    if (err.path === "/v1/auth/device/approve" && err.httpStatus === 401) {
      return "Sign-in session was rejected. Check the email and password.";
    }
    return err.message;
  }
  return errorMessage(err);
}

export class AccountSession {
  private readonly apiOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private current: AccountSnapshot = { status: "signed_out" };
  private stored: StoredAccount | null = null;
  private loginInFlight: Promise<AccountSnapshot> | undefined;

  constructor(private readonly opts: AccountSessionOptions) {
    this.apiOrigin = normalizeOrigin(opts.apiOrigin);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  state(): AccountSnapshot {
    return this.current;
  }

  token(): string | null {
    return this.stored?.token ?? null;
  }

  private setState(next: AccountSnapshot): AccountSnapshot {
    this.current = next;
    this.opts.onState?.(next);
    return next;
  }

  private signedOut(error?: string): AccountSnapshot {
    this.stored = null;
    return this.setState({ status: "signed_out", ...(error ? { error } : {}) });
  }

  private async clearAndSignOut(error?: string): Promise<AccountSnapshot> {
    await this.opts.store.clear().catch(() => undefined);
    return this.signedOut(error);
  }

  async load(): Promise<AccountSnapshot> {
    const stored = await this.opts.store.read();
    if (!stored || normalizeOrigin(stored.apiOrigin) !== this.apiOrigin) return this.signedOut();
    if (Date.parse(stored.expiresAt) <= Date.now()) return this.clearAndSignOut();
    this.stored = stored;
    let me;
    try {
      me = await fetchMe(this.fetchImpl, this.apiOrigin, stored.token);
    } catch (err) {
      if (err instanceof AuthHttpError) {
        return this.setState({
          status: "signed_in",
          principal: principalFrom(stored),
          error: err.message,
        });
      }
      return this.setState({ status: "signed_in", principal: principalFrom(stored) });
    }
    if (!me.ok || me.user === null) return this.clearAndSignOut();
    const next: StoredAccount = {
      ...stored,
      subject: me.user.subject,
      ...(me.user.handle ? { handle: me.user.handle } : {}),
      ...(me.user.displayName ? { displayName: me.user.displayName } : {}),
      ...(me.user.email ? { email: me.user.email } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(stored)) await this.opts.store.write(next);
    this.stored = next;
    return this.setState({ status: "signed_in", principal: principalFrom(next) });
  }

  login(signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.startLogin(() => this.runLogin(signal));
  }

  loginWithPassword(credentials: PasswordCredentials, signal?: AbortSignal): Promise<AccountSnapshot> {
    return this.startLogin(() => this.runPasswordLogin(credentials, signal));
  }

  private startLogin(run: () => Promise<AccountSnapshot>): Promise<AccountSnapshot> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = run().finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  private async beginDeviceGrant(
    signal?: AbortSignal,
    opts?: { publishPending?: boolean },
  ): Promise<{ device: DeviceCodeResponse; deadline: number } | AccountSnapshot> {
    let device;
    try {
      device = await startDeviceAuth(this.fetchImpl, this.apiOrigin, {
        clientLabel: this.opts.clientLabel ?? "fabdesk-mobile",
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return this.signedOut();
      return this.setState({
        status: "error",
        error: `Could not start sign-in: ${errorMessage(err)}`,
      });
    }
    const deadline = Date.now() + device.expires_in * 1000;
    if (opts?.publishPending !== false) {
      this.setState({
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

  private async runLogin(signal?: AbortSignal): Promise<AccountSnapshot> {
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
  ): Promise<AccountSnapshot> {
    if (!credentials.email.trim() || !credentials.password) {
      return this.setState({ status: "error", error: "Email and password are required." });
    }
    if (isProductionFabplaneOrigin(this.apiOrigin)) {
      return this.setState({ status: "error", error: PRODUCTION_PASSWORD_LOGIN_BLOCKED });
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
      if (cookies) {
        await approveDeviceCode(this.fetchImpl, this.apiOrigin, {
          userCode: started.device.user_code,
          cookies,
          ...(signal ? { signal } : {}),
        });
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) return this.signedOut();
      if (err instanceof InvalidCredentialsError) {
        return this.setState({ status: "error", error: err.message });
      }
      return this.setState({ status: "error", error: describePasswordLoginError(err) });
    }
    return this.pollForToken(started.device, started.deadline, signal, { immediate: true });
  }

  private async pollForToken(
    device: DeviceCodeResponse,
    deadline: number,
    signal?: AbortSignal,
    opts?: { immediate?: boolean },
  ): Promise<AccountSnapshot> {
    let intervalSec = Math.max(device.interval, MIN_INTERVAL_SEC);
    let wait = opts?.immediate !== true;
    for (;;) {
      if (wait) await this.sleep(intervalSec * 1000, signal);
      wait = true;
      if (signal?.aborted) return this.signedOut();
      if (Date.now() >= deadline) {
        return this.setState({ status: "error", error: "Sign-in code expired. Start again." });
      }
      let outcome;
      try {
        outcome = await pollDeviceToken(this.fetchImpl, this.apiOrigin, device.device_code, signal);
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) return this.signedOut();
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
            status: "error",
            error: describeTokenError(outcome.error, outcome.description),
          });
        case "token":
          return this.completeLogin(outcome.token.access_token, outcome.token.expires_in);
      }
    }
  }

  private async completeLogin(token: string, expiresInSec: number): Promise<AccountSnapshot> {
    const now = Date.now();
    let user: MeUser | undefined;
    try {
      const me = await fetchMe(this.fetchImpl, this.apiOrigin, token);
      if (!me.ok || me.user === null) {
        return this.setState({
          status: "error",
          error: "Sign-in succeeded but the token was rejected. Try again.",
        });
      }
      user = me.user;
    } catch {
      user = undefined;
    }
    const stored: StoredAccount = {
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
    await this.opts.store.write(stored);
    this.stored = stored;
    return this.setState({ status: "signed_in", principal: principalFrom(user ?? stored) });
  }

  async logout(): Promise<AccountSnapshot> {
    const token = this.stored?.token ?? (await this.opts.store.read())?.token;
    if (token) await revokeSession(this.fetchImpl, this.apiOrigin, token);
    return this.clearAndSignOut();
  }
}
