/**
 * A pinned uv (https://github.com/astral-sh/uv) for machines that have neither uv nor a Python new enough for
 * KiCadRoutingTools' lock: the release archive for this OS/arch is downloaded once into the fabdesk data dir
 * (`<home>/routers/uv/<version>/`), checked against the sha256 below, and used to provision a uv-managed CPython
 * (uv checks each Python download against its own built-in sha256 table).
 *
 * Hashes are the ones astral-sh/uv publishes for the release (`sha256.sum`, identical to GitHub's asset digests),
 * copied 2026-11-12. Linux uses the static musl builds, which run on glibc and musl distributions alike.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { posix, win32 } from "node:path";
import { downloadAndVerify } from "./checksum";
import { extractZipArchive } from "./zip";

export const UV_VERSION = "0.13.6";

export type UvAsset = { target: string; format: "tar.gz" | "zip"; sha256: string; bytes: number };

/** One asset per supported OS/arch: `uv-<target>.<format>` of the release. */
export const UV_ASSETS: Readonly<Record<string, UvAsset>> = {
  "linux-x64": { target: "x86_64-unknown-linux-musl", format: "tar.gz", sha256: "5d61f26b6c7213779eda90edc6971ea6b0b796bfb8d49a574c8ad69b59838548", bytes: 18_383_831 },
  "linux-arm64": { target: "aarch64-unknown-linux-musl", format: "tar.gz", sha256: "819692e404d23e5aae6bc44c0e260f1f5492fd1910ab4693b2c650f926dbe800", bytes: 16_993_447 },
  "darwin-arm64": { target: "aarch64-apple-darwin", format: "tar.gz", sha256: "60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472", bytes: 14_235_670 },
  "darwin-x64": { target: "x86_64-apple-darwin", format: "tar.gz", sha256: "63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02", bytes: 17_004_934 },
  "win32-x64": { target: "x86_64-pc-windows-msvc", format: "zip", sha256: "a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f", bytes: 15_239_500 },
  "win32-arm64": { target: "aarch64-pc-windows-msvc", format: "zip", sha256: "c2426c0c8e28b53d8c440e47a18d96ad4db51e159866c0e81435b196d7f0081c", bytes: 15_439_263 },
};

const normArch = (arch: string) => (arch === "x86_64" || arch === "amd64" ? "x64" : arch === "aarch64" ? "arm64" : arch);

export function uvAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): (UvAsset & { url: string; filename: string }) | null {
  const asset = UV_ASSETS[`${platform}-${normArch(arch)}`];
  if (!asset) return null;
  const filename = `uv-${asset.target}.${asset.format}`;
  return { ...asset, filename, url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${filename}` };
}

/** Where the bootstrapped uv lives under a routers root. */
export function uvHome(routersRoot: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? win32 : posix).join(routersRoot, "uv", UV_VERSION);
}

export function bootstrappedUvPath(routersRoot: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? win32 : posix).join(uvHome(routersRoot, platform), platform === "win32" ? "uv.exe" : "uv");
}

export type UvBootstrapDeps = {
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Extract runner (`tar`, `unzip`, ...); injectable for tests. */
  spawn?: (cmd: string, args: string[]) => Promise<number>;
  /** Tests only: another archive than the pinned one for this OS/arch. */
  asset?: UvAsset & { url: string; filename: string };
};

const inflight = new Map<string, Promise<string>>();

/**
 * The pinned uv under `routersRoot`, downloading and verifying it on first use. Concurrent callers share one
 * download. Throws when this OS/arch has no uv build or the download fails.
 */
export function bootstrapUv(routersRoot: string, deps: UvBootstrapDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const exe = bootstrappedUvPath(routersRoot, platform);
  if (existsSync(exe)) return Promise.resolve(exe);
  const running = inflight.get(exe);
  if (running) return running;
  const job = doBootstrap(routersRoot, exe, deps).finally(() => inflight.delete(exe));
  inflight.set(exe, job);
  return job;
}

async function doBootstrap(routersRoot: string, exe: string, deps: UvBootstrapDeps): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const p = platform === "win32" ? win32 : posix;
  const asset = deps.asset ?? uvAsset(platform, arch);
  if (!asset) throw new Error(`no pinned uv build for ${platform}-${arch}`);
  const home = uvHome(routersRoot, platform);
  const work = `${home}.partial-${process.pid}`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    deps.log?.(`uv ${UV_VERSION}: downloading ${asset.filename} (${Math.round(asset.bytes / 1e6)} MB)`);
    const archive = p.join(work, asset.filename);
    await downloadAndVerify({
      url: asset.url,
      dest: archive,
      sha256: asset.sha256,
      bytes: asset.bytes,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.fetch ? { fetchImpl: deps.fetch } : {}),
    });
    const out = p.join(work, "x");
    mkdirSync(out, { recursive: true });
    const spawn = deps.spawn ?? defaultSpawn;
    if (asset.format === "tar.gz") {
      const code = await spawn("tar", ["-xzf", archive, "-C", out]);
      if (code !== 0) throw new Error(`could not extract ${asset.filename} (tar exited ${code})`);
    } else await extractZipArchive(archive, out, spawn, platform);
    const name = platform === "win32" ? "uv.exe" : "uv";
    const found = findFile(out, name);
    if (!found) throw new Error(`${asset.filename} has no ${name}`);
    if (platform !== "win32") chmodSync(found, 0o755);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    renameSync(found, exe);
    deps.log?.(`uv ${UV_VERSION}: ready at ${exe}`);
    return exe;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function findFile(dir: string, name: string, depth = 0): string | null {
  if (depth > 3) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry === name && statSync(full).isFile()) return full;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function defaultSpawn(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
