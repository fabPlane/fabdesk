/** AppImage launcher paths describe Electron's AppDir and must not leak into sidecars. */
const APPIMAGE_RUNTIME_ENV = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] as const;

export function sidecarEnvironment(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = { ...base, ...extra };
  for (const key of APPIMAGE_RUNTIME_ENV) delete env[key];
  return env;
}

/** Activate the packaged desktop's uploader; the core still enforces the user's privacy choice. */
export function coreEnvironment(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  packaged: boolean,
): NodeJS.ProcessEnv {
  const env = sidecarEnvironment(base, extra);
  if (packaged && env["FABDESK_USAGE_REMOTE_BACKUP"] === undefined)
    env["FABDESK_USAGE_REMOTE_BACKUP"] = "1";
  return env;
}
