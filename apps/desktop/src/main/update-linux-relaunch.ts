import { spawn } from "node:child_process";

/** The new AppImage initializes its own mount and loader paths. Preserve the
 * caller's desktop session, account settings and any paths outside the old image. */
export function linuxUpdateEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const mount = env["APPDIR"];
  if (!mount?.startsWith("/") || !env["APPIMAGE"]) return env;
  const child = { ...env };
  for (const key of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete child[key];
  for (const key of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS"]) {
    const paths = env[key];
    if (paths === undefined) continue;
    const remaining = paths.split(":").filter(path => path !== mount && !path.startsWith(mount + "/"));
    if (remaining.length) child[key] = remaining.join(":");
    else delete child[key];
  }
  return child;
}

const waitForExit = `
parent=$1
shift
attempts=0
while [ -e "/proc/$parent/exe" ]; do
  [ "$attempts" -lt 300 ] || exit 1
  /bin/sleep 0.2
  attempts=$((attempts + 1))
done
exec "$@"`;

/** Electron's Linux relauncher marks its children no_new_privs. A fresh
 * AppImage needs the user's ordinary fusermount, and Debian updates use polkit. */
export function restartLinuxAfterUpdate(exe: string, args: string[], parent = process.pid): void {
  const child = spawn("/bin/sh", ["-c", waitForExit, "fabdesk-update", String(parent), exe, ...args], {
    cwd: "/", detached: true, stdio: "ignore", env: linuxUpdateEnvironment(process.env),
  });
  child.on("error", error => console.error("[update] Could not restart FabDesk:", error));
  child.unref();
}
