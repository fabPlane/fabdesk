import type { UpdateDownloadState } from "@fabdesk/protocol";
import { accessSync, constants, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { UpdateDownloader, type UpdateTransport } from "./update-download";
import { alternateInstallMode, type AlternateInstallMode } from "./update-feed";
import { saveAcceptedUpdate } from "./staged-update";
import type { UpdateChecker } from "./updates";

function writable(path: string): boolean {
  try { accessSync(path, constants.W_OK); return true; } catch { return false; }
}

export function desktopInstallMode(): AlternateInstallMode | null {
  const exePath = app.getPath("exe");
  let volumeWritable = false, packageType: string | undefined;
  if (process.platform === "darwin" && exePath.startsWith("/Volumes/")) {
    volumeWritable = writable(dirname(dirname(dirname(exePath))));
  }
  if (process.platform === "linux" && !process.env["APPIMAGE"]) {
    try { packageType = readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim(); } catch { /* unpacked build */ }
  }
  return alternateInstallMode({ platform: process.platform, packaged: app.isPackaged, exePath,
    volumeWritable, packageType, appImage: process.env["APPIMAGE"], disabled: process.env["FABDESK_UPDATE_INPLACE"] === "0" });
}

/** Electron's relocation helper hands focus to an existing running installation and relaunches
 * from Applications after a move. Keep consent for the exact ZIP across that process boundary. */
export function createAlternateUpdateTransport(mode: AlternateInstallMode | null, checker: UpdateChecker,
  checkCore?: () => Promise<void>, restartApplied?: () => Promise<void>): UpdateTransport | null {
  if (!mode) return null;
  if (mode !== "move-to-applications") return new UpdateDownloader(checker, mode === "system-package", checkCore, restartApplied);
  let state: UpdateDownloadState = { state: "idle" };
  let moving = false;
  return {
    state: () => state,
    cancel() {},
    open: async () => "",
    async download() {
      if (moving) return state;
      moving = true;
      const record = join(app.getPath("userData"), "update-install.json");
      let accepted = false;
      try {
        const result = checker.last() ?? await checker.check();
        const asset = result.asset;
        if (!result.updateAvailable || !result.latest || asset?.kind !== "zip") throw new Error("No compatible Mac update is available.");
        await checkCore?.();
        saveAcceptedUpdate(record, { version: result.latest.version, sha256: asset.sha256 });
        accepted = true;
        const exe = app.getPath("exe");
        const installed = join("/Applications", basename(dirname(dirname(dirname(exe)))));
        if (existsSync(installed) && (!writable(installed) || !writable("/Applications"))) {
          // Electron's privileged move bypasses conflictHandler. Use the protected installed
          // copy so a currently running application is never overwritten.
          const id = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", join(installed, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
          if (id !== "com.tensorfleet.fabdesk") throw new Error("A different application occupies the fabPlane installation path.");
          app.once("will-quit", () => app.relaunch({ execPath: join(installed, "Contents", "MacOS", basename(exe)) }));
          app.quit();
          return state;
        }
        const moved = app.moveToApplicationsFolder({
          // Electron focuses a running copy. Replacing a closed installation needs explicit consent.
          conflictHandler: conflict => conflict === "existsAndRunning" || dialog.showMessageBoxSync({
            type: "question", message: "Replace the copy of fabPlane in Applications?",
            detail: "Your projects and settings are stored separately.", buttons: ["Cancel", "Replace and open"],
            defaultId: 0, cancelId: 0,
          }) === 1,
        });
        if (!moved) throw new Error("Move to Applications was canceled. You can continue using this copy.");
        return state;
      } catch (error) {
        if (accepted) rmSync(record, { force: true });
        state = { state: "error", message: error instanceof Error ? error.message : String(error) };
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send("fabdesk:update-download", state);
        }
        return state;
      } finally { moving = false; }
    },
  };
}
