/** A project's git remote URLs, read from `.git/config` without spawning git. */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** `url = …` lines of `[remote "…"]` sections, in file order, de-duplicated. */
export function parseGitRemotes(config: string): string[] {
  const out: string[] = [];
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[remote\s+"[^"]*"\]$/.test(line);
      continue;
    }
    if (!inRemote) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m?.[1]) {
      const url = stripCredentials(m[1].trim().replace(/^"(.*)"$/, "$1"));
      if (url && !out.includes(url)) out.push(url);
    }
  }
  return out;
}

/** `https://user:token@host/…` → `https://host/…`; scp-style and ssh URLs keep their user. */
export function stripCredentials(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

async function gitConfigPath(dir: string): Promise<string | null> {
  const dotGit = join(dir, ".git");
  const st = await stat(dotGit).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) return join(dotGit, "config");
  // A worktree or submodule: `.git` is a file pointing at the real git dir.
  const pointer = await readFile(dotGit, "utf8").catch(() => "");
  const m = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!m?.[1]) return null;
  const gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
  const common = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
  return join(common ? resolve(gitDir, common) : gitDir, "config");
}

export async function gitRemotes(dir: string): Promise<string[]> {
  const path = await gitConfigPath(dir);
  if (!path) return [];
  const text = await readFile(path, "utf8").catch(() => "");
  return parseGitRemotes(text);
}
