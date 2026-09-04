/**
 * Electron derives userData from package.json's productName ("Fabplane").
 * Earlier builds used "Fabdesk" (0.1.40+) or the package name ("@fabdesk/desktop").
 * Move that data onto the current path once, when the new directory is missing or empty.
 */
import { existsSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** productName used from 0.1.40 until the Fabplane executable rename. */
export const PREVIOUS_PRODUCT_USER_DATA = "Fabdesk";

export function isVacantUserData(dir: string): boolean {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Renames the newest legacy directory onto `userData`. Returns the source path, or null. */
export function migrateLegacyUserData(userData: string): string | null {
  if (!isVacantUserData(userData)) return null;
  const parent = dirname(userData);
  const sources = [join(parent, PREVIOUS_PRODUCT_USER_DATA), join(parent, "@fabdesk", "desktop")];
  for (const source of sources) {
    if (source === userData || !existsSync(source) || isVacantUserData(source)) continue;
    try {
      if (existsSync(userData)) rmdirSync(userData);
      renameSync(source, userData);
      return source;
    } catch (err) {
      console.warn(`[main] could not migrate ${source} -> ${userData}: ${String(err)}`);
      return null;
    }
  }
  return null;
}
