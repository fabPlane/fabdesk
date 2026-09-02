/// <reference types="@mcp-b/webmcp-types" />
import type { CoreInfo } from "../shared/core-info";
import type { UpdateCheckResult } from "@fabdesk/protocol";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** Surface exposed by src/preload/index.ts via contextBridge. */
export interface FabdeskBridge {
  platform: NodeJS.Platform | string;
  /** True when the main process started Sentry (DSN configured and the user has not opted out). */
  errorReporting: boolean;
  /** True when main runs with FABDESK_SENTRY_TEST=1 (send one handled test event). */
  sentryTest: boolean;
  setErrorReporting(enabled: boolean): Promise<void>;
  /** id + handle of the signed-in principal (never email); null on logout. */
  setSentryUser(user: { id: string; username?: string } | null): Promise<void>;
  coreInfo(): Promise<CoreInfo>;
  restartCore(): Promise<void>;
  onCoreStatus(cb: (info: CoreInfo) => void): () => void;
  openExternal(url: string): Promise<void>;
  openLogs(): Promise<void>;
  pickFile(opts?: PickFileOptions): Promise<string[]>;
  localAuthAllowed(): Promise<boolean>;
  setLocalAuth(enabled: boolean): Promise<void>;
  updateStatus(): Promise<UpdateCheckResult | null>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  onUpdateStatus(cb: (result: UpdateCheckResult) => void): () => void;
}

declare global {
  interface Window {
    fabdesk?: FabdeskBridge;
  }
}
