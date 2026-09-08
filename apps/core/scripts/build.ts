#!/usr/bin/env bun
/**
 * Compile fabdesk-core with `bun build --compile`.
 *   bun run scripts/build.ts [--only bun-darwin-arm64] [--channel public|internal] [--all]
 * Output: apps/core/dist/<os>-<arch>/fabdesk-core[.exe]
 */
import { fileURLToPath } from "node:url";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-windows-x64"] as const;
type Target = (typeof TARGETS)[number];

const args = process.argv.slice(2);
const get = (k: string): string | undefined => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const chan = (get("--channel") ?? "public") as "public" | "internal";
if (chan !== "public" && chan !== "internal") throw new Error(`bad --channel ${chan}`);
const only = get("--only") as Target | undefined;
/** Sentry (docs/sentry.md): DSN/environment baked into the binary from the build env; the runtime env still overrides. */
const sentryDsn = process.env["SENTRY_DESKTOP_DSN"]?.trim() || process.env["FABDESK_SENTRY_DSN"]?.trim() || undefined;
const sentryEnvironment = process.env["SENTRY_ENVIRONMENT"]?.trim() || process.env["FABDESK_SENTRY_ENVIRONMENT"]?.trim() || undefined;
/** Release `fabdesk-core@<version>+<sha>`: CI has GITHUB_SHA, local builds ask git, else `dev`. */
function gitSha(): string {
  const ci = process.env["GITHUB_SHA"]?.trim();
  if (ci) return ci.slice(0, 7);
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    return (proc.success && proc.stdout.toString().trim()) || "dev";
  } catch {
    return "dev";
  }
}
const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
const sentryRelease = process.env["SENTRY_RELEASE"]?.trim() || `fabdesk-core@${pkg.version}+${gitSha()}`;
const all = args.includes("--all");

const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}` as Target;
const targets: Target[] = only ? [only] : all ? [...TARGETS] : [hostTarget];
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}`);

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(coreDir, "../..");
const entry = join(coreDir, "src/main.ts");

for (const target of targets) {
  const [, os, arch] = target.split("-");
  const outDir = join(coreDir, "dist", `${os}-${arch}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const outfile = join(outDir, os === "windows" ? "fabdesk-core.exe" : "fabdesk-core");
  const cmd = [
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    "--minify-syntax",
    "--define",
    `FABDESK_CHANNEL=${JSON.stringify(chan)}`,
    "--define",
    `process.env.FABDESK_CHANNEL=${JSON.stringify(chan)}`,
    "--define",
    "FABDESK_COMPILED=true",
    "--define",
    `FABDESK_SENTRY_RELEASE=${JSON.stringify(sentryRelease)}`,
    ...(sentryDsn ? ["--define", `FABDESK_SENTRY_DSN=${JSON.stringify(sentryDsn)}`] : []),
    ...(sentryEnvironment ? ["--define", `FABDESK_SENTRY_ENVIRONMENT=${JSON.stringify(sentryEnvironment)}`] : []),
    "--root",
    repoRoot,
    ...(os === "windows" ? ["--windows-hide-console"] : []),
    entry,
    "--outfile",
    outfile,
  ];
  process.stderr.write(`▸ ${target} (${chan}${sentryDsn ? `, sentry ${sentryRelease}` : ""}) → ${outfile}\n`);
  const proc = Bun.spawn(cmd, { cwd: coreDir, stdout: "inherit", stderr: "inherit", env: { ...process.env, FABDESK_CHANNEL: chan } });
  const code = await proc.exited;
  if (code !== 0) {
    process.stderr.write(`build failed for ${target} (exit ${code})\n`);
    process.exit(code);
  }
  const catalogAssets = join(coreDir, "assets/open-catalog");
  await cp(catalogAssets, join(outDir, "open-catalog"), { recursive: true });
}
process.stderr.write("done\n");
