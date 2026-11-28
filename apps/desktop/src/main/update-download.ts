/**
 * In-app installer download for the update badge: streams the manifest asset into the user's
 * Downloads folder, verifies its SHA-256 against the manifest, and opens it on request.
 * Debian packages are verified in a private staging directory and applied through apt.
 */
import type { ReleaseAsset, UpdateDownloadState } from "@fabdesk/protocol";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import type { UpdateChecker } from "./updates";
import { installDebianUpdate } from "./update-deb";

export class UpdateDownloader {
  #state: UpdateDownloadState = { state: "idle" };
  #abort: AbortController | null = null;
  #pending: Promise<UpdateDownloadState> | null = null;

  constructor(private readonly checker: UpdateChecker, private readonly systemPackage = false,
    private readonly checkCore?: () => Promise<void>, private readonly restartApplied?: () => Promise<void>) {}

  state(): UpdateDownloadState {
    return this.#state;
  }

  #set(next: UpdateDownloadState): void {
    this.#state = next;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("fabdesk:update-download", next);
    }
  }

  cancel(): void {
    this.#abort?.abort();
  }

  async waitForInstall(): Promise<void> {
    if (this.#state.state === "installing") await this.#pending;
  }

  /** Starts (or returns the current) download of the installer picked by the last update check. */
  download(): Promise<UpdateDownloadState> {
    return this.#pending ??= this.#download().catch(error => {
      this.#set({ state: "error", message: error instanceof Error ? error.message : String(error) });
      return this.#state;
    }).finally(() => { this.#pending = null; });
  }

  async #download(): Promise<UpdateDownloadState> {
    const result = this.checker.last() ?? (await this.checker.check());
    const asset = result.asset;
    const version = result.latest?.version;
    if (!result.updateAvailable || !asset || !version) {
      this.#set({ state: "error", message: "No update available for this platform." });
      return this.#state;
    }
    if (this.systemPackage && asset.kind !== "deb") throw new Error("No matching Debian package is available for this installation.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9+._-]*$/.test(asset.filename)) throw new Error("The update filename is invalid.");
    const dir = this.systemPackage ? join(app.getPath("userData"), "updates", "debian") : app.getPath("downloads");
    const finalPath = join(dir, asset.filename);
    const partPath = `${finalPath}.part`;
    const abort = new AbortController();
    this.#abort = abort;
    this.#set({ state: "downloading", version, filename: asset.filename, received: 0, total: asset.size, percent: 0, bytesPerSecond: null });
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await rm(partPath, { force: true });
      if (!await fileMatches(finalPath, asset)) {
        const sha256 = await streamToFile(asset, partPath, abort.signal, (received, bps) => {
          this.#set({
            state: "downloading", version, filename: asset.filename, received, total: asset.size,
            percent: asset.size ? Math.min(1, received / asset.size) : null, bytesPerSecond: bps,
          });
        });
        this.#set({ state: "verifying", version, filename: asset.filename });
        if (sha256 !== asset.sha256) throw new Error("The downloaded update failed checksum verification. Retry the download.");
        await rename(partPath, finalPath);
      }
      abort.signal.throwIfAborted();
      if (this.systemPackage) {
        await this.checkCore?.();
        abort.signal.throwIfAborted();
        this.#abort = null;
        this.#set({ state: "installing", version });
        await installDebianUpdate(finalPath, app.getPath("exe"), version, process.arch);
        await rm(finalPath, { force: true }).catch(() => {});
      }
      this.#set({ state: "done", version, filename: asset.filename, path: finalPath, sha256: asset.sha256, ...(this.systemPackage ? { restart: true } : {}) });
    } catch (error) {
      await rm(partPath, { force: true });
      const aborted = abort.signal.aborted;
      this.#set(aborted ? { state: "idle" } : { state: "error", version, message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.#abort = null;
    }
    return this.#state;
  }

  /** Opens the downloaded installer with the OS (mounts the DMG, launches the .exe, etc.). */
  async open(): Promise<string> {
    if (this.#state.state !== "done") return "Nothing downloaded yet.";
    if (this.systemPackage) {
      if (!this.restartApplied) return "Quit and reopen fabPlane to use the updated package.";
      await this.restartApplied();
      return "";
    }
    const error = await shell.openPath(this.#state.path);
    if (error) shell.showItemInFolder(this.#state.path);
    return error;
  }
}

async function fileMatches(path: string, asset: ReleaseAsset): Promise<boolean> {
  try {
    const info = await stat(path);
    if (info.size !== asset.size) return false;
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", resolve).on("error", reject);
    });
    return hash.digest("hex") === asset.sha256;
  } catch {
    return false;
  }
}

async function streamToFile(
  asset: ReleaseAsset,
  path: string,
  signal: AbortSignal,
  onProgress: (received: number, bytesPerSecond: number | null) => void,
): Promise<string> {
  const response = await net.fetch(asset.url, { signal, headers: { accept: "application/octet-stream" } });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let received = 0;
  let lastEmit = 0;
  const started = Date.now();
  async function* chunks() {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (received > asset.size) throw new Error("The update exceeds its expected size.");
      yield value;
      const now = Date.now();
      if (now - lastEmit > 150) {
        lastEmit = now;
        const elapsed = (now - started) / 1000;
        onProgress(received, elapsed > 0.5 ? received / elapsed : null);
      }
    }
  }
  try {
    await pipeline(chunks(), createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (received !== asset.size) throw new Error("The update download is incomplete.");
  onProgress(received, null);
  return hash.digest("hex");
}

/** What the update badge drives: this downloader, or UpdateInstaller where the app replaces itself. */
export interface UpdateTransport {
  state(): UpdateDownloadState;
  download(): Promise<UpdateDownloadState>;
  cancel(): void;
  open(): Promise<string>;
  waitForInstall?(): Promise<void>;
}

export function registerUpdateDownloadIpc(downloader: UpdateTransport): void {
  ipcMain.handle("fabdesk:update-download-state", () => downloader.state());
  ipcMain.handle("fabdesk:download-update", () => downloader.download());
  ipcMain.handle("fabdesk:cancel-update-download", () => downloader.cancel());
  ipcMain.handle("fabdesk:open-update", () => downloader.open());
}
