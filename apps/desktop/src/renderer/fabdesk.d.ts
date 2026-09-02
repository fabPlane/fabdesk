/// <reference types="@mcp-b/webmcp-types" />
import type { CoreInfo } from "../shared/core-info";

export interface PickFileOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** Surface exposed by src/preload/index.ts via contextBridge. */
export interface FabdeskBridge {
  platform: NodeJS.Platform | string;
  coreInfo(): Promise<CoreInfo>;
  restartCore(): Promise<void>;
  onCoreStatus(cb: (info: CoreInfo) => void): () => void;
  openExternal(url: string): Promise<void>;
  openLogs(): Promise<void>;
  pickFile(opts?: PickFileOptions): Promise<string[]>;
  localAuthAllowed(): Promise<boolean>;
  setLocalAuth(enabled: boolean): Promise<void>;
}

declare global {
  interface Window {
    fabdesk?: FabdeskBridge;
  }
}
