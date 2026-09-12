/**
 * Dynamic layer over `app.json`. Expo evaluates this file with the static config as `config`, so
 * everything a human edits (bundle ids, plist keys, permissions, plugins) stays in `app.json` and
 * `scripts/set-version.ts` can keep stamping `version` / `buildNumber` / `versionCode` there. This
 * file adds only what has to come from the build environment:
 *
 * - `extra.sentryDsn` from `SENTRY_DSN_MOBILE`, read by `src/observability.ts` at runtime. No DSN
 *   means no Sentry plugin either, so a build without one has no native Sentry config and no
 *   source-map upload phase — it cannot fail on a missing auth token.
 * - `extra.eas.projectId` from `EAS_PROJECT_ID` when set (CI), else whatever `eas init` wrote.
 * - the privacy manifest (`plugins/with-privacy-manifest.js`), which is a plugin only so its
 *   contents live in one reviewable file rather than inside `app.json`.
 *
 * On EAS the environment is the project's EAS environment variables, not the shell that ran
 * `eas build` (docs/mobile-release.md).
 */
import type { ExpoConfig } from "expo/config";

type ConfigContext = { config: Partial<ExpoConfig> };

const env = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const sentryDsn = env("SENTRY_DSN_MOBILE");
  const sentryOrg = env("SENTRY_ORG");
  const sentryProject = env("SENTRY_PROJECT");
  const easProjectId = env("EAS_PROJECT_ID");

  const plugins = [...(config.plugins ?? []), "./plugins/with-privacy-manifest.js"];
  if (sentryDsn) {
    // `organization`/`project` fall back to SENTRY_ORG / SENTRY_PROJECT at upload time when
    // unset; the auth token is never in config, only in SENTRY_AUTH_TOKEN.
    plugins.push([
      "@sentry/react-native/expo",
      {
        ...(sentryOrg ? { organization: sentryOrg } : {}),
        ...(sentryProject ? { project: sentryProject } : {}),
        url: env("SENTRY_URL") ?? "https://sentry.io/",
      },
    ]);
  }

  const extra = { ...(config.extra ?? {}) } as Record<string, unknown>;
  const eas = { ...((extra["eas"] as Record<string, unknown> | undefined) ?? {}) };
  if (easProjectId) eas["projectId"] = easProjectId;
  extra["eas"] = eas;
  if (sentryDsn) extra["sentryDsn"] = sentryDsn;
  // EAS sets EAS_BUILD_PROFILE on its builders, so preview/production tag themselves.
  extra["sentryEnvironment"] =
    env("SENTRY_ENVIRONMENT") ?? env("EAS_BUILD_PROFILE") ?? "development";

  return {
    ...config,
    name: config.name ?? "fabPlane",
    slug: config.slug ?? "fabplane-mobile",
    plugins,
    extra,
  };
};
