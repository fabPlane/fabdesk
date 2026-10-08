import { lstatSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Codex's file credential backend truncates/writes through this link. Keep one live store
 * rather than snapshots that can strand a rotated refresh token in a project overlay.
 * Never replace an old snapshot: it may contain the only valid rotated token, or a
 * still-running older CLI may be about to refresh into it.
 */
export function linkSharedAuth(link: string, source: string): void {
  let existing;
  try {
    existing = lstatSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) {
    if (resolve(dirname(link), readlinkSync(link)) !== source)
      throw new Error("Agent credential link targets a different store");
    return;
  }
  if (existing) {
    throw new Error(
      "Agent credential overlay contains a private snapshot instead of the shared store",
    );
  }
  try {
    // Also retain a dangling link when there is no file yet: a later file-based login
    // creates the shared store rather than an independent overlay credential.
    symlinkSync(source, link, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another launch may have created the same link. Validate, never silently accept
    // an unrelated file or credential link.
    if (!lstatSync(link).isSymbolicLink() || resolve(dirname(link), readlinkSync(link)) !== source)
      throw new Error("Agent credential store changed during setup");
  }
}
