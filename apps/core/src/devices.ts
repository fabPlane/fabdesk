/**
 * Paired mobile clients. The daemon's own bearer token is re-minted at every start, so a phone
 * cannot hold it; a device instead gets its own long-lived token, stored only as a SHA-256 digest
 * and revocable from the desktop. See docs/mobile.md.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  Device,
  DeviceMe,
  DevicePushPrefs,
  DevicePushState,
  type DevicePlatform,
  type DevicePushRegistration,
} from "@fabdesk/protocol";
import { mintToken } from "./config";

/** How long a pairing token is good for, and how many claims may be attempted against it. */
export const PAIRING_TTL_MS = 3 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Six groups of four, easy to read aloud when the QR will not scan. */
function pairingCode(token: string): string {
  return hashToken(token)
    .slice(0, 8)
    .toUpperCase()
    .replace(/(.{4})(.{4})/, "$1-$2");
}

type DeviceRow = {
  id: string;
  label: string;
  platform: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  push_token: string | null;
  push_platform: string | null;
  push_prefs: string | null;
  /** Unix ms, per the migration; surfaced as ISO. */
  push_registered_at: number | null;
};

function toDevice(row: DeviceRow): Device {
  return Device.parse({
    id: row.id,
    label: row.label,
    platform: row.platform,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  });
}

/** The push registration on a row, or null when there is none (or it is unreadable). */
function toPushState(row: DeviceRow): DevicePushState | null {
  if (!row.push_token || !row.push_platform || row.push_registered_at === null) return null;
  const parsed = DevicePushState.safeParse({
    registeredAt: new Date(row.push_registered_at).toISOString(),
    platform: row.push_platform,
    prefs: parsePrefs(row.push_prefs),
  });
  return parsed.success ? parsed.data : null;
}

function parsePrefs(raw: string | null): DevicePushPrefs {
  try {
    return DevicePushPrefs.parse(raw ? JSON.parse(raw) : {});
  } catch {
    return DevicePushPrefs.parse({});
  }
}

/** A device the Notifier can send to: its Expo token and what it asked to hear about. */
export interface PushTarget {
  device: Device;
  token: string;
  prefs: DevicePushPrefs;
}

export interface PendingPairing {
  token: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

export class DeviceStore {
  /** At most one pairing attempt is open at a time; starting a new one invalidates the old. */
  private pending: PendingPairing | null = null;

  constructor(private readonly db: Database) {}

  startPairing(now = Date.now()): PendingPairing {
    const token = mintToken();
    this.pending = {
      token,
      code: pairingCode(token),
      expiresAt: now + PAIRING_TTL_MS,
      attempts: 0,
    };
    return this.pending;
  }

  cancelPairing(): void {
    this.pending = null;
  }

  pendingPairing(now = Date.now()): PendingPairing | null {
    if (this.pending && this.pending.expiresAt <= now) this.pending = null;
    return this.pending;
  }

  /**
   * Exchanges a pairing token for a device token. One-time: the pairing token is consumed on
   * success, and burned after `PAIRING_MAX_ATTEMPTS` failures so a guesser gets a handful of tries.
   */
  claim(
    input: { pairingToken: string; label: string; platform: DevicePlatform },
    now = Date.now(),
  ): { device: Device; token: string } {
    const pending = this.pendingPairing(now);
    if (!pending) throw new Error("no pairing in progress");
    if (pending.token !== input.pairingToken) {
      pending.attempts += 1;
      if (pending.attempts >= PAIRING_MAX_ATTEMPTS) this.pending = null;
      throw new Error("pairing code is not valid");
    }
    this.pending = null;
    return this.issue(input.label, input.platform, now);
  }

  issue(
    label: string,
    platform: DevicePlatform,
    now = Date.now(),
  ): { device: Device; token: string } {
    const token = mintToken();
    const id = `dev_${randomUUID().slice(0, 8)}`;
    const createdAt = new Date(now).toISOString();
    this.db.run(
      "INSERT INTO devices(id, label, platform, token_sha256, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, label, platform, hashToken(token), createdAt],
    );
    return { device: Device.parse({ id, label, platform, createdAt, lastSeenAt: null }), token };
  }

  /** The device a token belongs to, or null when it is unknown or revoked. */
  verify(token: string | null | undefined): Device | null {
    if (!token) return null;
    const row = this.db
      .query<
        DeviceRow,
        [string]
      >("SELECT * FROM devices WHERE token_sha256 = ? AND revoked_at IS NULL")
      .get(hashToken(token));
    return row ? toDevice(row) : null;
  }

  touch(id: string, now = Date.now()): void {
    this.db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [
      new Date(now).toISOString(),
      id,
    ]);
  }

  list(): Device[] {
    return this.db
      .query<
        DeviceRow,
        []
      >("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC")
      .all()
      .map(toDevice);
  }

  /** Revokes the token and forgets the push registration with it: a revoked phone gets nothing more. */
  revoke(id: string, now = Date.now()): boolean {
    const before = this.db
      .query<
        { n: number },
        [string]
      >("SELECT COUNT(*) AS n FROM devices WHERE id = ? AND revoked_at IS NULL")
      .get(id);
    if (!before || before.n === 0) return false;
    this.db.run(
      `UPDATE devices SET revoked_at = ?, push_token = NULL, push_platform = NULL, push_prefs = NULL,
         push_registered_at = NULL WHERE id = ?`,
      [new Date(now).toISOString(), id],
    );
    return true;
  }

  /* ---------- push registration (docs/mobile-notifications.md §4.1) ---------- */

  /** The device as it sees itself: identity plus its own push registration. Null when revoked. */
  get(id: string): DeviceMe | null {
    const row = this.db
      .query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL")
      .get(id);
    return row ? DeviceMe.parse({ ...toDevice(row), push: toPushState(row) }) : null;
  }

  /** Stores (or replaces) a device's push token and prefs; the phone re-registers on every connect. */
  setPush(
    id: string,
    reg: DevicePushRegistration,
    now = Date.now(),
  ): { device: Device; registeredAt: string } | null {
    const current = this.get(id);
    if (!current) return null;
    this.db.run(
      `UPDATE devices SET push_token = ?, push_platform = ?, push_prefs = ?, push_registered_at = ?
         WHERE id = ? AND revoked_at IS NULL`,
      [reg.expoPushToken, reg.platform, JSON.stringify(reg.prefs), now, id],
    );
    const { push: _push, ...device } = current;
    return { device, registeredAt: new Date(now).toISOString() };
  }

  clearPush(id: string): boolean {
    return (
      this.db.run(
        `UPDATE devices SET push_token = NULL, push_platform = NULL, push_prefs = NULL,
           push_registered_at = NULL WHERE id = ? AND revoked_at IS NULL`,
        [id],
      ).changes > 0
    );
  }

  /** Every live device holding a push token, with the prefs the Notifier filters on. */
  pushTargets(): PushTarget[] {
    return this.db
      .query<DeviceRow, []>(
        "SELECT * FROM devices WHERE revoked_at IS NULL AND push_token IS NOT NULL ORDER BY created_at",
      )
      .all()
      .map((row) => ({
        device: toDevice(row),
        token: row.push_token as string,
        prefs: parsePrefs(row.push_prefs),
      }));
  }
}
