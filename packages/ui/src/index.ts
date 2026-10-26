/**
 * The desktop UI. Transport, queries, stores and the event reducer live in `@fabdesk/client-core`
 * and are re-exported here so renderer code (and the automation API) keeps one import site.
 */
export {
  CoreClient,
  CoreHttpError,
  parseJsonl,
  subscribeSse,
  subscribeWs,
  reconnectDelay,
  appendLastEventId,
  parseCoreEvent,
  useCore,
  useCoreClient,
  useCoreEvents,
  handleCoreEvent,
  appendDelta,
  appendPart,
  EVENT_TOPICS,
  messagesKey,
  DirectTransport,
  buildPairingUrl,
  parsePairingUrl,
  candidateBaseUrls,
  claimPairing,
  claimFirstReachable,
} from "@fabdesk/client-core";
export type {
  CoreClientOptions,
  CreateThreadInput,
  PatchThreadInput,
  SendMessageInput,
  ToolCallResponse,
  FetchLike,
  EventSourceLike,
  EventSourceFactory,
  SseStatus,
  SseSubscription,
  SseOptions,
  HostAdapter,
  FilePickOptions,
  CoreContextValue,
  CoreTransport,
  RouteSink,
  PairingPayload,
} from "@fabdesk/client-core";
export { CoreProvider } from "./core/CoreProvider";
export type { CoreProviderProps } from "./core/CoreProvider";
export { browserHost } from "./core/host";

export { useUiStore, BOARD_TABS, BOARD_TAB_LABELS, DRAFT_KEY_NEW, SIDEBAR_LIST_TABS, SIDEBAR_LIST_TAB_LABELS, normalizeSidebarListTab } from "./stores/ui";
export type { BoardTab, SidebarListTab, UiState, PendingAttachment } from "./stores/ui";
export { useCinemaStore } from "./stores/cinema";
export type { CinemaState } from "./stores/cinema";
export { useAuthStore, useRunsStore } from "@fabdesk/client-core";
export type { LiveRun, LiveJob } from "@fabdesk/client-core";

export * from "./board/cinema/renderer";
export { CinemaTab } from "./board/cinema/CinemaTab";
export { BoardPanel } from "./board/BoardPanel";
export { SvgTab } from "./board/SvgTab";
export { SvgViewer } from "./board/SvgViewer";
export { DrcTab, normalizeReport } from "./board/DrcTab";
export { RendersTab } from "./board/RendersTab";
export { FilesTab } from "./board/FilesTab";
export { NotesTab } from "./board/NotesTab";
export { parseSvgViewBox, clientPointToSvg, svgPointToPercent } from "./board/svg-coords";
export { ArtTab } from "./board/ArtTab";
export { ThreeDTab } from "./board/ThreeDTab";
export { useRunTool, resolveToolName, TOOL_PATTERNS } from "@fabdesk/client-core";

export { AppShell } from "./layout/AppShell";
export { TopBar } from "./layout/TopBar";
export { ThreadSidebar } from "./sidebar/ThreadSidebar";
export { OpenSourceList } from "./sidebar/OpenSourceList";
export { groupThreadsByProject } from "@fabdesk/client-core";
export type { ProjectThreadGroup, ProjectThreadGroupKind } from "@fabdesk/client-core";
export { OpenSourceView } from "./opensource/OpenSourceView";
export { InventoryView } from "./inventory/InventoryView";
export { ShoppingListTab } from "./board/ShoppingListTab";
export { ProjectBomPanel } from "./board/ProjectBomPanel";
export { CatalogThumb } from "./opensource/CatalogThumb";
export { OrderFlow } from "./order/OrderFlow";
export { ProjectPickerDialog } from "./chat/ProjectPickerDialog";
export { ThreadView } from "./chat/ThreadView";
export { MessageList, MessageBubble, BranchHeader } from "./chat/MessageList";
export { Composer, composerHandlers } from "./chat/Composer";
export { FinishItPanel } from "./chat/FinishItPanel";
export { Markdown, CodeBlock } from "./chat/Markdown";
export { ToolCallCard, extractImages, resultText } from "./chat/ToolCallCard";
export { ThinkingBlock } from "./chat/ThinkingBlock";
export { ProjectImage } from "./chat/ProjectImage";
export { ProjectVideo } from "./chat/ProjectVideo";
export { SketchPad } from "./sketch/SketchPad";
export { CommandPalette } from "./palette/CommandPalette";
export { SettingsDialog } from "./settings/SettingsDialog";
export { LoginScreen } from "./auth/LoginScreen";

export * from "@fabdesk/client-core";
export { useProjectBlobUrl } from "./hooks/queries";
export { useBranchThread } from "./hooks/threadActions";
export { useShortcuts, shortcutList } from "./hooks/useShortcuts";
export {
  useTheme,
  useIsDark,
  applyTheme,
  applyThemeId,
  themeFromPreference,
  isThemeId,
  resolveThemeId,
  parsePersistedThemeId,
  THEME_IDS,
  THEME_LABELS,
  UI_THEME_STORAGE_KEY,
} from "./hooks/useTheme";
export type { ThemeId, ThemePreference } from "./hooks/useTheme";
export { themeBackground, bootstrapTheme } from "./theme/resolve";
export { themeBootInlineCss, themeBootInlineScript } from "./theme/boot-inline";
export * from "./components/ui";
export * from "./util";

export { FabdeskApp } from "./app/FabdeskApp";
export type { FabdeskAppProps } from "./app/FabdeskApp";
export { CoreStatusScreen } from "./app/CoreStatusScreen";
export { useAppActions } from "./app/useAppActions";
export type { AppActions } from "./app/useAppActions";
export type { CoreState, CoreStatusInfo, CoreInfo } from "./app/types";
export { UpdateBadge } from "./components/UpdateBadge";

// Hosted web pairing (docs/mobile.md, "Pairing a browser"): the /pair route and the saved computers.
export { BrowserApp } from "./app/BrowserApp";
export { PairRoute } from "./pair/PairRoute";
export { ComputersPanel, ComputersDialog, ComputersScreen } from "./pair/ComputersPanel";
export { useSavedHosts, activeSavedHost, watchSavedHosts } from "./pair/store";
export { parsePairLink, buildPairLink, isPairPath, normalizeHost, browserLabel } from "./pair/parse";
export type { PairLink, PairLinkFailure, PairLocation } from "./pair/parse";
export type { SavedHost, SavedHosts } from "./pair/hosts";
