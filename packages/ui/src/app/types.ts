/** Lifecycle of the core daemon as reported by the host (Electron main process). */
export type CoreState = "starting" | "ready" | "restarting" | "crashed" | "stopped";

export interface CoreStatusInfo {
  state: CoreState;
  message?: string;
  attempt?: number;
  port?: number;
  pid?: number;
  /** True when we attached to a daemon we did not spawn. */
  attached?: boolean;
  localAuth?: boolean;
}

export interface CoreInfo {
  url: string | null;
  token: string | null;
  status: CoreStatusInfo;
}
