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
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ProjectLibraryKind = "footprint" | "symbol";

export interface ProjectLibraryRow {
  name: string;
  type: string;
  uri: string;
  options: string;
  descr: string;
  disabled: boolean;
  hidden: boolean;
}

export const LIBRARY_TABLE_FILES: Record<ProjectLibraryKind, string> = {
  footprint: "fp-lib-table",
  symbol: "sym-lib-table",
};

/** Bundled rows fabdesk writes itself (`@fp-pcb/compile` `discoverLibraries`); never restored. */
const BUNDLED_DESCR = /^Bundled KiCad (footprint|symbol) library$/;

type Node = string | Node[];

function tokenize(text: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "(") {
      const list: Node[] = [];
      stack.at(-1)!.push(list);
      stack.push(list);
      i++;
    } else if (c === ")") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === '"') {
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1]!;
          value += next === "n" ? "\n" : next;
          i += 2;
        } else value += text[i++];
      }
      i++;
      stack.at(-1)!.push(value);
    } else if (/\s/.test(c)) i++;
    else {
      let atom = "";
      while (i < text.length && !/[\s()"]/.test(text[i]!)) atom += text[i++];
      stack.at(-1)!.push(atom);
    }
  }
  return root;
}

/** Rows of a saved KiCad library table; malformed or unknown entries are skipped, never thrown. */
export function parseLibraryTable(text: string): ProjectLibraryRow[] {
  const table = tokenize(text).find((n): n is Node[] => Array.isArray(n) && /^(fp|sym)_lib_table$/.test(String(n[0])));
  if (!table) return [];
  const rows: ProjectLibraryRow[] = [];
  for (const entry of table) {
    if (!Array.isArray(entry) || entry[0] !== "lib") continue;
    const field = (key: string): string | undefined => {
      const node = entry.find((n): n is Node[] => Array.isArray(n) && n[0] === key);
      return node && typeof node[1] === "string" ? node[1] : undefined;
    };
    const flag = (key: string): boolean => entry.some((n) => Array.isArray(n) && n[0] === key);
    const name = field("name");
    const uri = field("uri");
    if (!name || uri === undefined) continue;
    rows.push({
      name,
      type: field("type") ?? "KiCad",
      uri,
      options: field("options") ?? "",
      descr: field("descr") ?? "",
      disabled: flag("disabled"),
      hidden: flag("hidden"),
    });
  }
  return rows;
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
): ProjectLibraryRow[] {
  if (!before) return [];
  const current = new Map((after ?? []).map((row) => [row.name, row]));
  return before.filter((row) => {
    if (BUNDLED_DESCR.test(row.descr)) return false;
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
