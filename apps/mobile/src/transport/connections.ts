/**
 * Saved connections and the device tokens that go with them.
 *
 * A connection is one paired desktop. `baseUrl` is whichever address answered when we paired, but
 * a laptop moves between a tailnet and a LAN, so every address from the pairing payload is kept and
 * retried on connect. Tokens are the sensitive part and live in the OS keystore, never in the
 * store that is persisted as plain JSON.
 */
import type { DevicePlatform } from "@fabdesk/protocol";
import { create } from "zustand";
import * as SecureStore from "expo-secure-store";
import type { RelayTarget } from "./connect";

export interface Connection {
  id: string;
  /** The machine's own name, as the daemon reported it at pairing time. */
  name: string;
  /** Address that answered most recently; tried first next time. */
  baseUrl: string;
  /** Every address the daemon offered, so a move between networks recovers without re-pairing. */
  candidates: string[];
  deviceId: string;
  platform: DevicePlatform;
  pairedAt: string;
  lastConnectedAt: string | null;
  /**
   * The daemon's stable identity (docs/mobile-notifications.md §4.4), from `pair/claim` or the
   * first `/health` that reports one. A notification names the daemon by it; connections paired
   * before daemons minted one are matched by `deviceId` instead.
   */
  coreId?: string;
  /**
   * The relay the daemon advertised at pairing time (an endpoint of kind `relay`), e.g.
   * `https://relay.fabplane.com`. Tried after every direct address fails; needs `coreId`.
   */
  relayUrl?: string;
}

/** What `findReachable` needs to try the relay for a connection; null until both halves are known. */
export function relayTarget(
  connection: Pick<Connection, "relayUrl" | "coreId">,
): RelayTarget | null {
  return connection.relayUrl && connection.coreId
    ? { url: connection.relayUrl, coreId: connection.coreId }
    : null;
}

const TOKEN_PREFIX = "fabdesk.device-token.";
const CONNECTIONS_KEY = "fabdesk.connections";
const ACTIVE_KEY = "fabdesk.active-connection";

export async function saveToken(connectionId: string, token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_PREFIX + connectionId, token);
}

export async function readToken(connectionId: string): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_PREFIX + connectionId);
}

export async function deleteToken(connectionId: string): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_PREFIX + connectionId);
}

/**
 * Connection metadata is not secret, but SecureStore is already here and one storage path is
 * simpler than two. It is small — a handful of records at most.
 */
async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(value));
}

export interface ConnectionsState {
  connections: Connection[];
  activeId: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (connection: Connection, token: string) => Promise<void>;
  setActive: (id: string | null) => Promise<void>;
  /** Records the address that worked, so the next connect starts there. */
  noteConnected: (id: string, baseUrl: string) => Promise<void>;
  /** Records the daemon's `coreId` once `/health` reports one; a no-op when it is already known. */
  noteCoreId: (id: string, coreId: string) => Promise<void>;
  forget: (id: string) => Promise<void>;
}

export const useConnections = create<ConnectionsState>()((set, get) => ({
  connections: [],
  activeId: null,
  hydrated: false,

  hydrate: async () => {
    const connections = await readJson<Connection[]>(CONNECTIONS_KEY, []);
    const stored = await SecureStore.getItemAsync(ACTIVE_KEY);
    const activeId =
      stored && connections.some((c) => c.id === stored) ? stored : (connections[0]?.id ?? null);
    set({ connections, activeId, hydrated: true });
  },

  add: async (connection, token) => {
    await saveToken(connection.id, token);
    const connections = [connection, ...get().connections.filter((c) => c.id !== connection.id)];
    await writeJson(CONNECTIONS_KEY, connections);
    await SecureStore.setItemAsync(ACTIVE_KEY, connection.id);
    set({ connections, activeId: connection.id });
  },

  setActive: async (id) => {
    if (id) await SecureStore.setItemAsync(ACTIVE_KEY, id);
    else await SecureStore.deleteItemAsync(ACTIVE_KEY);
    set({ activeId: id });
  },

  noteConnected: async (id, baseUrl) => {
    const connections = get().connections.map((c) =>
      c.id === id ? { ...c, baseUrl, lastConnectedAt: new Date().toISOString() } : c,
    );
    await writeJson(CONNECTIONS_KEY, connections);
    set({ connections });
  },

  noteCoreId: async (id, coreId) => {
    if (get().connections.some((c) => c.id === id && c.coreId === coreId)) return;
    const connections = get().connections.map((c) => (c.id === id ? { ...c, coreId } : c));
    await writeJson(CONNECTIONS_KEY, connections);
    set({ connections });
  },

  forget: async (id) => {
    await deleteToken(id);
    const connections = get().connections.filter((c) => c.id !== id);
    await writeJson(CONNECTIONS_KEY, connections);
    const activeId = get().activeId === id ? (connections[0]?.id ?? null) : get().activeId;
    if (activeId) await SecureStore.setItemAsync(ACTIVE_KEY, activeId);
    else await SecureStore.deleteItemAsync(ACTIVE_KEY);
    set({ connections, activeId });
  },
}));

export { connectOrder } from "../lib/connect-order";
export { relayUrlFromPayload } from "./connect";
