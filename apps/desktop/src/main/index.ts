import { app, ipcMain, dialog, BrowserWindow, nativeTheme, session, shell } from "electron";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isCoreReady, type CoreInfo } from "../shared/core-info";
import { CoreSupervisor } from "./core-supervisor";
import { applyDesktopIdentity, developmentIconFile } from "./dev-profile";
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
import { inPlaceUnsupportedReason } from "./update-feed";
import { UpdateInstaller } from "./update-install";
import { migrateLegacyUserData } from "./user-data";
import { CadSupervisor, resolveCadBackend } from "./cad-supervisor";
import { CadRuntimeManager, CadRuntimeConsent } from "./cad-runtime";
import { unpackCadMacApp, verifyCadMacApp } from "./cad-runtime-mac";
import { release as osRelease } from "node:os";
import { PcbSupervisor, resolvePcbBackend } from "./pcb-supervisor";
import { systemLocaleEnv } from "./system-locales";
import { resolveWindowTheme, titleBarOverlayFor } from "./window-theme";
import { decideMediaPermission } from "./media-permission";
import {
  collectFunnelHandoff,
  funnelHandoffToEnv,
  isEmptyFunnelHandoff,
  mergeFunnelHandoff,
  type FunnelHandoff,
  type OpenCatalogIntent,
} from "@fabdesk/protocol";
import { OpenSharedProjectQueue } from "./open-shared-project";
import { OpenCatalogQueue } from "./open-catalog";

const openSharedProject = new OpenSharedProjectQueue();
openSharedProject.offer(process.argv);
const openCatalog = new OpenCatalogQueue();
openCatalog.offer(process.argv);

let launchHandoff: FunnelHandoff = collectFunnelHandoff({ argv: process.argv, env: process.env });
let supervisor: CoreSupervisor | null = null;

function corePosthogEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "POSTHOG_KEY", "POSTHOG_HOST", "POSTHOG_PROJECT_API_KEY",
    "FABDESK_POSTHOG_KEY", "FABDESK_POSTHOG_HOST",
    "FABDESK_UTM_SOURCE", "FABDESK_UTM_MEDIUM", "FABDESK_UTM_CAMPAIGN",
    "FABDESK_UTM_CONTENT", "FABDESK_UTM_TERM", "FABDESK_REFERRER",
    "FABDESK_PH_ID", "FABDESK_GCLID",
  ] as const) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function postFunnelHandoff(handoff: FunnelHandoff, info: CoreInfo | null = supervisor?.info() ?? null): void {
  if (isEmptyFunnelHandoff(handoff) || !isCoreReady(info)) return;
  void fetch(`${info.url}/funnel/handoff`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(handoff),
  }).catch(() => {});
}

function deliverFunnelHandoff(next: FunnelHandoff): void {
  launchHandoff = mergeFunnelHandoff(launchHandoff, next);
  postFunnelHandoff(launchHandoff);
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

function sendOpenSharedProject(intent: import("@fabdesk/protocol").OpenSharedProjectIntent): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return;
  win.webContents.send("fabdesk:open-shared-project", intent);
  openSharedProject.take();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  deliverFunnelHandoff(collectFunnelHandoff({ urls: [url] }));
  const shared = openSharedProject.offer(url);
  if (shared) {
    sendOpenSharedProject(shared);
    return;
  }
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
if (process.defaultApp) {
  const appPath = process.argv[1];
  if (appPath)
    app.setAsDefaultProtocolClient("fabplane", process.execPath, [
      resolve(appPath),
      `--user-data-dir=${app.getPath("userData")}`,
    ]);
} else {
  app.setAsDefaultProtocolClient("fabplane");
}

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
let pcbSupervisor: PcbSupervisor | null = null;
let cadSupervisor: CadSupervisor | null = null;
let automation: AppAutomation | null = null;
let quitting = false;

/**
 * Stops the core and the bridges and marks the app as quitting, so the next quit goes straight
 * through. Shared by a normal quit and by an in-place update, which must not replace the app
 * while its child processes still run from it.
 */
async function stopBackendsForQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  void automation?.stop();
  try {
    await supervisor?.stop({ shutdown: true }).catch(() => {});
    await Promise.all([pcbSupervisor?.stop(), cadSupervisor?.stop()]);
    await flushSentry();
  } catch {
    // Quitting anyway.
  }
}

function developmentIconPath(): string | undefined {
  const file = developmentIconFile({ packaged: app.isPackaged, platform: process.platform, env: process.env });
  return file ? join(here, "../../build", file) : undefined;
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
    deliverFunnelHandoff(collectFunnelHandoff({ argv }));
    const shared = openSharedProject.offer(argv);
    if (shared) sendOpenSharedProject(shared);
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
      resolvePcbBackend({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
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
      ...corePosthogEnv(),
      ...funnelHandoffToEnv(launchHandoff),
      ...pcbEnv,
      ...cadEnv,
      ...systemLocaleEnv(app),
      ...(home ? { FABDESK_HOME: home } : {}),
    };
    let coreStartup: Promise<void> = Promise.resolve();
    const cadRuntime = new CadRuntimeManager({
      cache: join(app.getPath("userData"), "cad-runtimes"),
      target: `${process.platform}-${process.arch}`,
      supportedOS: process.platform === "darwin" && Number(osRelease().split(".")[0]) >= 24,
      installedApps: ["/Applications/CADRuntime.app"],
      verify: verifyCadMacApp,
      unpack: unpackCadMacApp,
      activate: async (manifest) => {
        // First-use IPC can arrive while the initial core handshake is pending.
        await coreStartup;
        if (quitting) return;
        const preferences = join(app.getPath("userData"), "cad-preferences");
        await mkdir(preferences, { recursive: true });
        await cadSupervisor?.stop();
        if (quitting) return;
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
        if (quitting) {
          await cadSupervisor.stop();
          return;
        }
        if (supervisor) await supervisor.restart();
      },
    });
    supervisor = new CoreSupervisor({
      localAuth: localAuthEnabled(identity.devProfile),
      runtimeId,
      binaryOverride: process.env["FABDESK_CORE_BIN"],
      extraEnv: coreExtraEnv,
      ...(identity.devProfile ? { devProfile: true } : {}),
    });
    installAppMenu();
    registerIpc(supervisor);
    ipcMain.handle("fabdesk:pending-open-shared-project", () => openSharedProject.take());
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
      if (info.status.state === "ready") {
        void syncErrorReportingFromCore(info);
        postFunnelHandoff(launchHandoff, info);
      }
    });
    const updates = new UpdateChecker({
      url: process.env["FABDESK_UPDATE_URL"],
      enabled: process.env["FABDESK_UPDATE_CHECK"] !== "0",
    });
    registerUpdateIpc(updates);
    const downloader = new UpdateDownloader(updates);
    const inPlaceBlocked = inPlaceUnsupportedReason({
      platform: process.platform,
      packaged: app.isPackaged,
      exePath: app.getPath("exe"),
      appImage: process.env["APPIMAGE"],
      disabled: process.env["FABDESK_UPDATE_INPLACE"] === "0",
    });
    if (inPlaceBlocked) console.log(`[update] installer downloads only: ${inPlaceBlocked}`);
    registerUpdateDownloadIpc(
      inPlaceBlocked
        ? downloader
        : new UpdateInstaller(updates, {
            prepareQuit: stopBackendsForQuit,
            fallback: downloader,
            installRecordPath: join(app.getPath("userData"), "update-install.json"),
          }),
    );
    updates.start();
    coreStartup = supervisor.start();
    createWindow();
    // Startup deep links stay queued for take() after the renderer mounts.
    // Sending here is always lost because webContents has not loaded yet.
    // CI / smoke runs: quit on their own after N ms (FABDESK_SMOKE_MS).
    const smokeMs = Number(process.env["FABDESK_SMOKE_MS"] ?? 0);
    if (smokeMs > 0) setTimeout(() => app.quit(), smokeMs);
    await coreStartup;
    postFunnelHandoff(launchHandoff);
    // Optional discovery can include filesystem scans and macOS signature checks.
    // Open the window and start PCB/core first; activating verified CAD afterwards
    // restarts the ready core with its bridge environment. First CAD use shares
    // this initialization, so it cannot start a second verification/activation.
    if (app.isPackaged) {
      void cadRuntime.initialize().catch((e: unknown) => {
        console.error(`[cad] optional runtime unavailable: ${String(e)}`);
      });
    }
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
    void stopBackendsForQuit().finally(() => app.quit());
  });
}
