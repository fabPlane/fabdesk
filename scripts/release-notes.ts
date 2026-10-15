/**
 * Generates one build's release notes. Hand-written entries in the repo-root `release-notes.json`
 * that were added since the previous `v*` tag win; with none, the notes are one bullet per
 * non-merge commit since that tag (or the last 30 commits when there is no tag).
 *
 * The release workflow runs this once, in the `version` job. The JSON is baked into the app for the
 * "What's new" dialog (electron.vite.config.ts reads FABDESK_RELEASE_NOTES_FILE), and the Markdown
 * rendering of the same JSON lands in `manifest.json` (`notes`), the GitHub Release body and
 * fabplane.com/download. Local builds without the env var call `generateReleaseNotes` directly.
 *
 *   bun run scripts/release-notes.ts --json <file> [--out <md>] [--head <sha>] [--version <v>] [--repo owner/name]
 *   bun run scripts/release-notes.ts --from-json <file> --out <md> [--repo owner/name]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HandReleaseNote, ReleaseNotes } from "../packages/protocol/src/releases";

export const HAND_NOTES_FILE = "release-notes.json";
// import.meta.dirname is unset when electron-vite bundles this into its CJS config; it passes cwd.
const ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..") : process.cwd();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function git(args: string[], cwd = ROOT): string {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

/** Strips a trailing PR number and keeps the subject only. */
function subjectOf(line: string): string {
  return line.replace(/\s+\(#\d+\)$/, "").trim();
}

export function parseHandNotes(raw: string | null | undefined): HandReleaseNote[] {
  if (!raw?.trim()) return [];
  return HandReleaseNote.array().parse(JSON.parse(raw));
}

const HAND_SECTIONS = [
  ["new", "New"],
  ["improved", "Improved"],
  ["fixed", "Fixed"],
] as const;

export interface BuildReleaseNotesInput {
  head: string;
  version: string | null;
  date: string;
  previousTag: string | null;
  /** Hand-written entries at `head` and at the previous tag. */
  handNow: HandReleaseNote[];
  handBefore: HandReleaseNote[];
  /** Commit subjects since the previous tag, newest first. */
  log: string[];
}

export function buildReleaseNotes(input: BuildReleaseNotesInput): ReleaseNotes {
  const seen = new Set(input.handBefore.map((n) => n.id));
  const fresh = input.handNow.filter((n) => !seen.has(n.id));
  const base = {
    id: `${input.version ?? "dev"}+${input.head.slice(0, 7)}`,
    version: input.version,
    date: input.date,
    previousTag: input.previousTag,
  };
  if (fresh.length > 0) {
    const sections = HAND_SECTIONS.map(([key, title]) => ({ title, items: fresh.flatMap((n) => n[key] ?? []) })).filter(
      (s) => s.items.length > 0,
    );
    if (sections.length > 0) return { ...base, source: "hand", sections };
  }
  const items = input.log.map(subjectOf).filter((s) => s && !/^Merge (branch|pull request|remote-tracking)/i.test(s));
  return {
    ...base,
    source: "commits",
    sections: [
      {
        title: input.previousTag ? `Changes since ${input.previousTag}` : "Changes",
        items: items.length > 0 ? items : ["Maintenance release."],
      },
    ],
  };
}

/** The Markdown-lite subset fabplane.com renders: `Title:` lines, `- ` bullets, a "Full diff" line it drops. */
export function renderNotesMarkdown(notes: ReleaseNotes, opts: { repo?: string; head?: string } = {}): string {
  const lines: string[] = [];
  for (const section of notes.sections) {
    if (lines.length > 0) lines.push("");
    lines.push(`${section.title}:`, "");
    for (const item of section.items) lines.push(`- ${item}`);
  }
  if (opts.repo && opts.head && notes.previousTag) {
    lines.push("", `Full diff: https://github.com/${opts.repo}/compare/${notes.previousTag}...${opts.head.slice(0, 7)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Reads git and `release-notes.json` at `head`; used by the CLI and by local app builds. */
export function generateReleaseNotes(opts: { head?: string; version?: string | null; cwd?: string } = {}): ReleaseNotes {
  const cwd = opts.cwd ?? ROOT;
  const head = git(["rev-parse", opts.head ?? "HEAD"], cwd) || "dev";
  const previousTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*", `${head}^`], cwd) || null;
  const range = previousTag ? `${previousTag}..${head}` : `${head}~30..${head}`;
  const raw =
    git(["log", "--no-merges", "--pretty=%s", range], cwd) || git(["log", "--no-merges", "--pretty=%s", "-n", "30", head], cwd);
  const show = (rev: string) => git(["show", `${rev}:${HAND_NOTES_FILE}`], cwd);
  return buildReleaseNotes({
    head,
    version: opts.version ?? null,
    date: git(["show", "-s", "--format=%cI", head], cwd) || new Date().toISOString(),
    previousTag,
    handNow: parseHandNotes(show(head)),
    handBefore: previousTag ? parseHandNotes(show(previousTag)) : [],
    log: raw.split("\n").filter(Boolean),
  });
}

if (import.meta.main) {
  const repo = arg("repo");
  const out = arg("out");
  const fromJson = arg("from-json");
  const jsonOut = arg("json");
  if (!out && !jsonOut) {
    console.error("usage: bun run scripts/release-notes.ts (--json <file> | --from-json <file>) [--out <md>] [--head <sha>] [--version <v>] [--repo owner/name]");
    process.exit(2);
  }
  const head = arg("head", "HEAD") ?? "HEAD";
  const notes = fromJson
    ? ReleaseNotes.parse(JSON.parse(readFileSync(fromJson, "utf8")))
    : generateReleaseNotes({ head, version: arg("version") ?? null });
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(notes, null, 2)}\n`);
  if (out) {
    const sha = notes.id.split("+")[1] ?? head;
    writeFileSync(out, renderNotesMarkdown(notes, { ...(repo ? { repo } : {}), head: sha }));
  }
  console.log(`release notes ${notes.id}: ${notes.source}${notes.previousTag ? ` since ${notes.previousTag}` : ""}`);
}
