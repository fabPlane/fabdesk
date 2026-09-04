import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreInfo } from "../shared/core-info";
import { CoreSupervisor } from "./core-supervisor";
import { applyDesktopIdentity } from "./dev-profile";
import { registerIpc } from "./ipc";
import { automationEnabled, startAppAutomation, type AppAutomation } from "./automation";
import { localAuthEnabled } from "./local-mode";
import { coreSentryEnv, flushSentry, initSentry, runSentryTest, sentryActive, sentryTestRequested, syncErrorReportingFromCore } from "./sentry";
import { registerUpdateIpc, UpdateChecker } from "./updates";
import { registerUpdateDownloadIpc, UpdateDownloader } from "./update-download";
import { migrateLegacyUserData } from "./user-data";
import { resolveWindowTheme } from "./window-theme";

// Name / userData / AUMID / WM_CLASS / FABDESK_HOME before any path read or the single-instance lock
// (Electron keys the lock on userData). Packaged production identity is left untouched.
const identity = applyDesktopIdentity(app, { packaged: app.isPackaged, env: process.env, platform: process.platform });

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
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 12, y: 10 },
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
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !url.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\0")) e.preventDefault();
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(here, "../renderer/index.html"));
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId(identity.appUserModelId);
    const icon = developmentIconPath();
    if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
    void runSentryTest();
    const home = process.env["FABDESK_HOME"];
    supervisor = new CoreSupervisor({
      localAuth: localAuthEnabled(),
      binaryOverride: process.env["FABDESK_CORE_BIN"],
      extraEnv: { ...coreSentryEnv(), ...(home ? { FABDESK_HOME: home } : {}) },
      ...(identity.devProfile ? { devProfile: true } : {}),
    });
    registerIpc(supervisor);
    // Dev / FABDESK_AUTOMATION=1: loopback bridge for the core's `app` MCP toolset (docs/app-automation.md).
    const sup = supervisor;
    automation = await startAppAutomation({ token: () => sup.currentToken, version: app.getVersion(), log: (line) => console.error(`[automation] ${line}`) });
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
      .then(() => flushSentry())
      .finally(() => app.quit());
  });
}
