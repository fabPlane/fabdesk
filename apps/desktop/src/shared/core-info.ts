/** Core daemon status shared by main, preload and renderer. Structurally identical to @fabdesk/ui's CoreInfo. */
export type CoreState = "starting" | "ready" | "restarting" | "crashed" | "stopped";

export interface CoreStatusInfo {
  state: CoreState;
  message?: string;
  attempt?: number;
  port?: number;
  pid?: number;
  attached?: boolean;
  localAuth?: boolean;
}

export interface CoreInfo {
  url: string | null;
  token: string | null;
  status: CoreStatusInfo;
}

/** True when the daemon is reachable: ready state with an address and token. */
export function isCoreReady(info: CoreInfo | null | undefined): info is CoreInfo & { url: string; token: string } {
  return Boolean(info && info.status.state === "ready" && info.url && info.token);
}
