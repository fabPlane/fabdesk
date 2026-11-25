/**
 * In-place update for the update badge: electron-updater downloads the package, verifies it
 * against the manifest's SHA-256, replaces the app and relaunches it. The user never sees an
 * installer window. Squirrel.Mac on macOS, the NSIS installer run silently on Windows, a file
 * swap for the AppImage.
 *
 * The feed is still the website's `desktop/latest.json` (through UpdateChecker): a custom
 * provider hands electron-updater that manifest, so there is no `latest-mac.yml` to host.
 * `app-update.yml` (written by electron-builder's `publish` entry) only names the cache folder
 * and, on Windows, the publisher whose signature the installer must carry.
 *
 * After repeated failures the badge falls back to UpdateDownloader (download, then open the file).
 */
import type { UpdateDownloadState } from "@fabdesk/protocol";
import { app, autoUpdater as nativeUpdater, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import * as electronUpdater from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import type { UpdateDownloader } from "./update-download";
import { inPlaceAsset, notAppliedVersion, toUpdateInfo } from "./update-feed";
import type { UpdateChecker } from "./updates";

/** After this many failed attempts the session uses the installer file instead. */
const FAILURES_BEFORE_FALLBACK = 2;
/** quitAndInstall that has not ended the process by now did not start the install. */
const INSTALL_QUIT_TIMEOUT_MS = 20_000;

export interface UpdateInstallerOptions {
  /** Stops the core and the bridges, and marks the app as quitting, before the app is replaced. */
  prepareQuit: () => Promise<void>;
  fallback: UpdateDownloader;
  /**
   * File that records the version an install was started for. Windows and the AppImage report a
   * failed install only as an event, after the core is already stopped, and the relaunch that
   * follows loses this object's failure count; the record is how the next launch knows.
   */
  installRecordPath: string;
}


export class UpdateInstaller {
  #state: UpdateDownloadState = { state: "idle" };
  #token: electronUpdater.CancellationToken | null = null;
  #configured = false;
  #failures = 0;
  #squirrelReady = false;
  /** What the running download is fetching, for the progress events. */
  #current: { version: string; filename: string } | null = null;

  constructor(
    private readonly checker: UpdateChecker,
    private readonly opts: UpdateInstallerOptions,
  ) {}

  get #fallback(): boolean {
    return this.#failures >= FAILURES_BEFORE_FALLBACK;
  }

  state(): UpdateDownloadState {
    return this.#fallback ? this.opts.fallback.state() : this.#state;
  }

  #set(next: UpdateDownloadState): void {
    this.#state = next;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("fabdesk:update-download", next);
    }
  }

  #fail(version: string | undefined, error: unknown): string {
    this.#failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[update] in-place update failed: ${message}`);
    this.#set({ state: "error", ...(version ? { version } : {}), message });
    return message;
  }

  cancel(): void {
    if (this.#fallback) this.opts.fallback.cancel();
    else this.#token?.cancel();
  }

  #updater(): electronUpdater.AppUpdater {
    const updater = electronUpdater.autoUpdater;
    if (this.#configured) return updater;
    this.#configured = true;
    const checker = this.checker;
    class FeedProvider extends electronUpdater.Provider<electronUpdater.UpdateInfo> {
      constructor(_options: unknown, _updater: unknown, runtimeOptions: ProviderRuntimeOptions) {
        super(runtimeOptions);
      }
      async getLatestVersion(): Promise<electronUpdater.UpdateInfo> {
        const result = checker.last() ?? (await checker.check());
        const current = result.latest ? inPlaceAsset(result.latest.assets, process.platform, process.arch) : null;
        const info = current ? toUpdateInfo(result, current) : null;
        if (!info) throw new Error(result.error ?? "The release has no package this app can update from.");
        // The manifest carries SHA-256 (`sha2`), which electron-updater verifies when `sha512` is absent.
        return info as unknown as electronUpdater.UpdateInfo;
      }
      resolveFiles(info: electronUpdater.UpdateInfo) {
        return info.files.map((file) => ({ url: new URL(file.url), info: file }));
      }
    }
    updater.autoDownload = false;
    // Install only when the user asks: quitting normally must not start an installer.
    updater.autoInstallOnAppQuit = false;
    // No blockmaps are published, so a differential download would only fail first.
    updater.disableDifferentialDownload = true;
    updater.setFeedURL({ provider: "custom", updateProvider: FeedProvider });
    // An unhandled "error" event would throw; failures are reported through the awaited calls.
    updater.on("error", (error) => console.error(`[update] ${String(error)}`));
    updater.on("download-progress", (progress) => {
      if (this.#state.state !== "downloading" || !this.#current) return;
      this.#set({
        state: "downloading",
        ...this.#current,
        received: Math.max(0, Math.round(progress.transferred)),
        total: Math.max(0, Math.round(progress.total)),
        percent: progress.total > 0 ? Math.min(1, progress.transferred / progress.total) : null,
        bytesPerSecond: progress.bytesPerSecond > 0 ? progress.bytesPerSecond : null,
      });
    });
    nativeUpdater.on("update-downloaded", () => {
      this.#squirrelReady = true;
    });
    return updater;
  }

  /** Downloads the update package picked from the last check, ready to install on restart. */
  async download(): Promise<UpdateDownloadState> {
    if (this.#fallback) return this.opts.fallback.download();
    const busy = this.#state.state;
    if (busy === "downloading" || busy === "verifying" || busy === "installing") return this.#state;
    const result = this.checker.last() ?? (await this.checker.check());
    const version = result.latest?.version;
    const asset = result.latest ? inPlaceAsset(result.latest.assets, process.platform, process.arch) : null;
    if (!result.updateAvailable || !version) {
      this.#set({ state: "error", message: "No update available for this platform." });
      return this.#state;
    }
    // No package to apply in place, or the last in-place install of this version did not take:
    // the installer file still works.
    if (!asset || notAppliedVersion(this.opts.installRecordPath, app.getVersion()) === version) {
      this.#failures = FAILURES_BEFORE_FALLBACK;
      return this.opts.fallback.download();
    }
    if (this.#state.state === "done" && this.#state.version === version) return this.#state;
    const token = new electronUpdater.CancellationToken();
    this.#token = token;
    this.#current = { version, filename: asset.filename };
    this.#set({ state: "downloading", version, filename: asset.filename, received: 0, total: asset.size, percent: 0, bytesPerSecond: null });
    try {
      const updater = this.#updater();
      const check = await updater.checkForUpdates();
      if (!check?.isUpdateAvailable) throw new Error(`fabPlane ${version} cannot be installed over this version.`);
      this.#squirrelReady = false;
      const files = await updater.downloadUpdate(token);
      this.#set({ state: "done", version, filename: asset.filename, path: files[0] ?? "", sha256: asset.sha256, restart: true });
    } catch (error) {
      if (token.cancelled) this.#set({ state: "idle" });
      else this.#fail(version, error);
    } finally {
      this.#token = null;
    }
    return this.#state;
  }

  /** Replaces the app with the downloaded update and relaunches it. */
  async open(): Promise<string> {
    if (this.#fallback) return this.opts.fallback.open();
    if (this.#state.state !== "done") return "Nothing downloaded yet.";
    const version = this.#state.version;
    this.#set({ state: "installing", version });
    try {
      // Let Squirrel.Mac unpack and check the update while the app is still whole, so a bad
      // package is an error in the badge and not an app with its core already stopped.
      if (process.platform === "darwin") await this.#stageWithSquirrel();
    } catch (error) {
      return this.#fail(version, error);
    }
    await this.opts.prepareQuit().catch(() => {});
    // The core is stopped from here on: if the install does not take the process down, come back whole.
    const relaunch = (): void => {
      app.relaunch();
      app.exit(0);
    };
    try {
      // Read on the next launch: still on the old version means the install did not apply.
      writeFileSync(this.opts.installRecordPath, JSON.stringify({ version }));
    } catch (error) {
      console.error(`[update] could not write the install record: ${String(error)}`);
    }
    try {
      setTimeout(relaunch, INSTALL_QUIT_TIMEOUT_MS).unref();
      // Windows and the AppImage do not throw from quitAndInstall: a failed install is an event.
      electronUpdater.autoUpdater.once("error", relaunch);
      electronUpdater.autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      console.error(`[update] quitAndInstall failed: ${String(error)}`);
      relaunch();
    }
    return "";
  }

  #stageWithSquirrel(): Promise<void> {
    if (this.#squirrelReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const ready = (): void => {
        nativeUpdater.removeListener("error", failed);
        resolve();
      };
      const failed = (error: Error): void => {
        nativeUpdater.removeListener("update-downloaded", ready);
        reject(error);
      };
      nativeUpdater.once("update-downloaded", ready);
      nativeUpdater.once("error", failed);
      // electron-updater pointed Squirrel at its loopback copy of the zip when the download finished.
      nativeUpdater.checkForUpdates();
    });
  }
}
