import { MechanicalDesignSchema, type MechanicalDesign } from "@fabdesk/protocol";
import { sameEnclosureDesign } from "./enclosure-history";

export type EnclosureRecovery = {
  version: 1;
  design: MechanicalDesign;
  baseRevision: string | null;
  savedAt: number;
};

export function enclosureRecoveryAction(
  recovered: EnclosureRecovery | null,
  saved: MechanicalDesign,
  revision: string | null,
) {
  if (!recovered) return "none";
  if (sameEnclosureDesign(recovered.design, saved)) return "discard";
  return recovered.baseRevision === revision ? "restore" : "conflict";
}
type Storage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Packaged local daemons choose a new port on restart; the project path is stable. */
export function enclosureRecoveryKey(baseUrl: string, projectId: string, projectPath: string) {
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const scope = local ? "local" : `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  return `fd:enclosure-recovery:${JSON.stringify([scope, projectId, projectPath])}`;
}

/** Local recovery never writes project files and never silently replaces saved project settings. */
export class EnclosureRecoveryStore {
  private owned: string | null = null;
  constructor(
    private readonly storage: Storage,
    readonly key: string,
  ) {}
  load(): EnclosureRecovery | null {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    if (raw.length > 1_000_000) throw new Error("The enclosure recovery copy is too large.");
    const value = JSON.parse(raw) as Partial<EnclosureRecovery>;
    if (
      value?.version !== 1 ||
      !Number.isFinite(value.savedAt) ||
      typeof value.savedAt !== "number" ||
      (value.baseRevision !== null &&
        (typeof value.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.baseRevision)))
    )
      throw new Error("The enclosure recovery copy is not valid.");
    const design = MechanicalDesignSchema.parse(value.design);
    this.owned = raw;
    return { version: 1, design, baseRevision: value.baseRevision, savedAt: value.savedAt };
  }
  store(design: MechanicalDesign, baseRevision: string | null, now = Date.now()): boolean {
    const parsed = MechanicalDesignSchema.safeParse(design);
    // Keep the last complete recovery copy while the user is editing an incomplete field.
    if (!parsed.success) return false;
    const raw = JSON.stringify({ version: 1, design: parsed.data, baseRevision, savedAt: now });
    this.storage.setItem(this.key, raw);
    this.owned = raw;
    return true;
  }
  clear() {
    // A save in this window must not delete a newer recovery copy written by another window.
    if (this.owned && this.storage.getItem(this.key) === this.owned)
      this.storage.removeItem(this.key);
    this.owned = null;
  }
}
