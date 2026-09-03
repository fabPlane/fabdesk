/**
 * Electron glue for the app automation bridge (automation-server.ts): adapts BrowserWindow /
 * webContents, writes `<userData>/app-bridge.json` (next to daemon.json, mode 0600) while the
 * server runs and removes it on quit. Enabled in dev builds or with FABDESK_AUTOMATION=1.
 */
import { app, BrowserWindow, type NativeImage } from "electron";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBridgeServer, type AutomationDeps, type AutomationWindow, type BridgeServer, type CapturedImage, type InputEvent, type Rect } from "./automation-server";

export const APP_BRIDGE_FILE = "app-bridge.json";

export function automationMode(env: NodeJS.ProcessEnv = process.env, packaged = app.isPackaged): "dev" | "env" | null {
  if (env["FABDESK_AUTOMATION"] === "1") return "env";
  if (env["FABDESK_AUTOMATION"] === "0") return null;
  return packaged ? null : "dev";
}

export function automationEnabled(): boolean {
  return automationMode() !== null;
}

function wrapImage(img: NativeImage): CapturedImage {
  return {
    size: () => img.getSize(),
    resize: (width, height) => wrapImage(img.resize({ width, height, quality: "good" })),
    png: () => img.toPNG(),
    jpeg: (quality) => img.toJPEG(quality),
  };
}

export function adaptWindow(win: BrowserWindow): AutomationWindow {
  return {
    id: win.id,
    isDestroyed: () => win.isDestroyed(),
    isFocused: () => !win.isDestroyed() && win.isFocused(),
    bounds: () => win.getBounds(),
    title: () => win.getTitle(),
    url: () => win.webContents.getURL(),
    capture: async (rect?: Rect) => wrapImage(rect ? await win.webContents.capturePage(rect) : await win.webContents.capturePage()),
    executeJavaScript: (code, userGesture) => win.webContents.executeJavaScript(code, userGesture),
    sendInputEvent: (ev: InputEvent) => win.webContents.sendInputEvent(ev as unknown as Electron.MouseInputEvent),
    focus: () => {
      if (!win.isDestroyed()) win.webContents.focus();
    },
  };
}

export function bridgeFilePath(): string {
  return join(app.getPath("userData"), APP_BRIDGE_FILE);
}

/** Atomic 0600 write: temp file in the same directory, then rename over the target. */
export function writeBridgeFile(path: string, info: { url: string; pid: number; startedAt: string }): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function removeBridgeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

export type AppAutomation = { url: string; file: string; stop(): Promise<void> };

export async function startAppAutomation(opts: { token: () => string | null; version: string; log?: (line: string) => void }): Promise<AppAutomation | null> {
  const mode = automationMode();
  if (!mode) return null;
  const deps: AutomationDeps = {
    version: opts.version,
    packaged: app.isPackaged,
    platform: process.platform,
    mode,
    pid: process.pid,
    windows: () => BrowserWindow.getAllWindows().map(adaptWindow),
    token: opts.token,
  };
  let server: BridgeServer;
  try {
    server = await startBridgeServer(deps, { ...(opts.log ? { log: opts.log } : {}) });
  } catch (e) {
    opts.log?.(`automation bridge failed to start: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const file = bridgeFilePath();
  writeBridgeFile(file, { url: server.url, pid: process.pid, startedAt: new Date().toISOString() });
  opts.log?.(`automation bridge listening on ${server.url} (${mode}); wrote ${file}`);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    removeBridgeFile(file);
    await server.close();
  };
  app.once("will-quit", () => {
    removeBridgeFile(file);
    void stop();
  });
  return { url: server.url, file, stop };
}

