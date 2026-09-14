/**
 * Per-user connection accounting. The relay learns a `userId` when a daemon authenticates and
 * keys every limit on it, so one account cannot register unbounded cores, open unbounded phone
 * sockets against a core it owns, or push unbounded HTTP through the relay.
 */
export interface LimitConfig {
  /** Distinct `coreId`s one user may keep connected (replacing the same core is free). */
  maxDaemonsPerUser: number;
  /** Proxied phone WebSockets per `coreId`. */
  maxClientsPerCore: number;
  /** Proxied HTTP requests per minute across all of a user's cores. */
  requestsPerMinutePerUser: number;
}

export const DEFAULT_LIMITS: LimitConfig = {
  maxDaemonsPerUser: 10,
  maxClientsPerCore: 32,
  requestsPerMinutePerUser: 600,
};

/** Counts connected cores per user; asked before an upgrade, told after open and close. */
export class DaemonLedger {
  private readonly byUser = new Map<string, Set<string>>();

  /** Whether `userId` may register `coreId` while holding at most `max` distinct cores. */
  allows(userId: string, coreId: string, max: number): boolean {
    const cores = this.byUser.get(userId);
    if (!cores || cores.has(coreId)) return true;
    return cores.size < max;
  }

  add(userId: string, coreId: string): void {
    let cores = this.byUser.get(userId);
    if (!cores) {
      cores = new Set();
      this.byUser.set(userId, cores);
    }
    cores.add(coreId);
  }

  remove(userId: string, coreId: string): void {
    const cores = this.byUser.get(userId);
    if (!cores) return;
    cores.delete(coreId);
    if (cores.size === 0) this.byUser.delete(userId);
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  get users(): number {
    return this.byUser.size;
  }
}
