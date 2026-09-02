import { contextBridge, ipcRenderer } from "electron";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

const api = {
  platform: process.platform,
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
};

export type FabdeskBridge = typeof api;

contextBridge.exposeInMainWorld("fabdesk", api);
