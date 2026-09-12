#!/usr/bin/env bun
/**
 * Stamps a release version into the root and app package.json files (CI only), and into the
 * mobile app's `app.json` — `expo.version` plus the native build numbers, which the stores require
 * to increase on every upload (eas.json has `appVersionSource: "local"`, so these are the truth).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_FILES = [
  "package.json",
  "apps/desktop/package.json",
  "apps/core/package.json",
];
export const MOBILE_APP_JSON = "apps/mobile/app.json";

/**
 * One integer for both stores, derived from the version so it needs no counter: `0.3.512` →
 * `300512`. Android's `versionCode` must fit in 2,100,000,000, which leaves room for major ≤ 20
 * and patch (the workflow run number) up to 99,999.
 */
export function buildNumber(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a major.minor.patch version: ${version}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (patch > 99_999 || minor > 999 || major > 20)
    throw new Error(`version out of build-number range: ${version}`);
  return major * 100_000_000 + minor * 100_000 + patch;
}

type MobileConfig = {
  expo: {
    version?: string;
    ios?: { buildNumber?: string };
    android?: { versionCode?: number };
  } & Record<string, unknown>;
};

/** `app.json` with the version and both build numbers set; everything else untouched. */
export function stampMobileConfig(config: MobileConfig, version: string): MobileConfig {
  const n = buildNumber(version);
  return {
    ...config,
    expo: {
      ...config.expo,
      version,
      ios: { ...(config.expo.ios ?? {}), buildNumber: String(n) },
      android: { ...(config.expo.android ?? {}), versionCode: n },
    },
  };
}

export function setVersion(
  root: string,
  version: string,
  log: (line: string) => void = console.log,
): void {
  for (const rel of PACKAGE_FILES) {
    const file = join(root, rel);
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
    pkg.version = version;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    log(`${rel}: ${version}`);
  }
  const file = join(root, MOBILE_APP_JSON);
  const stamped = stampMobileConfig(
    JSON.parse(readFileSync(file, "utf8")) as MobileConfig,
    version,
  );
  writeFileSync(file, `${JSON.stringify(stamped, null, 2)}\n`);
  log(`${MOBILE_APP_JSON}: ${version} (build ${stamped.expo.ios?.buildNumber})`);
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error("usage: bun run scripts/set-version.ts <major.minor.patch>");
    process.exit(2);
  }
  setVersion(fileURLToPath(new URL("..", import.meta.url)), version);
}
