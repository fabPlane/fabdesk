import { existsSync } from "node:fs";
import { CAD_RELEASE } from "./cad-runtime";
/**
 * Application menu.
 *
 * macOS keeps the menu in the system bar. Windows and Linux hide Electron's in-window menu bar
 * (`autoHideMenuBar`) and open the same File / Edit / View / Window menu from the top bar's
 * menu button instead, so the app's own header is the only bar. Accelerators keep working
 * because the menu is still installed as the application menu.
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";

/** Send a menu command to the focused (or only) window's renderer. */
function send(command: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send("fabdesk:menu", command);
}

function template(): MenuItemConstructorOptions[] {
  const mac = process.platform === "darwin";
  return [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New chat", accelerator: "CmdOrCtrl+Shift+O", click: () => send("new-chat") },
        { label: "Command palette…", accelerator: "CmdOrCtrl+K", click: () => send("palette") },
        { label: "Laser Controller…", click: () => send("laser-controller") },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Toggle sidebar", accelerator: "CmdOrCtrl+B", click: () => send("sidebar") },
        {
          label: "Toggle board panel",
          accelerator: "CmdOrCtrl+Shift+B",
          click: () => send("board"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "fabPlane website", click: () => void shell.openExternal("https://fabplane.com") },
        ...(app.isPackaged
          ? [
              {
                label: "FreeCAD licenses and source",
                click: () => {
                  const path = join(
                    app.getPath("userData"),
                    "cad-runtimes",
                    CAD_RELEASE,
                    "CADRuntime.app",
                    "Contents",
                    "Resources",
                    "cad",
                    "freecad",
                  );
                  if (existsSync(path)) void shell.openPath(path);
                  else void shell.openExternal("https://github.com/fabPlane/FreeCAD");
                },
              },
            ]
          : []),
      ],
    },
  ];
}

/** Install as the application menu (system bar on macOS; hidden in-window bar elsewhere). */
export function installAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()));
}

/** Open the application menu as a popup at window coordinates (the top bar's menu button). */
export function popupAppMenu(win: BrowserWindow, pos: { x: number; y: number }): void {
  const menu = Menu.buildFromTemplate(template().filter((item) => item.role !== "appMenu"));
  menu.popup({ window: win, x: Math.round(pos.x), y: Math.round(pos.y) });
}

/** App name for menus that need it. */
export function appName(): string {
  return app.name;
}
