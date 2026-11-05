import type { SchematicFocus } from "@fabdesk/protocol";
import type { ReleaseNotes, UpdateCheckResult, UpdateDownloadState } from "@fabdesk/protocol";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CoreClient } from "./CoreClient";
import { EVENT_TOPICS, handleCoreEvent, messagesKey, syncLiveRuns, type RouteSink } from "./events";
import type { SseStatus } from "./sse";

export interface FilePickOptions {
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** What the surrounding shell (Electron preload, a web host, or the mobile app) provides to the UI. */
export interface HostAdapter {
  platform: string;
  /** Optional offline system recognizer provided by the desktop host. */
  nativeSpeech?: {
    status: (language: string) => Promise<{ available: boolean; message: string; needsDownload?: boolean }>;
    prepare: (language: string, id: string) => Promise<{ available: boolean; message: string; needsDownload?: boolean }>;
    transcribe: (request: { id: string; audio: ArrayBuffer; language: string }) => Promise<{ text: string }>;
    cancel: (id: string) => Promise<void>;
  };
  /** Dev-profile build (unpackaged, or FABDESK_DEV_PROFILE=1): staging/local sign-in is shown up front. */
  devBuild?: boolean;
  openExternal: (url: string) => Promise<void> | void;
  /** Open a local file with the operating system's default application (Electron only). */
  openPath?: (path: string) => Promise<void> | void;
  pickDirectory?: () => Promise<string | null>;
  pickFile: (opts?: FilePickOptions) => Promise<string[]>;
  localAuthAllowed: () => Promise<boolean>;
  setLocalAuth?: (enabled: boolean) => Promise<void>;
  restartCore?: () => Promise<void>;
  /** Pop the host's application menu at window coordinates (Electron on Windows/Linux). */
  showAppMenu?: (pos: { x: number; y: number }) => Promise<void> | void;
  /** Commands from the host's application menu (new-chat, palette, settings, sidebar, board). */
  onMenu?: (cb: (command: string) => void) => () => void;
  openLogs?: () => Promise<void>;
  /** Last update-check result from the host (Electron main), if it performs checks. */
  updateStatus?: () => Promise<UpdateCheckResult | null>;
  checkForUpdates?: () => Promise<UpdateCheckResult>;
  onUpdateStatus?: (cb: (result: UpdateCheckResult) => void) => () => void;
  /** In-app installer download (Electron only); absent hosts fall back to opening the URL. */
  updateDownloadState?: () => Promise<UpdateDownloadState>;
  downloadUpdate?: () => Promise<UpdateDownloadState>;
  cancelUpdateDownload?: () => Promise<void>;
  openUpdate?: () => Promise<string>;
  onUpdateDownload?: (cb: (state: UpdateDownloadState) => void) => () => void;
  /** Notes baked into this build (scripts/release-notes.ts); drives the "What's new" link and dialog. */
  releaseNotes?: ReleaseNotes;
}

/** A host that can do nothing. Platform hosts (`browserHost`, the Electron preload) override it. */
export const nullHost: HostAdapter = {
  platform: "unknown",
  openExternal: () => {},
  pickFile: async () => [],
  localAuthAllowed: async () => false,
};

export interface CoreContextValue {
  client: CoreClient;
  host: HostAdapter;
  sseStatus: SseStatus;
}

const CoreContext = createContext<CoreContextValue | null>(null);

export function useCore(): CoreContextValue {
  const v = useContext(CoreContext);
  if (!v) throw new Error("useCore must be used inside <CoreProvider>");
  return v;
}

export function useCoreClient(): CoreClient {
  return useCore().client;
}

export interface CoreProviderProps {
  client: CoreClient;
  host?: HostAdapter;
  queryClient?: QueryClient;
  /** Where `route.*` frames go; omitted on clients with no Route Cinema (mobile). */
  route?: RouteSink;
  onSchematicFocus?: (focus: SchematicFocus) => void;
  /** Opens the event stream. Defaults to the client's SSE subscription; mobile passes a WebSocket one. */
  subscribe?: CoreEventSubscribe;
  children: ReactNode;
}

export type CoreEventSubscribe = (
  topics: string[],
  onEvent: Parameters<CoreClient["subscribe"]>[1],
  onStatus: (status: SseStatus) => void,
) => { close: () => void };

export function CoreProvider({
  client,
  host = nullHost,
  queryClient,
  route,
  onSchematicFocus,
  subscribe,
  children,
}: CoreProviderProps) {
  // A restarted daemon can rotate its token while keeping the same URL. Do not let queries
  // made with the old client (including a 401) populate the new connection's cache.
  const qc = useMemo(
    () =>
      queryClient ??
      new QueryClient({
        defaultOptions: { queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: false } },
      }),
    [client, queryClient],
  );
  const [sseStatus, setSseStatus] = useState<SseStatus>("connecting");
  const value = useMemo<CoreContextValue>(
    () => ({ client, host, sseStatus }),
    [client, host, sseStatus],
  );
  return (
    <QueryClientProvider client={qc}>
      <CoreContext.Provider value={value}>
        <CoreEventBridge
          client={client}
          onStatus={setSseStatus}
          {...(route ? { route } : {})}
          {...(onSchematicFocus ? { onSchematicFocus } : {})}
          {...(subscribe ? { subscribe } : {})}
        />
        {children}
      </CoreContext.Provider>
    </QueryClientProvider>
  );
}

function CoreEventBridge(props: {
  client: CoreClient;
  onStatus: (s: SseStatus) => void;
  route?: RouteSink;
  onSchematicFocus?: (focus: SchematicFocus) => void;
  subscribe?: CoreEventSubscribe;
}) {
  useCoreEvents(props.client, props.onStatus, {
    ...(props.route ? { route: props.route } : {}),
    ...(props.onSchematicFocus ? { onSchematicFocus: props.onSchematicFocus } : {}),
    ...(props.subscribe ? { subscribe: props.subscribe } : {}),
  });
  return null;
}

/** Subscribes to the daemon's event stream and routes events into react-query and the stores. */
export function useCoreEvents(
  client: CoreClient,
  onStatus?: (s: SseStatus) => void,
  opts: { route?: RouteSink; onSchematicFocus?: (focus: SchematicFocus) => void; subscribe?: CoreEventSubscribe } = {},
): void {
  const qc = useQueryClient();
  const { route, onSchematicFocus, subscribe } = opts;
  useEffect(() => {
    const open = subscribe ?? ((topics, onEvent, onSt) => client.subscribe(topics, onEvent, onSt));
    let wasOpen = false;
    const sub = open(
      EVENT_TOPICS,
      (event) => handleCoreEvent(event, { qc, client, ...(route ? { route } : {}), ...(onSchematicFocus ? { onSchematicFocus } : {}) }),
      (status) => {
        // A stream that comes back after a gap (daemon restart, sleep, network blip) may have missed
        // events beyond the bus's replay window; refetching what is on screen is the cheap correct answer.
        if (resyncOnStatus(wasOpen, status)) void qc.invalidateQueries();
        // Every open, first or not: the store only learns about runs from events, so a run that
        // was already in progress when this client connected is seeded from the daemon.
        if (status === "open")
          void syncLiveRuns(client).then((threads) => {
            for (const id of threads) void qc.invalidateQueries({ queryKey: messagesKey(id) });
          });
        if (status === "open") wasOpen = true;
        onStatus?.(status);
      },
    );
    return () => sub.close();
  }, [client, qc, onStatus, route, onSchematicFocus, subscribe]);
}

/** Whether a stream status change is a reconnect (open again after having been open) that needs a refetch. */
export function resyncOnStatus(wasOpen: boolean, status: SseStatus): boolean {
  return wasOpen && status === "open";
}
