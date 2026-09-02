import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { CoreSupervisor } from "./core-supervisor";
import { localAuthAllowed, setLocalAuth } from "./local-mode";
import { setErrorReporting, setSentryUser } from "./sentry";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export function registerIpc(supervisor: CoreSupervisor): void {
  ipcMain.handle("fabdesk:core-info", () => supervisor.info());
  ipcMain.handle("fabdesk:core-restart", () => supervisor.restart());
  ipcMain.handle("fabdesk:local-auth-allowed", () => localAuthAllowed());
  ipcMain.handle("fabdesk:set-local-auth", async (_e, enabled: unknown) => {
    if (!localAuthAllowed()) throw new Error("local auth is not allowed in this build");
    const on = enabled === true;
    setLocalAuth(on);
    supervisor.setLocalAuth(on);
    await supervisor.restart();
  });
  ipcMain.handle("fabdesk:set-error-reporting", (_e, enabled: unknown) => setErrorReporting(enabled === true));
  ipcMain.handle("fabdesk:set-sentry-user", (_e, raw: unknown) => {
    const u = raw as { id?: unknown; username?: unknown } | null;
    if (!u || typeof u.id !== "string") return setSentryUser(null);
    setSentryUser({ id: u.id, ...(typeof u.username === "string" ? { username: u.username } : {}) });
  });
  ipcMain.handle("fabdesk:open-external", async (_e, url: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("only http(s) URLs may be opened");
    await shell.openExternal(url);
  });
  ipcMain.handle("fabdesk:open-logs", async () => {
    await shell.openPath(supervisor.logPath());
  });
  ipcMain.handle("fabdesk:pick-file", async (e, raw: unknown) => {
    const opts = (raw ?? {}) as PickFileOptions;
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      properties: ["openFile", ...(opts.multiple ? (["multiSelections"] as const) : [])],
      ...(opts.filters ? { filters: opts.filters } : {}),
    });
    return result.canceled ? [] : result.filePaths;
  });

  supervisor.on("status", (info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("fabdesk:core-status", info);
    }
  });
}
