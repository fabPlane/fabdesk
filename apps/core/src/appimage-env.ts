/**
 * AppImage launcher identity belongs to Electron's AppDir. Core is never an AppImage; if these
 * variables arrive they must not reach kicad-cli. KiCad KIWAY treats any set APPDIR as
 * `$APPDIR/usr/bin` for kiface search instead of the bundled executable's directory.
 *
 * Keep `APPIMAGE_RUNTIME_ENV` / `kifaceSearchDir` in sync with
 * `apps/desktop/src/main/child-process-env.ts` (no shared package).
 */
import { dirname, join } from "node:path";

export const APPIMAGE_RUNTIME_ENV = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] as const;

export function withoutAppImageRuntime(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV) delete result[key];
  return result;
}

export function scrubAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of APPIMAGE_RUNTIME_ENV) delete env[key];
  return env;
}

export function kifaceSearchDir(kicadCli: string, env: NodeJS.ProcessEnv): string {
  if (env.APPDIR !== undefined) return join(env.APPDIR, "usr", "bin");
  return dirname(kicadCli);
}
