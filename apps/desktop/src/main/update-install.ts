import { app, autoUpdater as squirrel, BrowserWindow } from "electron";
import * as electronUpdater from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import type { UpdateChecker } from "./updates";
import { inPlaceAsset, toUpdateInfo } from "./update-feed";
import { StagedUpdate, type StagedUpdateHost, type UpdateOffer } from "./staged-update";
import { installAppImage, stageAppImage } from "./update-appimage";
import { macUpdateRelaunch, updateRelaunchArgs } from "./update-relaunch";
import { restartLinuxAfterUpdate } from "./update-linux-relaunch";
import { prepareWindowsRestart, restartAfterWindowsUpdate, type PreparedWindowsRestart } from "./update-windows-launch";

/** Squirrel checks the signed bundle and prepares ShipIt to replace it when the app exits.
 * downloadUpdate alone only sets up the local ZIP server when autoInstallOnAppQuit is false. */
function stageMacBundle(): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      squirrel.removeListener("update-downloaded", ready);
      squirrel.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const failed = (error: Error) => finish(error);
    const timeout = setTimeout(() => finish(new Error("macOS could not finish preparing the update. Retry the update.")), 5 * 60_000);
    squirrel.once("update-downloaded", ready);
    squirrel.once("error", failed);
    try { squirrel.checkForUpdates(); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export function createUpdateInstaller(checker: UpdateChecker, recordPath: string, checkCore: () => Promise<void>): StagedUpdate {
  let updater: electronUpdater.AppUpdater | undefined;
  let selected: UpdateOffer;
  let stagedImage: Awaited<ReturnType<typeof stageAppImage>> | undefined;

  function engine(): electronUpdater.AppUpdater {
    if (updater) return updater;
    class ManifestProvider extends electronUpdater.Provider<electronUpdater.UpdateInfo> {
      constructor(_options: unknown, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) { super(runtimeOptions); }
      async getLatestVersion(): Promise<electronUpdater.UpdateInfo> {
        // Pin the release selected at click time, even if the periodic feed check changes.
        return selected.info as unknown as electronUpdater.UpdateInfo;
      }
      resolveFiles(info: electronUpdater.UpdateInfo) {
        return info.files.map(file => ({ url: new URL(file.url), info: file }));
      }
    }
    updater = electronUpdater.autoUpdater;
    updater.autoDownload = false;
    // FabDesk commits only after its normal quit guards and backend shutdown have completed.
    updater.autoInstallOnAppQuit = false;
    updater.disableDifferentialDownload = true;
    updater.setFeedURL({ provider: "custom", updateProvider: ManifestProvider });
    updater.on("error", error => console.error(`[update] ${String(error)}`));
    return updater;
  }

  let preparedRestart: PreparedWindowsRestart | undefined;
  const windowsLaunch = (version: string) => ({
    appPath: app.getAppPath(), userData: app.getPath("userData"), version, exe: process.execPath, cwd: process.cwd(),
  });
  const cancelPreparedRestart = () => { preparedRestart?.cancel(); preparedRestart = undefined; };
  const host: StagedUpdateHost = {
    recordPath, version: app.getVersion(),
    async offer() {
      await checkCore();
      const cached = checker.last();
      const result = cached?.latest ? cached : await checker.check();
      const version = result.latest?.version;
      const asset = result.latest && inPlaceAsset(result.latest.assets, process.platform, process.arch);
      const info = asset && toUpdateInfo(result, asset);
      if (!result.updateAvailable || !version || !asset || !info) {
        throw new Error(result.error || "No compatible update is available for this installation.");
      }
      return { version, asset, info };
    },
    async stage(offer, signal, progress, verifying) {
      selected = offer;
      const native = engine();
      const token = new electronUpdater.CancellationToken();
      const abort = () => token.cancel();
      const report = (p: { transferred: number; total: number; bytesPerSecond: number }) => {
        progress({ received: Math.max(0, Math.round(p.transferred)), total: Math.max(0, Math.round(p.total)),
          percent: p.total > 0 ? Math.min(1, p.transferred / p.total) : null, bytesPerSecond: p.bytesPerSecond > 0 ? p.bytesPerSecond : null });
      };
      native.on("download-progress", report);
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        const check = await native.checkForUpdates();
        signal.throwIfAborted();
        if (!check?.isUpdateAvailable || check.updateInfo.version !== offer.version) throw new Error("This release cannot be installed over the current version.");
        const [path] = await native.downloadUpdate(token);
        signal.throwIfAborted();
        verifying();
        if (process.platform === "darwin") {
          await stageMacBundle();
          return "";
        }
        if (!path) throw new Error("The verified update file could not be located.");
        if (process.platform === "linux") {
          stagedImage = await stageAppImage(process.env["APPIMAGE"] ?? "", path, offer.asset.sha256);
          return stagedImage.path;
        }
        return path;
      } finally {
        signal.removeEventListener("abort", abort);
        native.removeListener("download-progress", report);
      }
    },
    ...(process.platform === "win32" ? {
      async prepareRestart(version: string) {
        cancelPreparedRestart();
        preparedRestart = await prepareWindowsRestart(windowsLaunch(version));
      },
      cancelPreparedRestart,
    } : {}),
    quit: () => app.quit(),
    notify(state) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("fabdesk:update-download", state);
      }
    },
    install(job, restart) {
      if (process.platform === "darwin") {
        // ShipIt installs on exit. Its own relaunch delegates to Launch Services,
        // which drops the calling profile and environment. Let Electron own the single relaunch.
        if (restart) app.relaunch(macUpdateRelaunch(process.execPath, job.version, updateRelaunchArgs(app.getPath("userData"))));
      } else if (process.platform === "linux") {
        if (!stagedImage) throw new Error("The verified AppImage could not be located.");
        installAppImage(stagedImage);
        if (restart) restartLinuxAfterUpdate(stagedImage.destination, updateRelaunchArgs(app.getPath("userData")));
      } else {
        if (restart) {
          if (!preparedRestart?.commit()) restartAfterWindowsUpdate(windowsLaunch(job.version));
        } else preparedRestart?.cancel();
        // Explorer's --force-run opens the default profile. The staged install
        // still uses the native updater; only the explicit relaunch is ours.
        engine().quitAndInstall(true, false);
      }
    },
  };
  return new StagedUpdate(host);
}
