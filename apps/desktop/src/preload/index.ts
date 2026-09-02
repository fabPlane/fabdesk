// Exposes `window.__SENTRY_IPC__` so renderer Sentry events reach the main process (docs/sentry.md).
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer } from "electron";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

const api = {
  platform: process.platform,
  /** Main passes `--fabdesk-error-reporting` when its Sentry client is active. */
  errorReporting: process.argv.includes("--fabdesk-error-reporting"),
  /** `FABDESK_SENTRY_TEST=1` in main: the renderer sends one handled test event on startup. */
  sentryTest: process.argv.includes("--fabdesk-sentry-test"),
  setErrorReporting: (enabled: boolean) =>
    ipcRenderer.invoke("fabdesk:set-error-reporting", enabled),
  setSentryUser: (user: { id: string; username?: string } | null) =>
    ipcRenderer.invoke("fabdesk:set-sentry-user", user),
  coreInfo: () => ipcRenderer.invoke("fabdesk:core-info"),
  restartCore: () => ipcRenderer.invoke("fabdesk:core-restart"),
  onCoreStatus: (cb: (info: unknown) => void) => {
    const listener = (_e: unknown, info: unknown) => cb(info);
    ipcRenderer.on("fabdesk:core-status", listener);
    return () => ipcRenderer.removeListener("fabdesk:core-status", listener);
  },
  openExternal: (url: string) => ipcRenderer.invoke("fabdesk:open-external", url),
  openLogs: () => ipcRenderer.invoke("fabdesk:open-logs"),
  pickFile: (opts?: PickFileOptions) => ipcRenderer.invoke("fabdesk:pick-file", opts ?? {}),
  localAuthAllowed: () => ipcRenderer.invoke("fabdesk:local-auth-allowed"),
  setLocalAuth: (enabled: boolean) => ipcRenderer.invoke("fabdesk:set-local-auth", enabled),
  updateStatus: () => ipcRenderer.invoke("fabdesk:update-status"),
  checkForUpdates: () => ipcRenderer.invoke("fabdesk:check-updates"),
  onUpdateStatus: (cb: (result: unknown) => void) => {
    const listener = (_e: unknown, result: unknown) => cb(result);
    ipcRenderer.on("fabdesk:update-status", listener);
    return () => ipcRenderer.removeListener("fabdesk:update-status", listener);
  },
  updateDownloadState: () => ipcRenderer.invoke("fabdesk:update-download-state"),
  downloadUpdate: () => ipcRenderer.invoke("fabdesk:download-update"),
  cancelUpdateDownload: () => ipcRenderer.invoke("fabdesk:cancel-update-download"),
  openUpdate: () => ipcRenderer.invoke("fabdesk:open-update"),
  onUpdateDownload: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on("fabdesk:update-download", listener);
    return () => ipcRenderer.removeListener("fabdesk:update-download", listener);
  },
};

export type FabdeskBridge = typeof api;

contextBridge.exposeInMainWorld("fabdesk", api);
