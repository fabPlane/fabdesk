#!/usr/bin/env bun
/**
 * Stage the FabPlane KiCad fork next to the desktop packager so afterPack can copy it into
 * `Resources/kicad/`. Without a staged tree, installers ship without KiCad and doctor warns.
 *
 * Sources (first match wins):
 *   1. `--from <dir>` or `$FABDESK_KICAD_BUNDLE` — local tree already laid out for the target
 *   2. `$FABDESK_KICAD_BUNDLE_URL` — URL template (`{target}` `{platform}` `{arch}` `{os}` `{nightlyPlatform}`)
 *   3. Rolling `nightly` GitHub Release on `$FABDESK_KICAD_REPO` (default `TensorFleet/kicad`) —
 *      reads `manifest.json`, else picks a release asset by name. `/releases/latest` is wrong here:
 *      the rolling tag is a prerelease.
 *
 * Nightly asset names (see TensorFleet/kicad `tools/nightly/README.md`):
 *   kicad-cli-linux-x86_64.tar.gz | kicad-cli-macos-arm64.tar.gz |
 *   kicad-cli-macos-x86_64.tar.gz | kicad-cli-windows-x86_64.zip
 *
 * After staging (top-level `kicad-cli/` flattened):
 *   Linux/macOS: ./kicad-cli
 *   Windows:     ./bin/kicad-cli.exe
 *
 *   bun run scripts/stage-kicad-bundle.ts [--target bun-darwin-arm64] [--from /path] [--require]
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-windows-x64"] as const;
export type Target = (typeof TARGETS)[number];

export const DEFAULT_KICAD_REPO = "TensorFleet/kicad";
export const DEFAULT_KICAD_RELEASE = "nightly";

/** GitHub Actions exposes unset repository variables as empty strings. */
export function nonEmptySetting(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

/** Nightly manifest / asset platform keys ↔ fabdesk package targets. */
export const NIGHTLY_PLATFORM_BY_TARGET: Record<Target, string> = {
  "bun-darwin-arm64": "macos-arm64",
  "bun-darwin-x64": "macos-x86_64",
  "bun-linux-x64": "linux-x86_64",
  "bun-windows-x64": "windows-x86_64",
};

const argv = process.argv.slice(2);
const flag = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

function hostTarget(): Target {
  const os =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${os}-${arch}` as Target;
}

export function targetOs(target: Target): "darwin" | "linux" | "windows" {
  return target.split("-")[1] as "darwin" | "linux" | "windows";
}

export function targetArch(target: Target): "arm64" | "x64" {
  return target.endsWith("arm64") ? "arm64" : "x64";
}

export type ReleaseAsset = { name: string; browser_download_url: string; size?: number };

export type NightlyManifestAsset = {
  file: string;
  url: string;
  sha256?: string;
  entrypoint?: string;
  commit?: string;
  version?: string;
  tag?: string;
};

export type NightlyManifest = {
  schema?: number;
  release?: string;
  tag?: string;
  commit?: string;
  version?: string;
  assets: Record<string, NightlyManifestAsset>;
};

export function nightlyAssetName(target: Target): string {
  const platform = NIGHTLY_PLATFORM_BY_TARGET[target];
  return targetOs(target) === "windows"
    ? `kicad-cli-${platform}.zip`
    : `kicad-cli-${platform}.tar.gz`;
}

/** Pick a release asset by name when no manifest is available. */
export function pickKicadReleaseAsset(assets: ReleaseAsset[], target: Target): ReleaseAsset | null {
  const want = nightlyAssetName(target).toLowerCase();
  const exact = assets.find((a) => a.name.toLowerCase() === want);
  if (exact) return exact;

  const platform = NIGHTLY_PLATFORM_BY_TARGET[target];
  const os = targetOs(target);
  const arch = targetArch(target);
  const platformTokens =
    os === "darwin"
      ? ["darwin", "macos", "osx"]
      : os === "windows"
        ? ["windows", "win64", "win32"]
        : ["linux"];
  const archTokens = arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "x86_64", "amd64", "x86-64"];
  const scored = assets
    .filter((a) => /\.(tar\.gz|tgz|zip)$/i.test(a.name))
    .map((a) => {
      const n = a.name.toLowerCase();
      const plat = n.includes(platform) || platformTokens.some((t) => n.includes(t));
      const ar =
        arch === "arm64"
          ? archTokens.some((t) => n.includes(t))
          : archTokens.some((t) => n.includes(t)) && !n.includes("arm64") && !n.includes("aarch64");
      if (!plat || !ar) return null;
      let score = 1;
      if (n.includes("kicad-cli") || n.includes("kicad")) score += 2;
      if (n.includes(platform)) score += 3;
      return { asset: a, score };
    })
    .filter((x): x is { asset: ReleaseAsset; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));
  return scored[0]?.asset ?? null;
}

async function githubJson<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "fabdesk-stage-kicad-bundle",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${url}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function fetchText(url: string, token?: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "fabdesk-stage-kicad-bundle",
    Accept: "*/*",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  return await res.text();
}

/** Paths where a staged / nightly tree may place kicad-cli. */
export function expectedCliCandidates(root: string, os: string): string[] {
  if (os === "darwin") {
    return [
      join(root, "kicad-cli"),
      join(root, "kicad-cli", "kicad-cli"),
      join(root, "KiCad.app", "Contents", "MacOS", "kicad-cli"),
      join(root, "bin", "kicad-cli"),
    ];
  }
  if (os === "windows") {
    return [
      join(root, "bin", "kicad-cli.exe"),
      join(root, "kicad-cli", "bin", "kicad-cli.exe"),
      join(root, "kicad-cli.exe"),
    ];
  }
  return [
    join(root, "kicad-cli"),
    join(root, "kicad-cli", "kicad-cli"),
    join(root, "bin", "kicad-cli"),
    join(root, "kicad-cli", "bin", "kicad-cli"),
  ];
}

function isCliFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function findCli(root: string, os: string): string | null {
  // Must be a file: the nightly archive's top-level dir is also named `kicad-cli/`.
  return expectedCliCandidates(root, os).find((p) => isCliFile(p)) ?? null;
}

async function assertTree(root: string, os: string): Promise<string> {
  const cli = findCli(root, os);
  if (!cli) {
    throw new Error(
      `KiCad tree at ${root} is missing kicad-cli (tried ${expectedCliCandidates(root, os).join(", ")})`,
    );
  }
  return cli;
}

/** True when the staged tree already matches the packager layout (top-level launcher file). */
function isCanonicalLayout(stageDir: string, os: string): boolean {
  if (os === "windows") {
    return (
      isCliFile(join(stageDir, "bin", "kicad-cli.exe")) ||
      isCliFile(join(stageDir, "kicad-cli.exe"))
    );
  }
  if (os === "darwin" && isCliFile(join(stageDir, "KiCad.app", "Contents", "MacOS", "kicad-cli"))) {
    return true;
  }
  // Top-level `kicad-cli` must be a file — the nightly archive uses a directory of the same name.
  return isCliFile(join(stageDir, "kicad-cli"));
}

/** Replace `stageDir` contents with the contents of `fromDir` (promote one nesting level). */
async function promoteContents(fromDir: string, stageDir: string): Promise<void> {
  const tmp = `${stageDir}.flat`;
  await rm(tmp, { recursive: true, force: true });
  await cp(fromDir, tmp, { recursive: true });
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  for (const name of readdirSync(tmp)) {
    renameSync(join(tmp, name), join(stageDir, name));
  }
  await rm(tmp, { recursive: true, force: true });
}

/**
 * Nightly archives ship as `kicad-cli/{kicad-cli,lib,...}`. Packaging and runtime expect
 * `Resources/kicad/kicad-cli` (a file). Promote that nesting — do not treat "cli found nested"
 * as already flat.
 */
export async function flattenIfNeeded(stageDir: string, os: string): Promise<void> {
  if (isCanonicalLayout(stageDir, os)) return;

  // Nightly tarball: stageDir/kicad-cli/{kicad-cli,lib,share,...}
  const nested = join(stageDir, "kicad-cli");
  if (existsSync(nested) && statSync(nested).isDirectory() && findCli(nested, os)) {
    await promoteContents(nested, stageDir);
    return;
  }

  // Single wrapper folder (hash-named extract root, etc.)
  const kids = readdirSync(stageDir).filter((n) => !n.startsWith("_"));
  if (kids.length !== 1) return;
  const only = join(stageDir, kids[0]!);
  if (!statSync(only).isDirectory() || !findCli(only, os)) return;
  await promoteContents(only, stageDir);
}

async function extractArchive(
  buf: Buffer,
  stageDir: string,
  kind: "zip" | "tar.gz",
  os: string,
): Promise<string> {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  const archive = join(stageDir, kind === "zip" ? "_bundle.zip" : "_bundle.tar.gz");
  await writeFile(archive, buf);
  const extract =
    kind === "zip"
      ? ["unzip", "-q", archive, "-d", stageDir]
      : ["tar", "-xzf", archive, "-C", stageDir];
  const proc = Bun.spawn(extract, { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`extract failed for ${archive}`);
  await rm(archive, { force: true });
  await flattenIfNeeded(stageDir, os);
  return await assertTree(stageDir, os);
}

async function downloadUrl(
  url: string,
  stageDir: string,
  os: string,
  token?: string,
  expectSha256?: string,
): Promise<string> {
  process.stderr.write(`▸ downloading ${url}\n`);
  const headers: Record<string, string> = {
    "User-Agent": "fabdesk-stage-kicad-bundle",
    Accept: "application/octet-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  process.stderr.write(`  sha256 ${sha} (${buf.byteLength} bytes)\n`);
  if (expectSha256 && expectSha256.toLowerCase() !== sha.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${url}: expected ${expectSha256}, got ${sha}`);
  }
  return await extractArchive(buf, stageDir, /\.zip$/i.test(url) ? "zip" : "tar.gz", os);
}

async function copyFrom(src: string, stageDir: string, os: string): Promise<string> {
  await assertTree(src, os);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(dirname(stageDir), { recursive: true });
  await cp(src, stageDir, { recursive: true });
  await flattenIfNeeded(stageDir, os);
  return await assertTree(stageDir, os);
}

/**
 * Resolve the download for a fabdesk target from TensorFleet/kicad's rolling nightly release.
 * Prefer manifest.json; fall back to the GitHub release asset list by tag (not /latest).
 */
export async function nightlyKicadDownloadUrl(opts: {
  target: Target;
  repo?: string;
  release?: string;
  token?: string;
  fetchJson?: typeof githubJson;
  fetchText?: typeof fetchText;
}): Promise<{
  tag: string;
  name: string;
  url: string;
  sha256?: string;
  commit?: string;
  version?: string;
}> {
  const repo = nonEmptySetting(opts.repo ?? process.env["FABDESK_KICAD_REPO"], DEFAULT_KICAD_REPO);
  const releaseTag = nonEmptySetting(
    opts.release ?? process.env["FABDESK_KICAD_RELEASE"],
    DEFAULT_KICAD_RELEASE,
  );
  const token = opts.token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  const fetchJson = opts.fetchJson ?? githubJson;
  const fetchTxt = opts.fetchText ?? fetchText;
  const platform = NIGHTLY_PLATFORM_BY_TARGET[opts.target];

  const manifestUrl = `https://github.com/${repo}/releases/download/${releaseTag}/manifest.json`;
  try {
    const raw = await fetchTxt(manifestUrl, token);
    const manifest = JSON.parse(raw) as NightlyManifest;
    const asset = manifest.assets?.[platform];
    if (asset?.url) {
      return {
        tag: manifest.tag ?? releaseTag,
        name: asset.file ?? nightlyAssetName(opts.target),
        url: asset.url,
        ...(asset.sha256 ? { sha256: asset.sha256 } : {}),
        ...((asset.commit ?? manifest.commit) ? { commit: asset.commit ?? manifest.commit } : {}),
        ...((asset.version ?? manifest.version)
          ? { version: asset.version ?? manifest.version }
          : {}),
      };
    }
  } catch (e) {
    process.stderr.write(
      `stage-kicad-bundle: manifest ${manifestUrl} unavailable (${e instanceof Error ? e.message : e}); trying release assets\n`,
    );
  }

  const release = await fetchJson<{ tag_name: string; assets: ReleaseAsset[] }>(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`,
    token,
  );
  const asset = pickKicadReleaseAsset(release.assets ?? [], opts.target);
  if (!asset) {
    const names = (release.assets ?? []).map((a) => a.name).join(", ") || "(none)";
    throw new Error(
      `No KiCad asset for ${opts.target} (${platform}) in ${repo}@${release.tag_name}. Assets: ${names}. Expected ${nightlyAssetName(opts.target)}.`,
    );
  }
  return { tag: release.tag_name, name: asset.name, url: asset.browser_download_url };
}

async function main(): Promise<void> {
  const target = (flag("--target") ?? hostTarget()) as Target;
  if (!TARGETS.includes(target)) throw new Error(`unknown --target ${target}`);
  const os = targetOs(target);
  const arch = targetArch(target);
  const fromArg = flag("--from") ?? process.env["FABDESK_KICAD_BUNDLE"];
  const urlTpl = process.env["FABDESK_KICAD_BUNDLE_URL"];
  const requireSource =
    argv.includes("--require") || process.env["FABDESK_KICAD_BUNDLE_REQUIRED"] === "1";

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const stageDir = join(repoRoot, "apps/desktop/kicad-bundle", `${os}-${arch}`);
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];

  let cli: string;
  if (fromArg) {
    cli = await copyFrom(resolve(fromArg), stageDir, os);
  } else if (urlTpl) {
    const url = urlTpl
      .replaceAll("{target}", target)
      .replaceAll("{platform}", os)
      .replaceAll("{arch}", arch)
      .replaceAll("{os}", os)
      .replaceAll("{nightlyPlatform}", NIGHTLY_PLATFORM_BY_TARGET[target]);
    cli = await downloadUrl(url, stageDir, os, token);
  } else {
    try {
      const dl = await nightlyKicadDownloadUrl({ target, ...(token ? { token } : {}) });
      process.stderr.write(
        `▸ ${nonEmptySetting(process.env["FABDESK_KICAD_REPO"], DEFAULT_KICAD_REPO)}@${dl.tag} → ${dl.name}` +
          (dl.commit ? ` (${dl.commit.slice(0, 10)})` : "") +
          "\n",
      );
      cli = await downloadUrl(dl.url, stageDir, os, token, dl.sha256);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!requireSource) {
        process.stderr.write(`stage-kicad-bundle: ${msg}\n`);
        process.stderr.write(
          `stage-kicad-bundle: leaving ${stageDir} untouched (pass --require to fail)\n`,
        );
        process.exit(0);
      }
      throw e;
    }
  }

  process.stderr.write(`▸ staged ${target} → ${stageDir}\n`);
  process.stderr.write(`  cli ${cli}\n`);
}

if (import.meta.main) {
  await main();
}
