// Exposes `window.__SENTRY_IPC__` so renderer Sentry events reach the main process (docs/sentry.md).
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer } from "electron";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

const api = {
  platform: process.platform,
  cadRuntimeState: () => ipcRenderer.invoke("fabdesk:cad-runtime-state"),
  reconnectCadRuntime: () => ipcRenderer.invoke("fabdesk:reconnect-cad-runtime"),
  prepareCadRuntime: () => ipcRenderer.invoke("fabdesk:prepare-cad-runtime"),
  downloadCadRuntime: () => ipcRenderer.invoke("fabdesk:download-cad-runtime"),
  deferCadRuntime: () => ipcRenderer.invoke("fabdesk:defer-cad-runtime"),
  cancelCadRuntime: () => ipcRenderer.invoke("fabdesk:cancel-cad-runtime"),
  /** Main passes `--fabdesk-error-reporting` when its Sentry client is active. */
  errorReporting: process.argv.includes("--fabdesk-error-reporting"),
  /** `FABDESK_SENTRY_TEST=1` in main: the renderer sends one handled test event on startup. */
  sentryTest: process.argv.includes("--fabdesk-sentry-test"),
  /** Main passes `--fabdesk-automation` when the app automation bridge is on (dev / FABDESK_AUTOMATION=1). */
  automationEnabled: process.argv.includes("--fabdesk-automation"),
  /** Main passes `--fabdesk-dev-build` for the isolated fabPlane Dev profile. */
  devBuild: process.argv.includes("--fabdesk-dev-build"),
  setTheme: (themeId: string | null) => ipcRenderer.invoke("fabdesk:set-theme", themeId),
  setErrorReporting: (enabled: boolean) =>
    ipcRenderer.invoke("fabdesk:set-error-reporting", enabled),
  setSentryUser: (user: { id: string; username?: string } | null) =>
    ipcRenderer.invoke("fabdesk:set-sentry-user", user),
  coreInfo: () => ipcRenderer.invoke("fabdesk:core-info"),
  /** Pop the File / Edit / View / Window menu at window coordinates (Windows/Linux top-bar menu button). */
  showAppMenu: (pos: { x: number; y: number }) => ipcRenderer.invoke("fabdesk:show-app-menu", pos),
  onMenu: (cb: (command: string) => void) => {
    const listener = (_e: unknown, command: unknown) => {
      if (typeof command === "string") cb(command);
    };
    ipcRenderer.on("fabdesk:menu", listener);
    return () => ipcRenderer.removeListener("fabdesk:menu", listener);
  },
  restartCore: () => ipcRenderer.invoke("fabdesk:core-restart"),
  onCoreStatus: (cb: (info: unknown) => void) => {
    const listener = (_e: unknown, info: unknown) => cb(info);
    ipcRenderer.on("fabdesk:core-status", listener);
    return () => ipcRenderer.removeListener("fabdesk:core-status", listener);
  },
  openExternal: (url: string) => ipcRenderer.invoke("fabdesk:open-external", url),
  openPath: (path: string) => ipcRenderer.invoke("fabdesk:open-path", path),
  openLogs: () => ipcRenderer.invoke("fabdesk:open-logs"),
  pickDirectory: () => ipcRenderer.invoke("fabdesk:pick-directory"),
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
  pendingOpenCatalog: () => ipcRenderer.invoke("fabdesk:pending-open-catalog") as Promise<string | null>,
  onOpenCatalog: (cb: (catalogId: string) => void) => {
    const listener = (_e: unknown, catalogId: unknown) => {
      if (typeof catalogId === "string") cb(catalogId);
    };
    ipcRenderer.on("fabdesk:open-catalog", listener);
    return () => ipcRenderer.removeListener("fabdesk:open-catalog", listener);
  },
};

export type FabdeskBridge = typeof api;

contextBridge.exposeInMainWorld("fabdesk", api);
