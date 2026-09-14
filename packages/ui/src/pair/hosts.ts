/**
 * The computers a browser has paired with, in `localStorage` under one key. The device token is
 * stored in the clear: a browser has no keystore, and the token is scoped to one daemon that can
 * revoke it from Settings › Remote access. Pure over a `StorageLike` so it is testable in Bun.
 */

export interface SavedHost {
  /** Origin of the daemon, e.g. `https://mac.tailnet.ts.net` — the key. */
  host: string;
  deviceToken: string;
  coreName: string;
  coreId: string | null;
  deviceId: string;
  pairedAt: string;
}

export interface SavedHosts {
  v: 1;
  /** The one the app connects to at boot; null while none is chosen. */
  active: string | null;
  hosts: SavedHost[];
}

export const SAVED_HOSTS_KEY = "fabdesk.web-hosts";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const EMPTY: SavedHosts = { v: 1, active: null, hosts: [] };

function isHost(x: unknown): x is SavedHost {
  if (!x || typeof x !== "object") return false;
  const h = x as Record<string, unknown>;
  return (
    typeof h.host === "string" &&
    typeof h.deviceToken === "string" &&
    typeof h.coreName === "string"
  );
}

/** Tolerant of anything: a missing key, junk, or an older shape is an empty list, never a throw. */
export function readSavedHosts(storage: StorageLike): SavedHosts {
  let raw: string | null;
  try {
    raw = storage.getItem(SAVED_HOSTS_KEY);
  } catch {
    return EMPTY;
  }
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedHosts>;
    const hosts = Array.isArray(parsed.hosts) ? parsed.hosts.filter(isHost) : [];
    const active =
      typeof parsed.active === "string" && hosts.some((h) => h.host === parsed.active)
        ? parsed.active
        : null;
    return {
      v: 1,
      active,
      hosts: hosts.map((h) => ({
        host: h.host,
        deviceToken: h.deviceToken,
        coreName: h.coreName,
        coreId: typeof h.coreId === "string" ? h.coreId : null,
        deviceId: typeof h.deviceId === "string" ? h.deviceId : "",
        pairedAt: typeof h.pairedAt === "string" ? h.pairedAt : "",
      })),
    };
  } catch {
    return EMPTY;
  }
}

export function writeSavedHosts(storage: StorageLike, value: SavedHosts): void {
  storage.setItem(SAVED_HOSTS_KEY, JSON.stringify(value));
}

/** Adds or replaces the entry for `host.host` and makes it active. Re-pairing a computer supersedes its old token. */
export function withHost(current: SavedHosts, host: SavedHost): SavedHosts {
  return {
    v: 1,
    active: host.host,
    hosts: [host, ...current.hosts.filter((h) => h.host !== host.host)],
  };
}

/** Removes a computer; if it was the active one, the most recently paired remaining one takes over. */
export function withoutHost(current: SavedHosts, host: string): SavedHosts {
  const hosts = current.hosts.filter((h) => h.host !== host);
  const active = current.active === host ? (hosts[0]?.host ?? null) : current.active;
  return { v: 1, active, hosts };
}

export function withActive(current: SavedHosts, host: string | null): SavedHosts {
  if (host !== null && !current.hosts.some((h) => h.host === host)) return current;
  return { ...current, active: host };
}

export function activeHost(current: SavedHosts): SavedHost | null {
  return current.hosts.find((h) => h.host === current.active) ?? null;
}
