import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { isThemeId, themeBackground, themeIsDark } from "../../../../packages/ui/src/theme/resolve";
import { resolveWindowTheme, writeCachedThemeId } from "./window-theme";
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
  // No build check here: the sign-in screen's Cmd+L / Ctrl+L reveal may turn local mode on in a
  // packaged build, and `setLocalAuth` writes the `.fabdesk-dev` marker the core requires.
  ipcMain.handle("fabdesk:set-local-auth", async (_e, enabled: unknown) => {
    const on = enabled === true;
    setLocalAuth(on);
    supervisor.setLocalAuth(on);
    await supervisor.restart();
  });
  ipcMain.handle("fabdesk:set-theme", (_e, raw: unknown) => {
    const userData = app.getPath("userData");
    if (raw === null) {
      writeCachedThemeId(userData, null);
      nativeTheme.themeSource = "system";
      const theme = resolveWindowTheme(userData, nativeTheme.shouldUseDarkColors);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setBackgroundColor(theme.backgroundColor);
      }
      return;
    }
    if (!isThemeId(raw)) return;
    writeCachedThemeId(userData, raw);
    nativeTheme.themeSource = themeIsDark(raw) ? "dark" : "light";
    const backgroundColor = themeBackground(raw);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(backgroundColor);
    }
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
