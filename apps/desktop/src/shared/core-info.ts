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
