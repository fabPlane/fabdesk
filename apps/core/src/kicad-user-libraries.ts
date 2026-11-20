/**
 * Search symbols in the user's KiCad global library tables (not the bundled
 * KiCad standard set, not the team library on fabplane.com).
 */
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseLibraryTable } from "@fabdesk/kicad";
import { KicadLibraryCatalog, type CatalogPickerHit } from "./kicad-library-catalog";

export type UserLibrarySearchOptions = {
  tablePaths?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
};

const KICAD_VERSIONS = ["9.0", "8.0", "7.0", "9", "8", "7"];

export function kicadConfigDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir(),
): string[] {
  const override = env["KICAD_CONFIG_HOME"]?.trim();
  const roots: string[] = [];
  if (override) roots.push(override);
  if (platform === "darwin") {
    roots.push(join(home, "Library", "Preferences", "kicad"));
  } else if (platform === "win32") {
    const appData =
      env["APPDATA"] && env["APPDATA"] !== "" ? env["APPDATA"] : join(home, "AppData", "Roaming");
    roots.push(join(appData, "kicad"));
  } else {
    const xdg =
      env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"] !== ""
        ? env["XDG_CONFIG_HOME"]
        : join(home, ".config");
    roots.push(join(xdg, "kicad"));
  }
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(root);
    for (const version of KICAD_VERSIONS) dirs.push(join(root, version));
  }
  return dirs;
}

export function defaultUserLibraryTables(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir(),
): string[] {
  return kicadConfigDirs(env, platform, home).map((dir) => join(dir, "sym-lib-table"));
}

function expandUri(
  uri: string,
  env: NodeJS.ProcessEnv,
  home: string,
): string | undefined {
  if (uri.includes("${KIPRJMOD}")) return undefined;
  let out = uri.replace(/^~(?=\/|\\|$)/, home);
  out = out.replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? `\${${name}}`);
  if (out.includes("${")) return undefined;
  return out;
}

/**
 * Index each user `.kicad_sym` named in a global `sym-lib-table` by putting it
 * in a temporary catalog rooted at its parent directory.
 */
export async function searchUserLibraries(
  query: string,
  limit: number,
  opts: UserLibrarySearchOptions = {},
): Promise<CatalogPickerHit[]> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? (env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir());
  const tables = opts.tablePaths ?? defaultUserLibraryTables(env, platform, home);
  const seen = new Set<string>();
  const hits: CatalogPickerHit[] = [];
  for (const tablePath of tables) {
    const text = await readFile(tablePath, "utf8").catch(() => null);
    if (text === null) continue;
    for (const row of parseLibraryTable(text)) {
      if (row.disabled || row.type !== "KiCad") continue;
      const uri = expandUri(row.uri, env, home);
      if (!uri || !uri.endsWith(".kicad_sym")) continue;
      const dir = dirname(uri);
      if (!dir) continue;
      const catalog = new KicadLibraryCatalog({ symbols: dir });
      const fileNick = uri.replace(/^.*[/\\]/, "").replace(/\.kicad_sym$/i, "");
      const rows = await catalog.searchPicker(query, limit);
      for (const rowHit of rows) {
        const entry = rowHit.libId.startsWith(`${fileNick}:`)
          ? rowHit.libId.slice(fileNick.length + 1)
          : rowHit.libId.includes(":")
            ? rowHit.libId.slice(rowHit.libId.indexOf(":") + 1)
            : rowHit.libId;
        const libId = `${row.name}:${entry}`;
        if (seen.has(libId)) continue;
        seen.add(libId);
        hits.push({ ...rowHit, libId });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}
