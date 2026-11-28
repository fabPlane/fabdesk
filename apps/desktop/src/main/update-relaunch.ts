import { posix } from "node:path";

const displayFlags = new Set([
  "--disable-dev-shm-usage", "--disable-gpu", "--disable-gpu-compositing",
  "--disable-software-rasterizer", "--force-renderer-accessibility",
]);

/** Relaunch the current profile without replaying a file, protocol URL or other one-shot action. */
export function updateRelaunchArgs(userData: string, argv: readonly string[] = process.argv): string[] {
  const args = ["--user-data-dir=" + userData];
  for (const arg of argv) {
    if (arg === "--") break;
    if (displayFlags.has(arg) || /^--ozone-platform=(auto|wayland|x11)$/.test(arg)) args.push(arg);
  }
  return args;
}

// Electron's relauncher waits for the original process to exit and inherits its environment.
// ShipIt then installs the staged bundle. Wait for its target version and signature before
// starting the executable, including when ShipIt must copy the bundle across volumes.
const waitForMacBundle = `
exe=$1
bundle=$2
version=$3
shift 3
attempts=0
while [ "$attempts" -lt 300 ]; do
  installed=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$bundle/Contents/Info.plist" 2>/dev/null)
  if [ "$installed" = "$version" ] && [ -x "$exe" ] && /usr/bin/codesign --verify "$bundle" 2>/dev/null; then
    exec "$exe" "$@"
  fi
  /bin/sleep 1
  attempts=$((attempts + 1))
done
exit 1`;

export function macUpdateRelaunch(exe: string, version: string, args: string[]) {
  const bundle = posix.dirname(posix.dirname(posix.dirname(exe)));
  return { execPath: "/bin/sh", args: ["-c", waitForMacBundle, "fabdesk-update", exe, bundle, version, ...args] };
}
