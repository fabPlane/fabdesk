/** Build-time env exposed by electron-vite to main, preload and renderer (`VITE_` prefix). See docs/sentry.md. */
interface ImportMetaEnv {
  /** Sentry DSN baked in at build time (CI: `SENTRY_DESKTOP_DSN` secret). */
  readonly VITE_SENTRY_DESKTOP_DSN?: string;
  /** Legacy spelling of VITE_SENTRY_DESKTOP_DSN. */
  readonly VITE_FABDESK_SENTRY_DSN?: string;
  /** Sentry environment baked in at build time (default: production when packaged, else development). */
  readonly VITE_SENTRY_ENVIRONMENT?: string;
}

/** `fabdesk@<version>+<git-sha>` (or `VITE_SENTRY_RELEASE` / `SENTRY_RELEASE` at build time); electron.vite.config.ts `define`. */
declare const __FABDESK_SENTRY_RELEASE__: string;
/** This build's release notes (scripts/release-notes.ts), as JSON; parsed with `ReleaseNotes`. */
declare const __FABDESK_RELEASE_NOTES__: unknown;
