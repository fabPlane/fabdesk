import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";

type Run = (command: string, args: string[]) => Promise<string>;
const exec = promisify(execFile);
const run: Run = async (command, args) => (await exec(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })).stdout;

/** Ask the distro to upgrade only the Debian package which currently owns this executable. */
export async function installDebianUpdate(file: string, exe: string, version: string, arch: string, execute: Run = run): Promise<void> {
  if (!isAbsolute(file) || !file.endsWith(".deb") || !isAbsolute(exe)) throw new Error("Invalid Debian update path.");
  const ownerLine = (await execute("/usr/bin/dpkg-query", ["--search", exe])).trim();
  const owner = /^([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9]+)?: (.+)$/.exec(ownerLine);
  if (!owner || owner[2] !== exe) throw new Error("The running application is not owned by one Debian package.");
  const fields = (await execute("/usr/bin/dpkg-deb", ["--show", "--showformat=${Package}\t${Version}\t${Architecture}", file])).trim().split("\t");
  const [name, target, cpu] = fields;
  const expectedArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (fields.length !== 3 || name !== owner[1] || !target || !(target === version || target.startsWith(version + "-")) || cpu !== expectedArch) {
    throw new Error("The downloaded package does not match the installed application, version, or architecture.");
  }
  const installed = async () => (await execute("/usr/bin/dpkg-query", ["--show", "--showformat=${db:Status-Status}\t${Version}\t${Architecture}", `${name}:${cpu}`])).trim().split("\t");
  const [status, current, currentArch] = await installed();
  if (status !== "installed" || !current || currentArch !== cpu) throw new Error("The package manager could not confirm the current installation.");
  if (current === target) return;
  await execute("/usr/bin/dpkg", ["--compare-versions", target, "gt", current]).catch(() => {
    throw new Error("The installed Debian package is already newer than this update.");
  });
  try {
    // Polkit presents its normal desktop authentication dialog. A terminal is never needed.
    await execute("/usr/bin/pkexec", ["--disable-internal-agent", "/usr/bin/apt-get", "--assume-yes", "--only-upgrade", "--no-remove", "install", file]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code as string | number | undefined;
    if (code === 126) throw new Error("Authorization was canceled. You can retry the update.");
    if (code === 127 || code === "ENOENT") throw new Error("The desktop package manager could not authorize this update. Check that a Polkit authentication agent is running.");
    throw error;
  }
  const [afterStatus, afterVersion, afterArch] = await installed();
  if (afterStatus !== "installed" || afterVersion !== target || afterArch !== cpu) throw new Error("The package manager did not apply the expected update.");
}
