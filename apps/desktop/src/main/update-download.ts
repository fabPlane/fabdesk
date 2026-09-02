/**
 * In-app installer download for the update badge: streams the manifest asset into the user's
 * Downloads folder, verifies its SHA-256 against the manifest, and opens it on request.
 * No auto-install: the OS installer / DMG / AppImage takes over from there.
 */
import type { ReleaseAsset, UpdateDownloadState } from "@fabdesk/protocol";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import type { UpdateChecker } from "./updates";

export class UpdateDownloader {
  #state: UpdateDownloadState = { state: "idle" };
  #abort: AbortController | null = null;

  constructor(private readonly checker: UpdateChecker) {}

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

  /** Starts (or returns the current) download of the installer picked by the last update check. */
  async download(): Promise<UpdateDownloadState> {
    if (this.#state.state === "downloading" || this.#state.state === "verifying") return this.#state;
    const result = this.checker.last() ?? (await this.checker.check());
    const asset = result.asset;
    const version = result.latest?.version;
    if (!result.updateAvailable || !asset || !version) {
      this.#set({ state: "error", message: "No update available for this platform." });
      return this.#state;
    }
    const dir = app.getPath("downloads");
    const finalPath = join(dir, asset.filename);
    const partPath = `${finalPath}.part`;
    // Reuse a previous good download.
    if (await fileMatches(finalPath, asset)) {
      this.#set({ state: "done", version, filename: asset.filename, path: finalPath, sha256: asset.sha256 });
      return this.#state;
    }
    const abort = new AbortController();
    this.#abort = abort;
    this.#set({ state: "downloading", version, filename: asset.filename, received: 0, total: asset.size, percent: 0, bytesPerSecond: null });
    try {
      await mkdir(dir, { recursive: true });
      await rm(partPath, { force: true });
      const sha256 = await streamToFile(asset, partPath, abort.signal, (received, bps) => {
        const total = asset.size || 0;
        this.#set({
          state: "downloading",
          version,
          filename: asset.filename,
          received,
          total,
          percent: total > 0 ? Math.min(1, received / total) : null,
          bytesPerSecond: bps,
        });
      });
      this.#set({ state: "verifying", version, filename: asset.filename });
      if (sha256 !== asset.sha256) {
        await rm(partPath, { force: true });
        throw new Error(`Checksum mismatch: expected ${asset.sha256.slice(0, 12)}…, got ${sha256.slice(0, 12)}…`);
      }
      await rename(partPath, finalPath);
      this.#set({ state: "done", version, filename: asset.filename, path: finalPath, sha256 });
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
    const { createReadStream } = await import("node:fs");
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
  const out = createWriteStream(path);
  const reader = response.body.getReader();
  let received = 0;
  let lastEmit = 0;
  const started = Date.now();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", resolve));
      const now = Date.now();
      if (now - lastEmit > 150) {
        lastEmit = now;
        const elapsed = (now - started) / 1000;
        onProgress(received, elapsed > 0.5 ? received / elapsed : null);
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  onProgress(received, null);
  return hash.digest("hex");
}

export function registerUpdateDownloadIpc(downloader: UpdateDownloader): void {
  ipcMain.handle("fabdesk:update-download-state", () => downloader.state());
  ipcMain.handle("fabdesk:download-update", () => downloader.download());
  ipcMain.handle("fabdesk:cancel-update-download", () => downloader.cancel());
  ipcMain.handle("fabdesk:open-update", () => downloader.open());
}
