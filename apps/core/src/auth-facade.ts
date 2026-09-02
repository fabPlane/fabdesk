/**
 * Auth facade over @fabdesk/auth-client. Local mode short-circuits fabplane entirely; fabplane mode
 * delegates to `AuthClient` (device flow). Emits `auth.state` on every change.
 */
import type { AuthState, CoreEvent, Principal } from "@fabdesk/protocol";
import { AuthClient, LOCAL_PRINCIPAL, localModeAllowed } from "@fabdesk/auth-client";
import type { AuthMode, Channel } from "./config";
import { logger, errMsg } from "./log";

export { localModeAllowed };

export interface AuthFacade {
  readonly mode: AuthMode;
  load(): Promise<void>;
  state(): AuthState;
  principal(): Principal | null;
  login(signal?: AbortSignal): Promise<AuthState>;
  logout(): Promise<AuthState>;
  token(): string | null;
}

export class LocalAuth implements AuthFacade {
  readonly mode = "local" as const;
  private readonly st: AuthState;
  constructor(principal: Principal = LOCAL_PRINCIPAL) {
    this.st = { mode: "local", status: "signed_in", principal };
  }
  async load(): Promise<void> {}
  state(): AuthState {
    return this.st;
  }
  principal(): Principal | null {
    return this.st.principal ?? null;
  }
  async login(): Promise<AuthState> {
    return this.st;
  }
  async logout(): Promise<AuthState> {
    return this.st;
  }
  token(): string | null {
    return null;
  }
}

export class FabplaneAuth implements AuthFacade {
  readonly mode = "fabplane" as const;
  private client: AuthClient | null = null;
  private st: AuthState = { mode: "fabplane", status: "signed_out" };

  constructor(private readonly opts: { home: string; apiOrigin: string; emit: (e: CoreEvent) => void; openUrl?: (url: string) => void }) {}

  async load(): Promise<void> {
    try {
      this.client = new AuthClient({
        home: this.opts.home,
        apiOrigin: this.opts.apiOrigin,
        mode: "fabplane",
        clientLabel: `fabdesk-core ${process.platform}`,
        onState: (s) => this.setState(s),
        ...(this.opts.openUrl ? { openUrl: this.opts.openUrl } : {}),
      });
      this.st = await this.client.load();
    } catch (e) {
      logger.warn("auth client load failed", { error: errMsg(e) });
      this.st = { mode: "fabplane", status: "error", error: errMsg(e) };
    }
  }
  private setState(s: AuthState): void {
    this.st = s;
    try {
      this.opts.emit({ ts: Date.now(), topic: "auth.state", state: s });
    } catch (e) {
      logger.warn("auth.state emit failed", { error: errMsg(e) });
    }
  }
  state(): AuthState {
    return this.client?.state() ?? this.st;
  }
  principal(): Principal | null {
    return this.state().principal ?? null;
  }
  async login(signal?: AbortSignal): Promise<AuthState> {
    if (!this.client) return this.st;
    try {
      await this.client.login(signal);
    } catch (e) {
      this.setState({ mode: "fabplane", status: "error", error: errMsg(e) });
    }
    return this.state();
  }
  async logout(): Promise<AuthState> {
    if (this.client) await this.client.logout().catch((e) => logger.warn("logout failed", { error: errMsg(e) }));
    this.setState(this.client?.state() ?? { mode: "fabplane", status: "signed_out" });
    return this.state();
  }
  token(): string | null {
    return this.client?.token() ?? null;
  }
}

export async function createAuth(o: { mode: AuthMode; channel: Channel; home: string; apiOrigin: string; emit: (e: CoreEvent) => void }): Promise<AuthFacade> {
  if (o.mode === "local") {
    if (!localModeAllowed({ channel: o.channel, home: o.home })) {
      logger.error("FABDESK_AUTH_MODE=local refused: public build without a .fabdesk-dev marker in FABDESK_HOME; falling back to fabplane login");
    } else {
      const a = new LocalAuth();
      await a.load();
      return a;
    }
  }
  const a = new FabplaneAuth({ home: o.home, apiOrigin: o.apiOrigin, emit: o.emit });
  await a.load();
  return a;
}
