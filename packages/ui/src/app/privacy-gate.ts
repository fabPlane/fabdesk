import type { PrivacyStatus, Settings } from "@fabdesk/protocol";

/**
 * Whether undecided installations get the first-install privacy screen; null while the core has
 * not answered. A core without `GET /privacy` predates region gating and always asks first.
 */
export function privacyScreenRequired(query: { data?: PrivacyStatus | undefined; isError: boolean }): boolean | null {
  if (query.data) return query.data.firstInstallScreen;
  return query.isError ? true : null;
}

export function needsPrivacyScreen(
  settings: Pick<Settings, "usageArchiveChoiceComplete">,
  screenRequired: boolean,
): boolean {
  return screenRequired && !settings.usageArchiveChoiceComplete;
}
