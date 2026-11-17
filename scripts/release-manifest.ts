#!/usr/bin/env bun
/**
 * Builds `manifest.json` + `SHA256SUMS` for a set of installers.
 *
 * The manifest is the contract between fabdesk releases, the fabplane.com website script
 * (which republishes it as `desktop/latest.json`) and the desktop app's update checker.
 *
 *   bun run scripts/release-manifest.ts --dir artifacts --version 0.1.42 --tag v0.1.42 \
 *     --repo fabPlane/fabdesk --commit <sha> --out artifacts/manifest.json --sums artifacts/SHA256SUMS \
 *     [--notes-file artifacts/NOTES.md]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

export type ReleasePlatform = "darwin" | "linux" | "win32";
export type ReleaseArch = "arm64" | "x64";
export type ReleaseKind = "dmg" | "zip" | "AppImage" | "deb" | "exe" | "portable";

export interface ReleaseAsset {
  filename: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  kind: ReleaseKind;
  url: string;
  sha256: string;
  size: number;
}

export interface ReleaseManifest {
  schema: 1;
  version: string;
  tag: string;
  channel: "public";
  commit: string;
  publishedAt: string;
  releaseUrl: string;
  /** Markdown release notes (commit list since the previous tag); shown on fabplane.com/download. */
  notes?: string;
  assets: ReleaseAsset[];
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

/** Classifies an electron-builder artifact name (`fabPlane-0.2.0-mac-arm64.dmg`). */
export function classify(filename: string): Pick<ReleaseAsset, "platform" | "arch" | "kind"> | null {
  const lower = filename.toLowerCase();
  const arch: ReleaseArch = /arm64|aarch64/.test(lower) ? "arm64" : "x64";
  if (lower.endsWith(".dmg")) return { platform: "darwin", arch, kind: "dmg" };
  if (lower.endsWith(".zip") && /mac|darwin/.test(lower)) return { platform: "darwin", arch, kind: "zip" };
  if (lower.endsWith(".appimage")) return { platform: "linux", arch, kind: "AppImage" };
  if (lower.endsWith(".deb")) return { platform: "linux", arch, kind: "deb" };
  if (lower.endsWith(".exe")) return { platform: "win32", arch, kind: /portable/.test(lower) ? "portable" : "exe" };
  return null;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildManifest(opts: {
  dir: string;
  version: string;
  tag: string;
  repo: string;
  commit: string;
  baseUrl?: string;
  notes?: string;
}): { manifest: ReleaseManifest; sums: string } {
  const baseUrl = opts.baseUrl ?? `https://github.com/${opts.repo}/releases/download/${opts.tag}`;
  const assets: ReleaseAsset[] = [];
  const sums: string[] = [];
  for (const name of readdirSync(opts.dir).sort()) {
    const info = classify(name);
    if (!info) continue;
    const path = join(opts.dir, name);
    const sha256 = sha256File(path);
    assets.push({
      filename: name,
      ...info,
      url: `${baseUrl}/${encodeURIComponent(name)}`,
      sha256,
      size: statSync(path).size,
    });
    sums.push(`${sha256}  ${name}`);
  }
  if (assets.length === 0) throw new Error(`no installers found in ${opts.dir}`);
  return {
    manifest: {
      schema: 1,
      version: opts.version,
      tag: opts.tag,
      channel: "public",
      commit: opts.commit,
      publishedAt: new Date().toISOString(),
      releaseUrl: `https://github.com/${opts.repo}/releases/tag/${opts.tag}`,
      ...(opts.notes && opts.notes.trim() ? { notes: opts.notes.trim() } : {}),
      assets,
    },
    sums: `${sums.join("\n")}\n`,
  };
}

if (import.meta.main) {
  const { manifest, sums } = buildManifest({
    dir: arg("dir"),
    version: arg("version"),
    tag: arg("tag"),
    repo: arg("repo", process.env.GITHUB_REPOSITORY || "fabPlane/fabdesk"),
    commit: arg("commit", "unknown"),
    ...(process.argv.includes("--base-url") ? { baseUrl: arg("base-url") } : {}),
    ...(process.argv.includes("--notes-file") ? { notes: readFileSync(arg("notes-file"), "utf8") } : {}),
  });
  writeFileSync(arg("out"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(arg("sums"), sums);
  console.log(`${manifest.assets.length} assets → ${basename(arg("out"))}, ${basename(arg("sums"))}`);
}
