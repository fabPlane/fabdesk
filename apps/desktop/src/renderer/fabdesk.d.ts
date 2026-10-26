/// <reference types="@mcp-b/webmcp-types" />
import type { CadRuntimeBridge } from "@fabdesk/protocol";
import type { CoreInfo } from "../shared/core-info";
import type { UpdateCheckResult, UpdateDownloadState } from "@fabdesk/protocol";
import type { CoreClient, HostAdapter } from "@fabdesk/ui";
import type { FabdeskAutomationApi } from "./automation";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** Surface exposed by src/preload/index.ts via contextBridge. */
export interface FabdeskBridge extends CadRuntimeBridge {
  getZoomFactor(): number;
  nativeSpeech: NonNullable<HostAdapter["nativeSpeech"]>;
  platform: NodeJS.Platform | string;
  /** True when the main process started Sentry (DSN configured and the user has not opted out). */
  errorReporting: boolean;
  /** True when main runs with FABDESK_SENTRY_TEST=1 (send one handled test event). */
  sentryTest: boolean;
  /** True when the app automation bridge is on (dev builds / FABDESK_AUTOMATION=1); the renderer then installs window.__fabdeskApp. */
  automationEnabled: boolean;
  /** True for the isolated fabPlane Dev profile; the sign-in screen then shows staging/local options without a shortcut. */
  devBuild: boolean;
  /** Persist the Appearance theme so the next launch paints the matching window background. */
  setTheme(themeId: string | null): Promise<void>;
  setErrorReporting(enabled: boolean): Promise<void>;
  /** id + handle of the signed-in principal (never email); null on logout. */
  setSentryUser(user: { id: string; username?: string } | null): Promise<void>;
  coreInfo(): Promise<CoreInfo>;
  /** Pop the application menu at window coordinates (Windows/Linux; macOS uses the system menu bar). */
  showAppMenu(pos: { x: number; y: number }): Promise<void>;
  /** Menu commands from the main-process menu (new-chat, palette, settings, sidebar, board). */
  onMenu(cb: (command: string) => void): () => void;
  restartCore(): Promise<void>;
  onCoreStatus(cb: (info: CoreInfo) => void): () => void;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openLogs(): Promise<void>;
  pickDirectory(): Promise<string | null>;
  pickFile(opts?: PickFileOptions): Promise<string[]>;
  localAuthAllowed(): Promise<boolean>;
  setLocalAuth(enabled: boolean): Promise<void>;
  updateStatus(): Promise<UpdateCheckResult | null>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  onUpdateStatus(cb: (result: UpdateCheckResult) => void): () => void;
  updateDownloadState(): Promise<UpdateDownloadState>;
  downloadUpdate(): Promise<UpdateDownloadState>;
  cancelUpdateDownload(): Promise<void>;
  openUpdate(): Promise<string>;
  onUpdateDownload(cb: (state: UpdateDownloadState) => void): () => void;
  /** Deep link queued from `fabplane://open` before the renderer subscribed. */
  pendingOpenCatalog(): Promise<{ catalogId: string; remix: boolean } | null>;
  onOpenCatalog(cb: (intent: { catalogId: string; remix: boolean }) => void): () => void;
}

declare global {
  interface Window {
    fabdesk?: FabdeskBridge;
    /** Renderer automation API (src/renderer/automation.ts); present only when `fabdesk.automationEnabled`. */
    __fabdeskApp?: FabdeskAutomationApi;
    /** Live core client + status handed to the automation API by App.tsx (never the token). */
    __fabdeskRuntime?: { client: CoreClient | null; coreInfo: CoreInfo | null };
  }
}
