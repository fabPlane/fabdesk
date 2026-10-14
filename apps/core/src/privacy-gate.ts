/** Decides whether this installation gets the first-install privacy screen (docs/usage-data-backup.md). */
import {
  detectConsentRegion,
  FIRST_INSTALL_PRIVACY_SCREEN,
  PrivacyScreenMode,
  type PrivacyStatus,
} from "@fabdesk/protocol";
import type { SettingsRepo } from "./db";

/** Set once an installation has been detected in the consent region, so leaving it later (travel, a changed zone) does not drop the screen. */
export const CONSENT_REGION_REMEMBERED_KEY = "usage_archive_consent_region";

/**
 * OS locales, most specific first: `FABDESK_SYSTEM_LOCALES` (comma-separated, passed by the
 * desktop app from Electron, since GUI launches on macOS and Windows have no `LANG`), then the
 * POSIX locale variables, then the runtime's default locale.
 */
export function systemLocales(
  env: NodeJS.ProcessEnv = process.env,
  runtimeLocale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): string[] {
  const candidates = [
    ...(env["FABDESK_SYSTEM_LOCALES"]?.split(",") ?? []),
    env["LC_ALL"],
    env["LC_MESSAGES"],
    env["LANG"],
    ...(env["LANGUAGE"]?.split(":") ?? []),
    runtimeLocale,
  ];
  return candidates.map((l) => l?.trim() ?? "").filter((l) => l.length > 0);
}

export function resolvePrivacyStatus(opts: {
  settings: Pick<SettingsRepo, "readRaw" | "writeRaw">;
  env?: NodeJS.ProcessEnv;
  timeZone?: string | undefined;
  locales?: string[];
  mode?: PrivacyScreenMode;
}): PrivacyStatus {
  const env = opts.env ?? process.env;
  const override = PrivacyScreenMode.safeParse(env["FABDESK_PRIVACY_SCREEN"]?.trim());
  const mode = override.success ? override.data : (opts.mode ?? FIRST_INSTALL_PRIVACY_SCREEN);
  const detected = detectConsentRegion({
    timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locales: opts.locales ?? systemLocales(env),
  });
  let region: PrivacyStatus["region"] = detected;
  if (detected.likelyInRegion) {
    if (opts.settings.readRaw(CONSENT_REGION_REMEMBERED_KEY) !== true)
      opts.settings.writeRaw(CONSENT_REGION_REMEMBERED_KEY, true);
  } else if (opts.settings.readRaw(CONSENT_REGION_REMEMBERED_KEY) === true) {
    region = { likelyInRegion: true, signal: "remembered", country: null };
  }
  const firstInstallScreen = mode === "always" || (mode === "auto" && region.likelyInRegion);
  return { mode, firstInstallScreen, region };
}
