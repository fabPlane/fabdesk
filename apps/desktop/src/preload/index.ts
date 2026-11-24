// Exposes `window.__SENTRY_IPC__` so renderer Sentry events reach the main process (docs/sentry.md).
import "@sentry/electron/preload";
import { contextBridge, ipcRenderer, webFrame } from "electron";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

const api = {
  platform: process.platform,
  copyText: (text: string): Promise<void> => ipcRenderer.invoke("fabdesk:copy-text", text),
  openInComMarkerStudio: (filename: string, file: Uint8Array) =>
    ipcRenderer.invoke("fabdesk:open-in-commarker-studio", filename, file),
  nativeSpeech: {
    status: (language: string) => ipcRenderer.invoke("fabdesk:speech-status", language),
    prepare: (language: string, id: string) => ipcRenderer.invoke("fabdesk:speech-prepare", language, id),
    transcribe: (request: { id: string; audio: ArrayBuffer; language: string }) => ipcRenderer.invoke("fabdesk:speech-transcribe", request),
    cancel: (id: string) => ipcRenderer.invoke("fabdesk:speech-cancel", id),
  },
  /** Read-only zoom value so Windows toolbar icons can match native caption sizing. */
  getZoomFactor: () => webFrame.getZoomFactor(),
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
  pendingOpenSharedProject: () => ipcRenderer.invoke("fabdesk:pending-open-shared-project") as Promise<import("@fabdesk/protocol").OpenSharedProjectIntent | null>,
  onOpenSharedProject: (cb: (intent: import("@fabdesk/protocol").OpenSharedProjectIntent) => void) => {
    const listener = (_e: unknown, intent: unknown) => {
      if (intent && typeof intent === "object" && "shareId" in intent && typeof intent.shareId === "string") cb({ shareId: intent.shareId });
      else if (intent && typeof intent === "object" && "projectId" in intent && typeof intent.projectId === "string") cb({projectId:intent.projectId});
    };
    ipcRenderer.on("fabdesk:open-shared-project", listener);
    return () => ipcRenderer.removeListener("fabdesk:open-shared-project", listener);
  },
  pendingOpenCatalog: () =>
    ipcRenderer.invoke("fabdesk:pending-open-catalog") as Promise<{ catalogId: string; remix: boolean } | null>,
  onOpenCatalog: (cb: (intent: { catalogId: string; remix: boolean }) => void) => {
    const listener = (_e: unknown, intent: unknown) => {
      if (!intent || typeof intent !== "object") return;
      const rec = intent as { catalogId?: unknown; remix?: unknown };
      if (typeof rec.catalogId === "string") cb({ catalogId: rec.catalogId, remix: rec.remix === true });
    };
    ipcRenderer.on("fabdesk:open-catalog", listener);
    return () => ipcRenderer.removeListener("fabdesk:open-catalog", listener);
  },
};

export type FabdeskBridge = typeof api;

contextBridge.exposeInMainWorld("fabdesk", api);
