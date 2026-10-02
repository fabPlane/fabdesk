/** Optional desktop CAD runtime; renderer never chooses a URL, checksum or install path. */
export interface CadRuntimeOffer {
  version: string;
  target: string;
  minimumOS: string;
  downloadBytes: number;
  installedBytes: number;
  sourceUrl: string;
}
export interface CadRuntimeState {
  status:
    | "missing"
    | "consent"
    | "deferred"
    | "downloading"
    | "verifying"
    | "ready"
    | "unsupported"
    | "error";
  offer?: CadRuntimeOffer;
  received?: number;
  message?: string;
}
export interface CadRuntimeBridge {
  cadRuntimeState(): Promise<CadRuntimeState>;
  prepareCadRuntime(): Promise<CadRuntimeState>;
  downloadCadRuntime(): Promise<CadRuntimeState>;
  deferCadRuntime(): Promise<CadRuntimeState>;
  cancelCadRuntime(): Promise<void>;
}
