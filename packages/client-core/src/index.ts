/**
 * Platform-agnostic fabPlane client: transport, the typed core API, the event reducer and the
 * react-query/zustand layer. Shared by the Electron renderer (`@fabdesk/ui`) and the mobile app.
 * Nothing here may touch the DOM — `document`, `window`, `localStorage` and friends belong to the
 * view packages.
 */
export { CoreClient, CoreHttpError, parseJsonl } from "./CoreClient";
export type {
  CoreClientOptions,
  CreateThreadInput,
  PatchThreadInput,
  SendMessageInput,
  ToolCallResponse,
  FetchLike,
} from "./CoreClient";

export {
  subscribeSse,
  reconnectDelay,
  appendLastEventId,
  parseCoreEvent,
  EVENT_SOURCE_CLOSED,
} from "./sse";
export type {
  EventSourceLike,
  EventSourceFactory,
  SseStatus,
  SseSubscription,
  SseOptions,
} from "./sse";
export { subscribeWs, parseWsFrame } from "./ws";
export type { WebSocketLike, WebSocketFactory, WsOptions } from "./ws";

export { DirectTransport } from "./transport";
export type {
  CoreTransport,
  TransportKind,
  DirectTransportOptions,
  EventStreamOptions,
} from "./transport";

export { claimPairing, claimFirstReachable } from "./pairing";
export type { ClaimOptions, PairedConnection } from "./pairing";
export {
  buildPairingUrl,
  pairingUrlFromEndpoints,
  parsePairingUrl,
  candidateBaseUrls,
  PAIRING_URL_SCHEME,
  PAIRING_URL_PREFIX,
} from "@fabdesk/protocol";
export type { PairingPayload } from "@fabdesk/protocol";

export { handleCoreEvent, appendDelta, appendPart, messagesKey, patchThreadCaches, EVENT_TOPICS } from "./events";
export type { HandlerCtx, RouteSink } from "./events";

export { CoreProvider, useCore, useCoreClient, useCoreEvents, nullHost } from "./provider";
export type {
  HostAdapter,
  FilePickOptions,
  CoreContextValue,
  CoreProviderProps,
  CoreEventSubscribe,
} from "./provider";

export { useAuthStore } from "./stores/auth";
export type { AuthStoreState } from "./stores/auth";
export { useRunsStore } from "./stores/runs";
export type { LiveRun, LiveJob } from "./stores/runs";

export { useRunTool, resolveToolName, TOOL_PATTERNS } from "./tools";
export type { ToolKind, ToolRunState } from "./tools";

export { groupThreadsByProject } from "./group-threads";
export type { ProjectThreadGroup, ProjectThreadGroupKind } from "./group-threads";
export { pickerModelChoices, agentModelLabel } from "./agent-model-choices";

export * from "./queries";
