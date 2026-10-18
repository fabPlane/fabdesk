/** AppImage launcher paths describe Electron's AppDir and must not leak into sidecars. */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * Keep in sync with `apps/core/src/appimage-env.ts` (no shared package: desktop must
 * not import core, and a new package is not worth the duplication).
 */
export const APPIMAGE_RUNTIME_ENV = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] as const;

/**
 * KiCad KIWAY (`common/kiway.cpp`): when APPDIR is set — even to an empty string — kiface
 * libraries are loaded from `$APPDIR/usr/bin`, not beside the kicad-cli we actually spawned.
 * That is why a leaked AppImage APPDIR looks for `_pcbnew.kiface` next to the Electron
 * launcher instead of `resources/pcb/kicad/bin`.
 */
export function kifaceSearchDir(kicadCli: string, env: NodeJS.ProcessEnv): string {
  if (env.APPDIR !== undefined) return join(env.APPDIR, "usr", "bin");
  return dirname(kicadCli);
}

export function sidecarEnvironment(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const key of APPIMAGE_RUNTIME_ENV) delete env[key];
  // Electron sets this when the main process is itself a Node spawn; the core sidecar
  // must not inherit it (restored from 58ec263).
  delete env.ELECTRON_RUN_AS_NODE;
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
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

/** Command is spawned as-is. AppImage identity is stripped on the env object only. */
export function sidecarCommand(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  return { command, args: [...args] };
}

export function spawnSidecar(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const resolved = sidecarCommand(command, args);
  return spawn(resolved.command, resolved.args, {
    ...options,
    env: sidecarEnvironment((options.env as NodeJS.ProcessEnv | undefined) ?? process.env),
  });
}
