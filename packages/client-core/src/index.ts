/**
 * Platform-agnostic fabPlane client: transport, the typed core API, the event reducer and the
 * react-query/zustand layer. Shared by the Electron renderer (`@fabdesk/ui`) and the mobile app.
 * Nothing here may touch the DOM — `document`, `window`, `localStorage` and friends belong to the
 * view packages.
 */
export { CoreClient, CoreHttpError, parseJsonl } from "./CoreClient";
export { deduplicateChatNotices } from "./chat-notices";
export { errorHelp, errorMessage, errorPayload, agentErrorText, splitAgentError } from "./error-help";
export type { ErrorHelp, ErrorAction, ErrorContext } from "./error-help";
export type {
  CoreClientOptions,
  ThreadDetail,
  LiveRunSummary,
  CreateThreadInput,
  PatchThreadInput,
  SendMessageInput,
  ToolCallResponse,
  FetchLike,
  DevicePushPrefs,
  DevicePushRegistration,
  DevicePushState,
  DeviceMe,
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

export {
  DirectTransport,
  ProxyTransport,
  relayBaseUrl,
  CoreOfflineError,
  isCoreOffline,
  relaySaysCoreOffline,
  RELAY_CLOSE_CORE_OFFLINE,
} from "./transport";
export type {
  CoreTransport,
  TransportKind,
  DirectTransportOptions,
  ProxyTransportOptions,
  EventStreamOptions,
  RelayCoreState,
} from "./transport";

export { claimPairing, claimFirstReachable } from "./pairing";
export type { ClaimOptions, PairedConnection } from "./pairing";
export {
  buildPairingUrl,
  pairingUrlFromEndpoints,
  parsePairingUrl,
  candidateBaseUrls,
  claimBaseUrls,
  PAIRING_URL_SCHEME,
  PAIRING_URL_PREFIX,
} from "@fabdesk/protocol";
export type { PairingPayload } from "@fabdesk/protocol";

export {
  handleCoreEvent,
  appendDelta,
  appendPart,
  messagesKey,
  patchThreadCaches,
  syncLiveRuns,
  EVENT_TOPICS,
} from "./events";
export type { HandlerCtx, RouteSink } from "./events";

export {
  CoreProvider,
  useCore,
  useCoreClient,
  useCoreEvents,
  nullHost,
  resyncOnStatus,
} from "./provider";
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

export { groupThreadsByProject, sidebarSections } from "./group-threads";
export type { ProjectThreadGroup, ProjectThreadGroupKind } from "./group-threads";
export { pickerModelChoices, agentModelLabel } from "./agent-model-choices";

export * from "./queries";

/** Route Cinema: the pure painter and the live-frame hub (`packages/client-core/src/cinema`). */
export * from "./cinema";

export {
  groupByDestination,
  filterShoppingItems,
  createShoppingDraft,
  shoppingDraftPatch,
  shoppingDraftConflicts,
  rebaseShoppingDraft,
  type ShoppingItemDraft,
  itemLabel,
  destinationOptions,
  isCloudSignedOut,
  cloudErrorMessage,
} from "./shopping";
export type { DestinationGroup } from "./shopping";
export { SLASH_COMMANDS, expandSlashCommand, isFinishItCommand, slashSuggestions } from "./slash-commands";
export type { SlashCommand } from "./slash-commands";

export { CadSession, type CadSessionState } from "./cad-session";
export {
  DEFAULT_LASER_STENCIL_PRESET,
  LASER_STENCIL_PRESET_IDS,
  LASER_STENCIL_UI_PRESETS,
  laserStencilFormDefaults,
  parseLaserNumber,
} from "./laser-stencil-presets";
export type { LaserStencilPresetId, LaserStencilUiPreset } from "./laser-stencil-presets";

export {
  reduceVoice,
  voiceBusy,
  voiceDraft,
  DEFAULT_VOICE_STATE,
  VOICE_PHASES,
} from "./speech/composer-state";
export type { VoiceEvent, VoicePhase, VoiceState, VoiceMode, VoiceErrorKind } from "./speech/composer-state";
export {
  parseVoiceShortcut,
  formatVoiceShortcut,
  matchVoiceShortcut,
  releasesVoiceShortcut,
  DEFAULT_VOICE_SHORTCUT,
} from "./speech/shortcut";
export type { VoiceShortcut } from "./speech/shortcut";

export { DRAFT_KEY_NEW, newChatDraftKey, createSketchDraftSession, editableSketchPaths, projectSketchImagePaths } from "./sketch-drafts";
export { WORKSPACE_AREAS, workspaceAreaForView, workspaceViews } from "./workspace-navigation";
export type { WorkspaceArea, WorkspaceView } from "./workspace-navigation";

export * from "./pcb-preview-revision";

export * from "./model-import";

export * from "./enclosure-revision";

export * from "./pcb-parts";

export { parsePcbOutlineInspection, inspectPcbOutline, resizedOutlinePoints } from "./pcb-outline";

export { usePcbOutline } from "./queries";

export { inspectPcbCheckRevision, type PcbCheckRevisionState } from "./check-revision";
export { usePcbCheckRevision } from "./queries";

export { snapNativePoint, nudgeNativePoint } from "./native-target";

export * from "./board-model-revision";
export { useBoardModelRevision } from "./queries";

export * from "./output-library";

export * from "./assembly-scene";
export * from "./sketch-recovery";

export * from "./assembly-review";

export * from "./assembly-checks";
export * from "./check-findings";
export { useAssemblyPcbCheck } from "./queries";

export * from "./assembly-check-summary";
export { useAssemblyCheckSummaries } from "./queries";

export * from "./assembly-check-finding";
export * from "./live-assembly-previews";
export * from "./assembly-board-model";
export * from "./model-camera";

export * from "./assembly-model-summary";
export { useAssemblyModelSummaries } from "./queries";

export * from "./assembly-schematic-inspection";

export * from "./assembly-schematic-preview";
export { useAssemblySchematicPreview } from "./queries";
export { enclosureSizeLabel } from "./enclosure-display";
export { loadBoardArtwork, saveBoardArtwork, createArtworkSessionStore, artworkSessions, type ArtworkSessionDraft } from "./board-artwork";
