/**
 * Periodic update check against the website's `desktop/latest.json`.
 * Pure notification: the user downloads the installer themselves.
 */
import { checkForUpdate, DEFAULT_CHECK_INTERVAL_MS, DEFAULT_UPDATE_URL } from "@fabdesk/updates";
import type { UpdateCheckResult } from "@fabdesk/protocol";
import { app, BrowserWindow, ipcMain } from "electron";
import { assetForInstallMode, type AlternateInstallMode } from "./update-feed";

export class UpdateChecker {
  #last: UpdateCheckResult | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<UpdateCheckResult> | null = null;

  constructor(private readonly opts: { url?: string | undefined; intervalMs?: number | undefined; enabled?: boolean | undefined; installMode?: AlternateInstallMode | null } = {}) {}

  start(): void {
    if (this.opts.enabled === false) return;
    // Give the window a moment to appear before hitting the network.
    setTimeout(() => void this.check(), 4_000);
    this.#timer = setInterval(() => void this.check(), this.opts.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  last(): UpdateCheckResult | null {
    return this.#last;
  }

  check(): Promise<UpdateCheckResult> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = checkForUpdate({
      currentVersion: app.getVersion(),
      url: this.opts.url ?? DEFAULT_UPDATE_URL,
    })
      .then((checked) => {
        const mode = this.opts.installMode ?? null;
        const result: UpdateCheckResult = { ...checked,
          asset: assetForInstallMode(checked, mode, process.platform, process.arch, process.env["APPIMAGE"]),
          ...(mode ? { installMode: mode } : {}),
        };
        this.#last = result;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send("fabdesk:update-status", result);
        }
        return result;
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }
}

export function registerUpdateIpc(checker: UpdateChecker): void {
  ipcMain.handle("fabdesk:update-status", () => checker.last());
  ipcMain.handle("fabdesk:check-updates", () => checker.check());
}
