import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { compareVersions } from "@fabdesk/updates";
import { updateRelaunchArgs } from "./update-relaunch";

// electron-builder's NSIS APP_GUID is UUIDv5(com.tensorfleet.fabdesk, its NSIS namespace).
export const WINDOWS_INSTALL_MUTEX = "3cb6c505-6478-5a72-8cb4-30ea679d4758";

function hasUpdateReceipt(userData: string, version: string): boolean {
  try {
    const receipt = JSON.parse(readFileSync(join(userData, "update-install.json"), "utf8"));
    // The previous updater wrote just { version } when applying an update.
    return typeof receipt?.version === "string" && /^\d+\.\d+\.\d+$/.test(receipt.version)
      && (receipt.phase === undefined || receipt.phase === "accepted" || receipt.phase === "applying")
      && compareVersions(receipt.version, version) >= 0;
  } catch { return false; }
}

// .NET Framework uses the native command-line string on ProcessStartInfo.
// Escape according to CommandLineToArgvW; none of these arguments are shell code.
function windowsArgument(arg: string): string {
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&") + '"';
}


function extractHelper(appPath: string): string {
  const bytes = Buffer.from(readFileSync(join(appPath, "update-windows-launch.b64"), "ascii"), "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const directory = join(tmpdir(), "fabdesk-update-waiter", hash);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, "FabDeskUpdateWaiter.exe");
  function matches(): boolean {
    try { return bytes.equals(readFileSync(executable)); } catch { return false; }
  }
  if (matches()) return executable;
  const temporary = join(directory, randomUUID() + ".tmp");
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o700 });
    try { renameSync(temporary, executable); } catch (error) {
      // Another startup may already have installed and started the same helper.
      if (!matches()) throw error;
    }
  } finally { rmSync(temporary, { force: true }); }
  return executable;
}

interface WindowsLaunch {
  appPath: string;
  userData: string;
  version: string;
  exe: string;
  args: readonly string[];
  cwd: string;
}

/** NSIS normally relaunches via Explorer, which drops Electron's profile switch and
 * the environment inherited by its core. Keep that context in a separate GUI process
 * outside the installation directory while NSIS replaces the application. */
export function restartAfterWindowsUpdate(launch: Omit<WindowsLaunch, "args">, installer = WINDOWS_INSTALL_MUTEX, parent = process.pid): void {
  const helper = extractHelper(launch.appPath);
  const args = ["--updated", ...updateRelaunchArgs(launch.userData)];
  const child = spawn(helper, ["restart", installer, String(parent), launch.exe, launch.cwd, launch.version], {
    cwd: tmpdir(), detached: true, windowsHide: true, stdio: "ignore",
    env: { ...process.env, FABDESK_NSIS_START_ARGS: args.map(windowsArgument).join(" ") },
  });
  child.on("error", error => console.error("[update] Windows restart helper failed:", error));
  if (!child.pid) throw new Error("Could not start the Windows update restart helper.");
  child.unref();
}

/** Hand an actual mid-NSIS launch off to one hidden process, releasing the EXE, ASAR and Electron locks. */
export async function deferWindowsUpdateLaunch(launch: WindowsLaunch, installer = WINDOWS_INSTALL_MUTEX, parent = process.pid): Promise<boolean> {
  if (!hasUpdateReceipt(launch.userData, launch.version)) return false;
  // Identical shortcut clicks share one waiter. A distinct file or protocol
  // launch still reaches Electron's ordinary second-instance handler after NSIS.
  const scope = createHash("sha256").update(JSON.stringify([resolve(launch.exe).toLowerCase(),
    resolve(launch.userData).toLowerCase(), launch.args.length ? resolve(launch.cwd).toLowerCase() : "", launch.args])).digest("hex");
  let directory: string | undefined;
  try {
    const helper = extractHelper(launch.appPath);
    directory = mkdtempSync(join(tmpdir(), "fabdesk-update-launch-"));
    const decision = join(directory, "decision");
    const child = spawn(helper, [installer, "Local\\fabdesk-update-open-" + scope, String(parent), decision, launch.exe, launch.cwd], {
      cwd: tmpdir(), detached: true, windowsHide: true, stdio: "ignore",
      env: { ...process.env, FABDESK_NSIS_START_ARGS: launch.args.map(windowsArgument).join(" ") },
    });
    let failed = false;
    child.once("error", () => { failed = true; });
    child.unref();
    // A GUI helper has no console. Its atomic acknowledgement means the waiter
    // owns the relaunch before Electron exits. No waiting installer just exits.
    const deadline = Date.now() + 10_000;
    while (!failed) {
      try {
        if (readFileSync(decision, "utf8") === "defer") return true;
      } catch { /* The decision has not been written. */ }
      if (child.exitCode !== null || child.signalCode !== null) return false;
      if (Date.now() >= deadline) { child.kill(); return false; }
      await delay(25);
    }
  } catch (error) {
    console.warn("[update] Could not check Windows installation progress:", error);
  } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  return false;
}
