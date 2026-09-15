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
