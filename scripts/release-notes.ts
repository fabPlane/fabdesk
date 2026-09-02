#!/usr/bin/env bun
/**
 * Writes Markdown release notes: one bullet per non-merge commit since the previous `v*` tag
 * (or the last 30 commits when there is no tag). Runs in the release job and lands in
 * `manifest.json` (`notes`), the GitHub Release body, and fabplane.com/download.
 *
 *   bun run scripts/release-notes.ts --out artifacts/NOTES.md [--head <sha>] [--repo owner/name]
 */
import { writeFileSync } from "node:fs";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout).trim() : "";
}

/** Strips trailer lines (Co-Authored-By etc.) and keeps the subject only. */
function subjectOf(line: string): string {
  return line.replace(/\s+\(#\d+\)$/, "").trim();
}

export function buildNotes(opts: { head: string; previousTag: string | null; log: string[]; repo?: string }): string {
  const bullets = opts.log.map(subjectOf).filter((s) => s && !/^Merge (branch|pull request|remote-tracking)/i.test(s));
  const lines: string[] = [];
  if (opts.previousTag) lines.push(`Changes since ${opts.previousTag}:`, "");
  if (bullets.length === 0) lines.push("- Maintenance release.");
  for (const b of bullets) lines.push(`- ${b}`);
  if (opts.repo && opts.previousTag) {
    lines.push("", `Full diff: https://github.com/${opts.repo}/compare/${opts.previousTag}...${opts.head.slice(0, 7)}`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const head = arg("head", "HEAD") ?? "HEAD";
  const out = arg("out");
  if (!out) {
    console.error("usage: bun run scripts/release-notes.ts --out <file> [--head <sha>] [--repo owner/name]");
    process.exit(2);
  }
  const previousTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*", `${head}^`]) || null;
  const range = previousTag ? `${previousTag}..${head}` : `${head}~30..${head}`;
  const raw = git(["log", "--no-merges", "--pretty=%s", range]) || git(["log", "--no-merges", "--pretty=%s", "-n", "30", head]);
  const notes = buildNotes({ head, previousTag, log: raw.split("\n").filter(Boolean), ...(arg("repo") ? { repo: arg("repo") as string } : {}) });
  writeFileSync(out, notes);
  console.log(`wrote ${out} (${previousTag ? `since ${previousTag}` : "no previous tag"})`);
}
