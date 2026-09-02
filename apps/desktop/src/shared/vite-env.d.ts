/** Build-time env exposed by electron-vite to main, preload and renderer (`VITE_` prefix). */
interface ImportMetaEnv {
  /** Sentry DSN baked in at build time (CI: `FABDESK_SENTRY_DSN` secret). See docs/sentry.md. */
  readonly VITE_FABDESK_SENTRY_DSN?: string;
}
