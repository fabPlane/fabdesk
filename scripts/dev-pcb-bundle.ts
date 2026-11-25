/**
 * Finds a FabPlane PCB backend bundle (`resources/pcb/bundle.json`) for a development run: one
 * packaged or downloaded under `apps/desktop/release`, else the one inside an installed fabPlane.
 * The desktop main process starts and owns the bridge from whichever bundle it is given.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function bundleTargetFor(platform: NodeJS.Platform, arch: string): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

async function findBundles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findBundles(path)));
    else if (entry.name === "bundle.json" && /[\\/]resources[\\/]pcb[\\/]bundle\.json$/.test(path))
      found.push(path);
  }
  return found;
}

export async function bundleTarget(path: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { format?: number; target?: string };
    return value.format === 1 && typeof value.target === "string" ? value.target : null;
  } catch {
    return null;
  }
}

/** Where an installed fabPlane keeps its PCB bundle, per platform (default install locations). */
export function installedBundleCandidates(opts: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home?: string;
}): string[] {
  const home = opts.home ?? homedir();
  if (opts.platform === "darwin")
    return ["/Applications", join(home, "Applications")].map((dir) =>
      join(dir, "fabPlane.app", "Contents", "Resources", "pcb", "bundle.json"),
    );
  if (opts.platform === "win32")
    return [
      opts.env["LOCALAPPDATA"] ? join(opts.env["LOCALAPPDATA"], "Programs", "fabPlane") : null,
      opts.env["ProgramFiles"] ? join(opts.env["ProgramFiles"], "fabPlane") : null,
    ]
      .filter((dir): dir is string => dir !== null)
      .map((dir) => join(dir, "resources", "pcb", "bundle.json"));
  return [join("/opt", "fabPlane", "resources", "pcb", "bundle.json")];
}

export type DiscoveredBundle = { path: string; origin: "release" | "installed" };

/** First bundle built for this platform: the repo's release folder wins over an installed app. */
export async function discoverPcbBundle(opts: {
  root: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  installed?: string[];
}): Promise<DiscoveredBundle | null> {
  const platform = opts.platform ?? process.platform;
  const target = bundleTargetFor(platform, opts.arch ?? process.arch);
  for (const path of await findBundles(join(opts.root, "apps", "desktop", "release")))
    if ((await bundleTarget(path)) === target) return { path, origin: "release" };
  const installed =
    opts.installed ??
    installedBundleCandidates({
      platform,
      env: opts.env ?? process.env,
      ...(opts.home ? { home: opts.home } : {}),
    });
  for (const path of installed)
    if (existsSync(path) && (await bundleTarget(path)) === target) return { path, origin: "installed" };
  return null;
}

/**
 * Environment additions for a plain `bun run dev`. Nothing when the developer already chose a
 * backend (bundle, bridge binary or bridge URL) or opted out with `FABDESK_DEV_PCB=0`.
 */
export async function devPcbEnvironment(opts: {
  root: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  installed?: string[];
}): Promise<{ env: Record<string, string>; note: string }> {
  const { env } = opts;
  if (env["FABDESK_DEV_PCB"] === "0") return { env: {}, note: "PCB backend off (FABDESK_DEV_PCB=0)" };
  for (const key of ["FABDESK_FP_PCB_BUNDLE", "FABDESK_FP_PCB_BRIDGE_BIN", "FABDESK_FP_PCB_BRIDGE_URL"])
    if (env[key]?.trim()) return { env: {}, note: `PCB backend from ${key}` };
  const found = await discoverPcbBundle({
    root: opts.root,
    env,
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.arch ? { arch: opts.arch } : {}),
    ...(opts.installed ? { installed: opts.installed } : {}),
  });
  if (!found)
    return {
      env: {},
      note: "no PCB backend bundle found; board editing and routing will be unavailable (install fabPlane, package the backend, or set FABDESK_FP_PCB_BUNDLE)",
    };
  return {
    env: { FABDESK_FP_PCB_BUNDLE: found.path, FABDESK_DEV_PCB_DISCOVERED_BUNDLE: found.path },
    note: `PCB backend=${found.path} (${found.origin === "installed" ? "installed fabPlane" : "release folder"})`,
  };
}
