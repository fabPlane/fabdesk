/** Bearer-token set (daemon token + per-run tokens) and Origin allowlist. */
import type { Principal } from "@fabdesk/protocol";
import { mintToken } from "./config";

export type TokenInfo = { kind: "daemon" | "run" | "device"; runId?: string; projectId?: string | null; threadId?: string; deviceId?: string };

export class TokenSet {
  private readonly tokens = new Map<string, TokenInfo>();
  /** Paired devices hold long-lived tokens kept in SQLite, not in this map. */
  private devices: ((token: string) => TokenInfo | null) | null = null;

  constructor(daemonToken: string) {
    this.tokens.set(daemonToken, { kind: "daemon" });
  }

  /** Register the device-token lookup; called once the store is open. */
  setDeviceLookup(lookup: (token: string) => TokenInfo | null): void {
    this.devices = lookup;
  }

  /** Mint a token bound to an agent run (revoked when the run ends). */
  mintRunToken(info: { runId: string; projectId: string | null; threadId: string }): string {
    const t = mintToken();
    this.tokens.set(t, { kind: "run", ...info });
    return t;
  }

  revoke(token: string): void {
    const info = this.tokens.get(token);
    if (info?.kind === "run") this.tokens.delete(token);
  }

  revokeRun(runId: string): void {
    for (const [t, info] of this.tokens) if (info.kind === "run" && info.runId === runId) this.tokens.delete(t);
  }

  lookup(token: string | undefined | null): TokenInfo | null {
    if (!token) return null;
    return this.tokens.get(token) ?? this.devices?.(token) ?? null;
  }

  verify(token: string | undefined | null): boolean {
    return this.lookup(token) !== null;
  }
}

/** Extract a bearer token from headers or (for SSE/WebSocket) the `token` query parameter. */
export function extractToken(req: Request, opts: { allowQuery?: boolean } = {}): string | null {
  const h = req.headers.get("authorization");
  if (h) {
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (m?.[1]) return m[1].trim();
  }
  if (opts.allowQuery) {
    const url = new URL(req.url);
    const q = url.searchParams.get("token");
    if (q) return q;
  }
  return null;
}

export const DEFAULT_ORIGIN_ALLOWLIST = ["null", "file://", "app://fabdesk", "app://.", "capacitor://localhost"];

/** Reject browsers on other sites (DNS rebinding / CSRF). No Origin header = non-browser client. */
export function originAllowed(origin: string | null, extra: string[] = []): boolean {
  if (origin === null || origin === "") return true;
  const o = origin.trim();
  if (DEFAULT_ORIGIN_ALLOWLIST.includes(o) || extra.includes(o)) return true;
  if (o.startsWith("file://")) return true;
  try {
    const u = new URL(o);
    if ((u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return true;
    if (u.protocol === "app:" && u.hostname === "fabdesk") return true;
  } catch {
    return false;
  }
  return false;
}

export type { Principal };
