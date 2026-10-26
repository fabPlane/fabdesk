import { app, ipcMain, dialog, BrowserWindow, nativeTheme, session, shell } from "electron";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CoreInfo } from "../shared/core-info";
import { CoreSupervisor } from "./core-supervisor";
import { applyDesktopIdentity } from "./dev-profile";
import { registerIpc } from "./ipc";
import { installAppMenu } from "./app-menu";
import { automationEnabled, startAppAutomation, type AppAutomation } from "./automation";
import { localAuthEnabled } from "./local-mode";
import {
  coreSentryEnv,
  flushSentry,
  initSentry,
  runSentryTest,
  sentryActive,
  sentryTestRequested,
  syncErrorReportingFromCore,
} from "./sentry";
import { registerUpdateIpc, UpdateChecker } from "./updates";
import { registerUpdateDownloadIpc, UpdateDownloader } from "./update-download";
import { migrateLegacyUserData } from "./user-data";
import { CadSupervisor, resolveCadBackend } from "./cad-supervisor";
import { CadRuntimeManager, CadRuntimeConsent } from "./cad-runtime";
import { unpackCadMacApp, verifyCadMacApp } from "./cad-runtime-mac";
import { release as osRelease } from "node:os";
import { PcbSupervisor, resolvePcbBackend } from "./pcb-supervisor";
import { systemLocaleEnv } from "./system-locales";
import { resolveWindowTheme, titleBarOverlayFor } from "./window-theme";
import { decideMediaPermission } from "./media-permission";
import type { OpenCatalogIntent } from "@fabdesk/protocol";
import { OpenCatalogQueue } from "./open-catalog";

const openCatalog = new OpenCatalogQueue();
openCatalog.offer(process.argv);
if (process.defaultApp) {
  const appPath = process.argv[1];
  if (appPath) app.setAsDefaultProtocolClient("fabplane", process.execPath, [resolve(appPath)]);
} else {
  app.setAsDefaultProtocolClient("fabplane");
}

function sendOpenCatalog(intent: OpenCatalogIntent): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  // A send before the renderer loads is dropped; leave pending for take() on mount.
  if (win.webContents.isLoadingMainFrame()) return;
  win.webContents.send("fabdesk:open-catalog", intent);
  // Delivered to a live window; drop pending so a remount cannot replay take().
  openCatalog.take();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  const intent = openCatalog.offer(url);
  if (intent) sendOpenCatalog(intent);
});

// Name / userData / AUMID / WM_CLASS / FABDESK_HOME before any path read or the single-instance lock
// (Electron keys the lock on userData). Packaged production identity is left untouched.
const identity = applyDesktopIdentity(app, {
  packaged: app.isPackaged,
  env: process.env,
  platform: process.platform,
});
const runtimeId = process.env["FABDESK_RUNTIME_ID"]?.trim() || randomUUID();
process.env["FABDESK_RUNTIME_ID"] = runtimeId;
process.env["FABDESK_DESKTOP_PID"] = String(process.pid);
console.error(
  `[main] identity=${identity.productName} userData=${app.getPath("userData")}${process.env["FABDESK_HOME"] ? ` home=${process.env["FABDESK_HOME"]}` : ""}`,
);

// Error reporting (off without a DSN or when the user opted out); must run before `ready` (docs/sentry.md).
initSentry();

// WebMCP (document.modelContext) behind Chromium's feature flag; the renderer polyfills when absent.
app.commandLine.appendSwitch("enable-features", "WebMCP");

// Electron derives userData from productName ("fabPlane"). Older builds used "Fabdesk" or the
// package path "<config>/@fabdesk/desktop"; move that data across once when the new path is empty.
// Skip for the isolated dev copy so we never pull production data into `fabPlane Dev`.
if (!identity.devProfile) migrateLegacyUserData(app.getPath("userData"));

const here = fileURLToPath(new URL(".", import.meta.url));
let supervisor: CoreSupervisor | null = null;
let pcbSupervisor: PcbSupervisor | null = null;
let cadSupervisor: CadSupervisor | null = null;
let automation: AppAutomation | null = null;
let quitting = false;

function developmentIconPath(): string | undefined {
  if (app.isPackaged) return undefined;
  if (process.platform === "win32") return join(here, "../../build/icon.ico");
  if (process.platform === "linux") return join(here, "../../build/icons/512x512.png");
  return join(here, "../../build/icon.png");
}

function createWindow(): BrowserWindow {
  const theme = resolveWindowTheme(app.getPath("userData"), nativeTheme.shouldUseDarkColors);
  nativeTheme.themeSource = theme.themeSource;
  const icon = developmentIconPath();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: identity.productName,
    show: false,
    backgroundColor: theme.backgroundColor,
    ...(icon ? { icon } : {}),
    // macOS: traffic lights inset into the top bar. Windows: no native title bar; the top bar is the
    // title bar and the controls overlay draws minimize/maximize/close over its right end (Claude-style).
    titleBarStyle:
      process.platform === "darwin"
        ? "hiddenInset"
        : process.platform === "win32"
          ? "hidden"
          : "default",
    ...(process.platform === "win32" ? { titleBarOverlay: titleBarOverlayFor(theme.themeId) } : {}),
    // Windows/Linux: no in-window menu bar; the top bar's menu button pops the same menu (app-menu.ts).
    autoHideMenuBar: process.platform !== "darwin",
    trafficLightPosition: { x: 12, y: 17 },
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // Tells the preload (and so the renderer) whether to start its Sentry client, and whether the
      // automation bridge is on (renderer installs window.__fabdeskApp; docs/app-automation.md).
      additionalArguments: [
        ...(sentryActive() ? ["--fabdesk-error-reporting"] : []),
        ...(sentryTestRequested() ? ["--fabdesk-sentry-test"] : []),
        ...(automationEnabled() ? ["--fabdesk-automation"] : []),
        // Dev-profile builds (unpackaged, or FABDESK_DEV_PROFILE=1) show staging/local sign-in up front.
        ...(identity.devProfile ? ["--fabdesk-dev-build"] : []),
      ],
    },
  });
  win.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(identity.productName);
  });
  if (sentryTestRequested()) {
    // Surface the renderer's test-event line on our stderr.
    win.webContents.on("console-message", (ev) => {
      const message = (ev as unknown as { message?: string }).message ?? "";
      if (message.includes("[sentry]")) console.error(`[renderer] ${message}`);
    });
  }
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|file):\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !url.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\0"))
      e.preventDefault();
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, "../renderer/index.html"));
  return win;
}

if (!app.requestSingleInstanceLock()) {
  console.error(`[main] another ${identity.productName} instance holds the lock; quitting`);
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const intent = openCatalog.offer(argv);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (intent) sendOpenCatalog(intent);
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId(identity.appUserModelId);
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(decideMediaPermission(permission, wc.getURL()));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
      decideMediaPermission(permission, wc?.getURL() || requestingOrigin),
    );
    const icon = developmentIconPath();
    if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
    void runSentryTest();
    const home = process.env["FABDESK_HOME"];
    pcbSupervisor = new PcbSupervisor(
      resolvePcbBackend({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    );
    let pcbEnv: Record<string, string>;
    try {
      pcbEnv = await pcbSupervisor.start();
    } catch (error) {
      console.error(`[pcb] fatal: ${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
      return;
    }
    // CAD is optional. Cached signed engines can start; absent CAD never blocks PCB startup.
    let cadEnv: Record<string, string> = {};
    try {
      cadSupervisor = new CadSupervisor(
        app.isPackaged
          ? null
          : resolveCadBackend({ packaged: false, resourcesPath: process.resourcesPath }),
      );
      cadEnv = await cadSupervisor.start();
    } catch (error) {
      console.error(`[cad] ${error instanceof Error ? error.message : String(error)}`);
    }
    const coreExtraEnv = {
      ...coreSentryEnv(),
      ...pcbEnv,
      ...cadEnv,
      ...systemLocaleEnv(app),
      ...(home ? { FABDESK_HOME: home } : {}),
    };
    const cadRuntime = new CadRuntimeManager({
      cache: join(app.getPath("userData"), "cad-runtimes"),
      target: `${process.platform}-${process.arch}`,
      supportedOS: process.platform === "darwin" && Number(osRelease().split(".")[0]) >= 24,
      installedApps: ["/Applications/CADRuntime.app"],
      verify: verifyCadMacApp,
      unpack: unpackCadMacApp,
      activate: async (manifest) => {
        const preferences = join(app.getPath("userData"), "cad-preferences");
        await mkdir(preferences, { recursive: true });
        await cadSupervisor?.stop();
        cadSupervisor = new CadSupervisor(
          resolveCadBackend({
            packaged: true,
            resourcesPath: process.resourcesPath,
            env: {
              ...process.env,
              FABDESK_FAB_CAD_BUNDLE: manifest,
              FREECAD_USER_HOME: preferences,
            },
          }),
        );
        Object.assign(coreExtraEnv, await cadSupervisor.start());
        if (supervisor) await supervisor.restart();
      },
    });
    if (app.isPackaged) {
      try {
        await cadRuntime.initialize();
      } catch (e) {
        console.error(`[cad] optional runtime unavailable: ${String(e)}`);
      }
    }
    supervisor = new CoreSupervisor({
      localAuth: localAuthEnabled(identity.devProfile),
      runtimeId,
      binaryOverride: process.env["FABDESK_CORE_BIN"],
      extraEnv: coreExtraEnv,
      ...(identity.devProfile ? { devProfile: true } : {}),
    });
    installAppMenu();
    registerIpc(supervisor);
    ipcMain.handle("fabdesk:pending-open-catalog", () => openCatalog.take());
    const developmentCadReady = !app.isPackaged && Boolean(cadEnv["FABDESK_FAB_CAD_BRIDGE_URL"]);
    ipcMain.handle("fabdesk:cad-runtime-state", () =>
      developmentCadReady ? { status: "ready" } : cadRuntime.state(),
    );
    ipcMain.handle("fabdesk:prepare-cad-runtime", () =>
      developmentCadReady ? { status: "ready" } : cadRuntime.prepare(),
    );
    ipcMain.handle("fabdesk:reconnect-cad-runtime", () =>
      developmentCadReady ? { status: "ready" } : cadRuntime.reconnect(),
    );
    const cadConsent = new CadRuntimeConsent(cadRuntime, async (offer) => {
      const result = await dialog.showMessageBox({
        type: "question",
        title: "Download CAD runtime?",
        message: "May fabPlane download and install its FreeCAD CAD runtime?",
        detail: `Version ${offer.version}\nPlatform: Apple Silicon Mac (ARM64), macOS ${offer.minimumOS} or later\nDownload ${(offer.downloadBytes / 1048576).toFixed(1)} MiB (${offer.downloadBytes} bytes)\nInstalled ${(offer.installedBytes / 1048576).toFixed(1)} MiB (${offer.installedBytes} bytes)\nFrom ${offer.sourceUrl}\nThe signed runtime is cached outside the app. The local core restarts to enable CAD. PCB works without it.`,
        buttons: ["Later", "Download and install"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    });
    ipcMain.handle("fabdesk:download-cad-runtime", () => cadConsent.request());
    ipcMain.handle("fabdesk:defer-cad-runtime", () => cadRuntime.defer());
    ipcMain.handle("fabdesk:cancel-cad-runtime", () => {
      cadConsent.cancel();
      return cadRuntime.defer();
    });
    // Dev / FABDESK_AUTOMATION=1: loopback bridge for the core's `app` MCP toolset (docs/app-automation.md).
    const sup = supervisor;
    automation = await startAppAutomation({
      token: () => sup.currentToken,
      version: app.getVersion(),
      log: (line) => console.error(`[automation] ${line}`),
    });
    // The core's persisted `errorReporting` setting is the source of truth for the opt-out.
    supervisor.on("status", (info: CoreInfo) => {
      if (info.status.state === "ready") void syncErrorReportingFromCore(info);
    });
    const updates = new UpdateChecker({
      url: process.env["FABDESK_UPDATE_URL"],
      enabled: process.env["FABDESK_UPDATE_CHECK"] !== "0",
    });
    registerUpdateIpc(updates);
    registerUpdateDownloadIpc(new UpdateDownloader(updates));
    updates.start();
    createWindow();
    // Startup deep links stay queued for take() after the renderer mounts.
    // Sending here is always lost because webContents has not loaded yet.
    // CI / smoke runs: quit on their own after N ms (FABDESK_SMOKE_MS).
    const smokeMs = Number(process.env["FABDESK_SMOKE_MS"] ?? 0);
    if (smokeMs > 0) setTimeout(() => app.quit(), smokeMs);
    await supervisor.start();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (e) => {
    if (quitting || !supervisor) return;
    e.preventDefault();
    quitting = true;
    void automation?.stop();
    supervisor
      .stop({ shutdown: true })
      .catch(() => {})
      .then(() => Promise.all([pcbSupervisor?.stop(), cadSupervisor?.stop()]))
      .then(() => flushSentry())
      .finally(() => app.quit());
  });
}
