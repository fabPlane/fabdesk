/**
 * Platform-agnostic fabPlane client: transport, the typed core API, the event reducer and the
 * react-query/zustand layer. Shared by the Electron renderer (`@fabdesk/ui`) and the mobile app.
 * Nothing here may touch the DOM — `document`, `window`, `localStorage` and friends belong to the
 * view packages.
 */
export { acceptAuthSnapshot,cloudAccountId,hasFabplaneSession } from "./auth-cache";
export { deduplicateChatNotices } from "./chat-notices";
export { CoreClient,CoreHttpError,parseJsonl } from "./CoreClient";
export type {
CoreClientOptions,CreateThreadInput,DeviceMe,DevicePushPrefs,
DevicePushRegistration,
DevicePushState,FetchLike,LiveRunSummary,PatchThreadInput,
SendMessageInput,ThreadDetail,ToolCallResponse
} from "./CoreClient";
export { activeQuestion,draftConversation,draftWorkspaceTitle } from "./draft-navigation";
export { agentErrorText,errorHelp,errorMessage,errorPayload,splitAgentError } from "./error-help";
export type { ErrorAction,ErrorContext,ErrorHelp } from "./error-help";
export { nativeSourceCandidates } from "./native-source-candidates";
export { useProjectStatus } from "./queries";

export {
EVENT_SOURCE_CLOSED,appendLastEventId,
parseCoreEvent,reconnectDelay,subscribeSse
} from "./sse";
export type {
EventSourceFactory,EventSourceLike,SseOptions,SseStatus,
SseSubscription
} from "./sse";
export { parseWsFrame,subscribeWs } from "./ws";
export type { WebSocketFactory,WebSocketLike,WsOptions } from "./ws";

export {
CoreOfflineError,DirectTransport,
ProxyTransport,RELAY_CLOSE_CORE_OFFLINE,isCoreOffline,relayBaseUrl,relaySaysCoreOffline
} from "./transport";
export type {
CoreTransport,DirectTransportOptions,EventStreamOptions,ProxyTransportOptions,RelayCoreState,TransportKind
} from "./transport";

export {
PAIRING_URL_PREFIX,PAIRING_URL_SCHEME,buildPairingUrl,candidateBaseUrls,
claimBaseUrls,pairingUrlFromEndpoints,
parsePairingUrl
} from "@fabdesk/protocol";
export type { PairingPayload } from "@fabdesk/protocol";
export { claimFirstReachable,claimPairing } from "./pairing";
export type { ClaimOptions,PairedConnection } from "./pairing";

export {
EVENT_TOPICS,appendDelta,
appendPart,handleCoreEvent,messagesKey,
patchThreadCaches,
syncLiveRuns
} from "./events";
export type { HandlerCtx,RouteSink } from "./events";

export {
CoreProvider,nullHost,
resyncOnStatus,useCore,
useCoreClient,
useCoreEvents
} from "./provider";
export type {
CoreContextValue,CoreEventSubscribe,CoreProviderProps,FilePickOptions,HostAdapter
} from "./provider";

export { useAuthStore } from "./stores/auth";
export type { AuthStoreState } from "./stores/auth";
export { useRunsStore } from "./stores/runs";
export type { LiveJob,LiveRun } from "./stores/runs";

export { exportGerberPackage,gerberPackageFilename } from "./manufacturing-package";
export { TOOL_PATTERNS,resolveToolName,useRunTool } from "./tools";
export type { ToolKind,ToolRunState } from "./tools";

export { agentModelLabel,pickerModelChoices } from "./agent-model-choices";
export { groupThreadsByProject,searchProjectGroups,sidebarSections } from "./group-threads";
export type { ProjectThreadGroup,ProjectThreadGroupKind } from "./group-threads";

export * from "./queries";
export * from "./route-review";

/** Route Cinema: the pure painter and the live-frame hub (`packages/client-core/src/cinema`). */
export * from "./cinema";

export {
cloudErrorMessage,createShoppingDraft,destinationOptions,filterShoppingItems,groupByDestination,isCloudSignedOut,itemLabel,rebaseShoppingDraft,shoppingDraftConflicts,shoppingDraftPatch,type ShoppingItemDraft
} from "./shopping";
export type { DestinationGroup } from "./shopping";
export { SLASH_COMMANDS,expandSlashCommand,isFinishItCommand,slashSuggestions } from "./slash-commands";
export type { SlashCommand } from "./slash-commands";

export { CadSession,type CadSessionState } from "./cad-session";
export {
DEFAULT_LASER_STENCIL_PRESET,
LASER_STENCIL_PRESET_IDS,
LASER_STENCIL_UI_PRESETS,
laserStencilFormDefaults,
parseLaserNumber
} from "./laser-stencil-presets";
export type { LaserStencilPresetId,LaserStencilUiPreset } from "./laser-stencil-presets";

export {
DEFAULT_VOICE_STATE,
VOICE_PHASES,reduceVoice,
voiceBusy,
voiceDraft
} from "./speech/composer-state";
export type { VoiceErrorKind,VoiceEvent,VoiceMode,VoicePhase,VoiceState } from "./speech/composer-state";
export {
DEFAULT_VOICE_SHORTCUT,formatVoiceShortcut,
matchVoiceShortcut,parseVoiceShortcut,releasesVoiceShortcut
} from "./speech/shortcut";
export type { VoiceShortcut } from "./speech/shortcut";

export { DRAFT_KEY_NEW,createSketchDraftSession,editableSketchPaths,newChatDraftKey,projectSketchImagePaths } from "./sketch-drafts";
export { WORKSPACE_AREAS,workspaceAreaForView,workspaceTabForArea,workspaceViewSearchTerms,workspaceViews } from "./workspace-navigation";
export type { WorkspaceArea,WorkspaceView } from "./workspace-navigation";

export * from "./pcb-preview-revision";

export * from "./model-import";

export * from "./enclosure-revision";

export * from "./pcb-parts";

export { inspectPcbOutline,outlineDimensionInput,parsePcbOutlineInspection,resizedOutlinePoints } from "./pcb-outline";

export { usePcbOutline } from "./queries";

export { inspectPcbCheckRevision,type PcbCheckRevisionState } from "./check-revision";
export { usePcbCheckRevision } from "./queries";

export { nudgeNativePoint,snapNativePoint } from "./native-target";

export * from "./board-model-revision";
export { useBoardModelRevision } from "./queries";

export * from "./imported-boards";
export * from "./output-library";

export * from "./assembly-map-layout";
export * from "./assembly-scene";
export * from "./board-workspace";
export * from "./project-status-navigation";
export * from "./sketch-recovery";

export * from "./assembly-review";

export * from "./assembly-checks";
export * from "./check-findings";
export { useAssemblyPcbCheck } from "./queries";

export * from "./assembly-check-summary";
export { useAssemblyCheckSummaries } from "./queries";

export * from "./assembly-board-model";
export * from "./assembly-check-finding";
export * from "./live-assembly-previews";
export * from "./model-camera";

export * from "./assembly-model-summary";
export { useAssemblyModelSummaries } from "./queries";

export * from "./assembly-schematic-inspection";

export * from "./assembly-schematic-preview";
export { artworkSessions,createArtworkSessionStore,loadBoardArtwork,saveBoardArtwork,type ArtworkSessionDraft } from "./board-artwork";
export { enclosureSizeLabel } from "./enclosure-display";
export { useAssemblySchematicPreview,useRootSchematicPreview } from "./queries";

export { captureRootCheckFinding,rootCheckFindingRow,type RootCheckFinding } from "./root-check-finding";

export { useVideoInputRevision,useVideoInputRevisions } from "./queries";
export { inspectVideoInputRevision,videoInputsNeedReview,type VideoInputRevisionState } from "./video-input-revision";

export * from "./kept-output";

export * from "./board-file-destination";
export * from "./bom-origins";
export * from "./diff-preview";
export * from "./overview-images";
export * from "./project-activity";
export { refreshProjectPreviews } from "./refresh-project-previews";
export * from "./stable-project-blob";

export { OUTPUT_DOWNLOAD_LIMIT,readOutputSelection } from "./output-download";
export * from "./output-revision";
export { activeModelOutputJobs,jobIsActive,projectJobBoard,projectJobs,type ProjectJob } from "./project-jobs";
export { reviewPackageFiles,type ReviewPackageOptions } from "./review-package";

export * from "./enclosure-design";
export * from "./enclosure-history";
export * from "./enclosure-issue-navigation";
export * from "./enclosure-layout";
export * from "./enclosure-mounts";
export * from "./enclosure-openings";
export * from "./enclosure-pcb-edit";
export * from "./enclosure-readiness";
export * from "./enclosure-recovery";
export * from "./enclosure-review";
export * from "./enclosure-review-target";
export * from "./enclosure-setup";
export * from "./enclosure-workflow";
export * from "./mechanical";
export * from "./pcb-display";
export { PersistentDraft,localDraft } from "./persistent-draft";
export { schematicFocusChoicesFromResult,schematicFocusFilesMatch,schematicFocusFromResult,schematicFocusHierarchyMatches,schematicFocusScope } from "./schematic-focus";
export { recordWorkspaceHistory,sameWorkspaceLocation } from "./workspace-history";
export type { WorkspaceHistoryEntry } from "./workspace-history";

export * from "./working-design";
export { useAutomaticBoardViews } from "./automatic-board-views";
export { acknowledgeComposerDraft } from "./composer-acknowledgement";
export { DrawingViewportMemory, type DrawingViewport } from "./drawing-viewport";
export { PreviewInTrashError } from "./preview-refresh";
export { useLivePreview } from "./live-previews";
export type { PreviewKind, PreviewScope } from "./live-previews";
export { hitSelectionPart, partScopeKey, pcbSelectionParts, schematicSelectionParts, usePartSelection, type PartBox, type PartScope, type SelectablePart } from "./part-selection";
export { inspectSelectionIndex, type SelectionIndex } from "./part-selection-source";
export { summarizeRunWork } from "./run-work-summary";
