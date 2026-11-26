import type { UpdateDownloadState } from "@fabdesk/protocol";
import { accessSync, constants, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { UpdateDownloader, type UpdateTransport } from "./update-download";
import { alternateInstallMode, type AlternateInstallMode } from "./update-feed";
import { saveAcceptedUpdate } from "./staged-update";
import type { UpdateChecker } from "./updates";

export function desktopInstallMode(): AlternateInstallMode | null {
  const exePath = app.getPath("exe");
  let volumeWritable = false, packageType: string | undefined;
  if (process.platform === "darwin" && exePath.startsWith("/Volumes/")) {
    try { accessSync(dirname(dirname(dirname(exePath))), constants.W_OK); volumeWritable = true; } catch { /* mounted read-only */ }
  }
  if (process.platform === "linux" && !process.env["APPIMAGE"]) {
    try { packageType = readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim(); } catch { /* unpacked build */ }
  }
  return alternateInstallMode({ platform: process.platform, packaged: app.isPackaged, exePath,
    volumeWritable, packageType, appImage: process.env["APPIMAGE"], disabled: process.env["FABDESK_UPDATE_INPLACE"] === "0" });
}

/** Electron's relocation helper hands focus to an existing running installation and relaunches
 * from Applications after a move. Keep consent for the exact ZIP across that process boundary. */
export function createAlternateUpdateTransport(mode: AlternateInstallMode | null, checker: UpdateChecker): UpdateTransport | null {
  if (!mode) return null;
  if (mode !== "move-to-applications") return new UpdateDownloader(checker, mode === "system-package");
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
        saveAcceptedUpdate(record, { version: result.latest.version, sha256: asset.sha256 });
        accepted = true;
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
