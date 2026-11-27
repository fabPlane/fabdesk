/**
 * The Laser Controller window: the laser cell (ElRobot arm + ComMarker Omni X) in its own window, so it can
 * stay open beside ComMarker Studio while the main window is used for boards. Same renderer bundle as the
 * main window; `#laser` in the URL makes main.tsx render the controller instead of the full app.
 */
import { app, BrowserWindow, nativeTheme, shell } from "electron";

export type LaserWindowOptions = {
  preload: string;
  /** Built renderer index.html (packaged / preview builds). */
  html: string;
  icon?: string | undefined;
  /** Extra preload arguments, the same ones the main window gets (error reporting, dev build). */
  args: string[];
};

let laserWindow: BrowserWindow | null = null;

/** Closes the Laser Controller (with the main window: the app has no other way back to the main window). */
export function closeLaserWindow(): void {
  if (laserWindow && !laserWindow.isDestroyed()) laserWindow.close();
}

export function openLaserWindow(options: LaserWindowOptions): BrowserWindow {
  if (laserWindow && !laserWindow.isDestroyed()) {
    if (laserWindow.isMinimized()) laserWindow.restore();
    laserWindow.focus();
    return laserWindow;
  }
  const win = new BrowserWindow({
    width: 980,
    height: 860,
    minWidth: 640,
    minHeight: 560,
    title: "Laser Controller",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1f" : "#ffffff",
    ...(options.icon ? { icon: options.icon } : {}),
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: options.args,
    },
  });
  laserWindow = win;
  win.on("closed", () => {
    if (laserWindow === win) laserWindow = null;
  });
  win.on("page-title-updated", e => {
    e.preventDefault();
    win.setTitle("Laser Controller");
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|file):\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !url.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\0")) e.preventDefault();
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}#laser`);
  else void win.loadFile(options.html, { hash: "laser" });
  return win;
}
