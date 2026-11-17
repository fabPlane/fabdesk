/**
 * Project library rows that fabdesk must not lose. KiCad keeps the project's `fp-lib-table` /
 * `sym-lib-table` in memory from the moment the project opens and rewrites the whole file on every
 * `AddLibraryTableRow`. A row someone added to the saved table after that (by hand, by a script or
 * by another tool) is therefore dropped the next time fabdesk registers its bundled libraries or a
 * compile job registers its own: KiCad saves the table it loaded, not the one on disk.
 *
 * `captureProjectLibraryRows` reads the saved tables before such a write and
 * `rowsToRestore` names the rows the write lost or overwrote, so the caller can re-add them through
 * the same live session (keeping KiCad's in-memory table and the saved file in agreement).
 */
import { parseLibraryTable, type ProjectLibraryRow } from "@fabdesk/kicad";
export { parseLibraryTable, type ProjectLibraryRow } from "@fabdesk/kicad";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export type ProjectLibraryKind = "footprint" | "symbol";

export const LIBRARY_TABLE_FILES: Record<ProjectLibraryKind, string> = {
  footprint: "fp-lib-table",
  symbol: "sym-lib-table",
};

export type BundledLibraryRoots = { footprints?: string | undefined; symbols?: string | undefined };

/** A description is user-editable metadata. Only the exact configured bundle URI and managed
 * metadata identify a row we may replace without restoring it. Unknown roots preserve rows. */
export function isManagedLibraryRow(kind: ProjectLibraryKind, row: ProjectLibraryRow, roots: BundledLibraryRoots = {
  footprints: process.env["KICAD_FOOTPRINT_DIR"], symbols: process.env["KICAD_SYMBOL_DIR"],
}): boolean {
  const root = kind === "footprint" ? roots.footprints : roots.symbols;
  return Boolean(root && isAbsolute(row.uri) && resolve(row.uri) === resolve(root, row.name + (kind === "footprint" ? ".pretty" : ".kicad_sym")) &&
    row.descr === `Bundled KiCad ${kind} library` && row.type === "KiCad" && row.options === "" && !row.disabled && !row.hidden);
}

export type ProjectLibrarySnapshot = Record<ProjectLibraryKind, ProjectLibraryRow[] | null>;

/** The saved project tables; a missing or unreadable table is `null` (nothing to preserve). */
export async function captureProjectLibraryRows(projectDir: string): Promise<ProjectLibrarySnapshot> {
  const read = async (kind: ProjectLibraryKind) => {
    const text = await readFile(join(projectDir, LIBRARY_TABLE_FILES[kind]), "utf8").catch(() => null);
    return text === null ? null : parseLibraryTable(text);
  };
  return { footprint: await read("footprint"), symbol: await read("symbol") };
}

/**
 * Rows present before a table write that the write removed or changed. Bundled rows are left to
 * the bundled registration (their install path may legitimately move); every other row is the
 * project's own and comes back exactly as it was saved, including a project override of a
 * bundled nickname.
 */
export function rowsToRestore(
  before: ProjectLibraryRow[] | null,
  after: ProjectLibraryRow[] | null,
  managed: (row: ProjectLibraryRow) => boolean = () => false,
): ProjectLibraryRow[] {
  if (!before) return [];
  const current = new Map((after ?? []).map((row) => [row.name, row]));
  return before.filter((row) => {
    if (managed(row)) return false;
    const now = current.get(row.name);
    return (
      !now ||
      now.uri !== row.uri ||
      now.type !== row.type ||
      now.options !== row.options ||
      now.descr !== row.descr ||
      now.hidden !== row.hidden ||
      now.disabled !== row.disabled
    );
  });
}
