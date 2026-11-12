import { ContributionReceipt } from "./board-contributions";
import { WorkspaceContext } from "./workspace-context";
/** Control API DTOs shared by core routes and the renderer client. */
import { z } from "zod/v4";
import { CoreEndpoint, EndpointKind, TailscaleState } from "./devices";
import {
  AgentId,
  ApprovalDecision,
  JobStatus,
  MessagePart,
  Principal,
  type ApprovalRequestedEvent,
  type InputRequestedEvent,
} from "./events";

export const ProjectId = z.string().min(1);

/** Explicit composer choice, saved atomically as the defaults for future chats. */
export const AgentPreference = z.object({
  agentId: AgentId,
  model: z.string().nullable(),
});
export type AgentPreference = z.infer<typeof AgentPreference>;

/** Default port for the daemon's opt-in remote listener (see docs/mobile.md). */
export const REMOTE_DEFAULT_PORT = 47820;

/** Routing rules a board import carries over (KiCad netclass "Default"); all in millimetres. */
export const BoardRules = z.object({
  traceWidthMm: z.number().positive().optional(),
  clearanceMm: z.number().nonnegative().optional(),
  viaDrillMm: z.number().positive().optional(),
  viaDiameterMm: z.number().positive().optional(),
});
export type BoardRules = z.infer<typeof BoardRules>;

/** Prefabricated blanks a design is laid out on; `viagrid-9055` is Opulo's 90 x 55 mm Viagrid (180 fixed vias). */
export const BoardTemplate = z.enum(["viagrid-9055"]);
export type BoardTemplate = z.infer<typeof BoardTemplate>;

export const BoardSettings = z.object({
  layers: z.number().int().min(1).max(8).default(2),
  widthMm: z.number().positive().optional(),
  heightMm: z.number().positive().optional(),
  rules: BoardRules.optional(),
  /** When set, the blank's fixed vias are the only vias allowed: routing uses the laser-prefab solver and claims them. */
  template: BoardTemplate.optional(),
});

export const ProjectManifest = z.object({
  schema: z.literal(1),
  id: ProjectId,
  name: z.string().min(1),
  /** Planning workspace: engineering tools stay locked until explicit promotion. */
  ideaDraft: z.object({ requestedBuild: z.string().max(12000).optional() }).optional(),
  promotedAt: z.string().datetime().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  board: BoardSettings,
  /** Local base revisions for explicit per-board cloud publication. */
  contributions: z.record(z.string(), ContributionReceipt).optional(),
  /** Present only for a separate copy downloaded from a shared board. */
  contributionSource: ContributionReceipt.optional(),
  /** Historical import selection, not a claim that the editable working board remains unchanged. */
  importedBoard: z.object({
    path: z.string().min(1),
    adoptedAt: z.string(),
    pcbSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  /** Omitted selects Freerouting with automatic fab_router fallback. `capacity` is a legacy fab_router alias. */
  router: z.enum(["fab_router", "capacity", "freerouting", "tracemaker"]).optional(),
  agent: z.object({ lastUsed: AgentId.optional() }).default({}),
  allowedDrcWarnings: z.array(z.string()).default([]),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

export const ProjectSummary = z.object({
  id: ProjectId,
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const FileEntry = z.object({
  path: z.string(),
  size: z.number().int(),
  mtime: z.string(),
  /** Completed exporter receipt time, only when its artifact hash still matches. Not source freshness. */
  generatedAt: z.string().datetime().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const ProjectDetail = ProjectSummary.extend({
  manifest: ProjectManifest,
  files: z.array(FileEntry),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const CreateProject = z.object({ name: z.string().min(1).max(80), parentDirectory: z.string().min(1).optional(), draft: z.boolean().optional() });

/**
 * `full`: the agent runs with the permission mode from Settings. `supervised`: the daemon pauses
 * every tool call it classifies as a write until a human approves it (desktop or phone).
 */
export const RuntimeMode = z.enum(["full", "supervised"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export const Thread = z.object({
  id: z.string(),
  projectId: ProjectId.nullable(),
  folderId: z.string().nullable(),
  title: z.string(),
  /** Local-first flag persisted in fabdesk-core SQLite. Not synced to fabplane.com. */
  pinned: z.boolean(),
  archived: z.boolean(),
  agentId: AgentId,
  model: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  branchFromMessageId: z.string().nullable(),
  /** Always set by the daemon; optional in the type so older fixtures and clients still compile (absent = `full`). */
  runtimeMode: RuntimeMode.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Thread = z.infer<typeof Thread>;

export const CreateThread = z.object({
  projectId: ProjectId.nullable().optional(),
  title: z.string().optional(),
  agentId: AgentId,
  model: z.string().optional(),
  parentThreadId: z.string().optional(),
  branchFromMessageId: z.string().optional(),
  runtimeMode: RuntimeMode.optional(),
});

export const PatchThread = z.object({
  title: z.string().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  folderId: z.string().nullable().optional(),
  agentId: AgentId.optional(),
  model: z.string().nullable().optional(),
  runtimeMode: RuntimeMode.optional(),
});

/** Requests still waiting on a human, as `GET /threads/:id` reports them (`pending`). */
export const PendingRequests = z.object({
  approvals: z.array(z.custom<ApprovalRequestedEvent>()),
  inputs: z.array(z.custom<InputRequestedEvent>()),
});
export type PendingRequests = z.infer<typeof PendingRequests>;

export const ResolveApproval = z.object({ decision: ApprovalDecision });
export const ResolveInput = z.object({ answer: z.string() });

export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  contentMd: z.string(),
  parts: z.array(MessagePart),
  runId: z.string().nullable(),
  /** `queued`: a user message waiting for the live run to end before it is sent (absent = sent). */
  status: z.enum(["queued"]).optional(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

export const Attachment = z.object({ path: z.string(), mime: z.string() });

export const SendMessage = z.object({
  workspaceContext: WorkspaceContext.optional(),
  content: z.string().min(1),
  attachments: z.array(Attachment).default([]),
  agentId: AgentId.optional(),
  model: z.string().optional(),
  /** With a run live, store the message and send it when the run ends (`?queue=1` does the same). */
  queue: z.boolean().optional(),
});

export const Run = z.object({
  id: z.string(),
  threadId: z.string(),
  agentId: AgentId,
  agentSessionId: z.string().nullable(),
  status: z.enum(["running", "completed", "aborted", "failed"]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
});
export type Run = z.infer<typeof Run>;

export const Job = z.object({
  id: z.string(),
  kind: z.string(),
  projectId: ProjectId.nullable(),
  status: JobStatus,
  progress: z.number().nullable(),
  note: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type Job = z.infer<typeof Job>;

export const ToolManifestEntry = z.object({
  name: z.string(),
  toolset: z.string(),
  title: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z.object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }),
  longRunning: z.boolean(),
});
export type ToolManifestEntry = z.infer<typeof ToolManifestEntry>;

export const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;
export const AgentEffortPreference = z.object({ agentId: AgentId, effort: ReasoningEffort.nullable() });
export type AgentEffortPreference = z.infer<typeof AgentEffortPreference>;

export const AgentInfo = z.object({
  id: AgentId,
  displayName: z.string(),
  installed: z.boolean(),
  version: z.string().optional(),
  path: z.string().optional(),
  installHint: z.string(),
  models: z.array(z.string()),
  /** Versioned IDs reported by the installed CLI for selectable aliases. */
  modelAliases: z.record(z.string(), z.string()).optional(),
  /** Resolved CLI default, for display; absence means the version is unknown. */
  defaultModel: z.string().optional(),
  /** Effort levels advertised by the installed agent, keyed by model ID or alias. */
  modelEfforts: z.record(z.string(), z.array(ReasoningEffort)).optional(),
  /** Whether the adapter can pause a tool call for approval (`runtimeMode: "supervised"`). Absent = no. */
  supportsSupervised: z.boolean().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const DoctorReport = z.object({
  version: z.string(),
  channel: z.enum(["public", "internal"]),
  bun: z.string(),
  platform: z.string(),
  kicad: z.object({
    found: z.boolean(),
    path: z.string().optional(),
    version: z.string().optional(),
  }),
  ngspice: z.object({ found: z.boolean(), path: z.string().optional() }),
  routers: z.array(
    z.object({ id: z.string(), present: z.boolean(), ready: z.boolean(), detail: z.string() }),
  ),
  agents: z.array(AgentInfo),
  warnings: z.array(z.string()),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const Settings = z.object({
  kicadCliPath: z.string().nullable().default(null),
  ngspicePath: z.string().nullable().default(null),
  /** FabPlane PCB bridge origin, e.g. `http://127.0.0.1:4020`; null means the default. Env `FABDESK_FP_PCB_BRIDGE_URL` overrides. */
  fpPcbBridgeUrl: z.string().nullable().default(null),
  /** Deprecated storage compatibility only; unused by routing. Do not start reading this — existing DBs default to fab_router. */
  router: z.enum(["fab_router", "capacity", "freerouting"]).default("fab_router"),
  /**
   * User-chosen default from Settings → Routers. Omitted keeps today's unpinned path
   * (Freerouting with automatic fab_router fallback).
   */
  preferredRouter: z.enum(["fab_router", "freerouting", "tracemaker"]).nullable().optional(),
  /**
   * HTTPS URL of the weekly TraceMaker binary `manifest.json`. Null uses
   * `https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json`.
   * Env `FABDESK_TRACEMAKER_MANIFEST_URL` overrides this.
   */
  tracemakerManifestUrl: z.string().nullable().default(null),
  /**
   * A KiCadRoutingTools build to use instead of the one Settings → Routers installs (a folder with
   * `src/plugins` and `venv`). Null uses env `FABDESK_KRT_DIR`, then the installed copy.
   */
  krtDir: z.string().nullable().default(null),
  /**
   * Board tools install a missing engine (KiCadRoutingTools, TraceMaker) on first use. False makes them report it
   * instead; `board_engines install` and Settings → Routers still install on request.
   */
  autoInstallEngines: z.boolean().default(true),
  defaultAgent: AgentId.default("claude"),
  /** Runtime mode new threads start in. */
  defaultRuntimeMode: RuntimeMode.default("full"),
  agents: z
    .record(
      z.string(),
      z.object({
        binaryPath: z.string().nullable().default(null),
        model: z.string().nullable().default(null),
        /** Remembered across chats; null/unset leaves effort to the agent. */
        effort: ReasoningEffort.nullable().optional(),
        permissionMode: z.enum(["acceptEdits", "auto", "bypass"]).default("acceptEdits"),
        extraAllowedTools: z.array(z.string()).default([]),
        /** Models offered in the composer's agent/model dropdown; empty shows the adapter's first three. */
        pickerModels: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  keepCoreRunning: z.boolean().default(false),
  /**
   * Finish it judges a project with a placed board by the board workflow (A1-A9, the review gate, the board tools in
   * the prompt). Absent or true: on. False keeps the DRC/ERC plan for every project.
   */
  boardChecksInFinishIt: z.boolean().optional(),
  webmcpWriteTools: z.boolean().default(false),
  /** Send crash/error reports to Sentry (only when a DSN is configured; see docs/sentry.md). */
  errorReporting: z.boolean().default(true),
  /**
   * Local, installation-wide consent to back up stored conversations and tool traces for analysis.
   * Only meaningful once `usageArchiveChoiceComplete` is set; read it through `usageArchiveAllowed`.
   */
  usageArchiveConsent: z.boolean().default(false),
  /** The person has explicitly chosen (first-install screen or Settings → Privacy). */
  usageArchiveChoiceComplete: z.boolean().default(false),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  /** Opt-in second listener on a tailnet/LAN address so paired phones can reach the daemon. */
  remote: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default("0.0.0.0"),
      port: z.number().int().min(1).max(65535).default(REMOTE_DEFAULT_PORT),
      /** Which endpoint kind the pairing QR lists first. Unset (or null) picks tailscale, then LAN, then the rest. */
      preferredEndpointKind: EndpointKind.nullable().optional(),
      /**
       * Whether the daemon dials out to a relay (`apps/relay`) so a phone off the tailnet can
       * still reach it. Absent means `auto`: the link comes up whenever remote access is on and
       * the daemon is signed in to fabplane. `off` never dials.
       */
      relay: z.enum(["auto", "off"]).optional(),
      /**
       * Explicit relay override, e.g. `https://relay.fabplane.com`. Unset, null or empty means
       * the default, derived from the fabplane API origin (`FABPLANE_RELAY_URL` overrides that).
       */
      relayUrl: z.string().trim().nullable().optional(),
    })
    .default({ enabled: false, host: "0.0.0.0", port: REMOTE_DEFAULT_PORT }),
  /** Daemon-wide kill switch for push notifications to paired phones (docs/mobile-notifications.md §4.1). */
  notifications: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /** fabplane.com org whose carts and inventory fabdesk uses; null means the caller's personal org. */
  cloudOrgId: z.string().nullable().default(null),
  /**
   * Speak-to-the-agent prefs. The cloud speech key is stored separately in the daemon and is
   * never returned here. Audio is used only while the person is speaking and is not kept after
   * the transcript is ready.
   */
  voice: z
    .object({
      /** `auto` uses on-device speech in the app when it produces a transcript; otherwise a cloud key, then a local model. */
      provider: z.enum(["auto", "on_device", "cloud", "local"]).default("auto"),
      /** BCP-47-ish language tag the provider should prefer (`en`, `en-US`, `de`). */
      language: z.string().min(2).max(16).default("en"),
      /** Hold the shortcut to talk, or tap it to start/stop. */
      pushToTalkMode: z.enum(["hold", "toggle"]).default("hold"),
      /** Modifier+key, e.g. `Alt+Space`. Parsed by the desktop composer. */
      pushToTalkShortcut: z.string().min(1).max(40).default("Alt+Space"),
    })
    .default({
      provider: "auto",
      language: "en",
      pushToTalkMode: "hold",
      pushToTalkShortcut: "Alt+Space",
    }),
});
export type Settings = z.infer<typeof Settings>;
export type VoiceSettings = Settings["voice"];
export type VoiceProviderId = VoiceSettings["provider"];

export const PrivacyScreenMode = z.enum(["auto", "always", "never"]);
export type PrivacyScreenMode = z.infer<typeof PrivacyScreenMode>;

/**
 * Who sees the first-install privacy screen: `auto` (the default) asks only where
 * `detectConsentRegion` places the installation in the EU/EEA, UK or Switzerland and backs up
 * everyone else by default; `always` asks every undecided installation before anything is backed
 * up; `never` skips it. The core's `FABDESK_PRIVACY_SCREEN` env var overrides this at run time.
 */
export const FIRST_INSTALL_PRIVACY_SCREEN: PrivacyScreenMode = "auto";

/** `GET /privacy`: the core's decision, so every client gates on the same answer the uploader uses. */
export const PrivacyStatus = z.object({
  mode: PrivacyScreenMode,
  /** Undecided installations must answer the screen before anything is backed up. */
  firstInstallScreen: z.boolean(),
  region: z.object({
    likelyInRegion: z.boolean(),
    signal: z.enum(["time-zone", "locale", "remembered"]).nullable(),
    country: z.string().nullable(),
  }),
});
export type PrivacyStatus = z.infer<typeof PrivacyStatus>;

type UsageArchiveChoice = Pick<Settings, "usageArchiveConsent" | "usageArchiveChoiceComplete">;

/**
 * Effective usage-data backup consent. A saved choice always wins; otherwise backup is on unless
 * this installation gets the first-install screen, in which case it waits for an answer.
 */
export function usageArchiveAllowed(settings: UsageArchiveChoice, privacyScreen: boolean): boolean {
  if (settings.usageArchiveChoiceComplete) return settings.usageArchiveConsent;
  return !privacyScreen;
}

/** Records an explicit usage-data backup choice so it is never replaced by the default. */
export function usageArchiveChoice(consent: boolean): UsageArchiveChoice {
  return { usageArchiveConsent: consent, usageArchiveChoiceComplete: true };
}

/**
 * Portable preferences stored on the fabplane.com account (`GET`/`PUT /v1/private/settings`).
 * Machine-local fields (binary paths, remote listener, keep-core-running) stay on the daemon.
 * Last-write-wins by `updatedAt` (unix ms). Unknown keys are stripped so clients can evolve.
 *
 * Kept in step with fabplane.com `user_settings.payload` — that API copies this shape, it does
 * not import this package.
 */
export const CloudSettings = z.object({
  schema: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  appearance: z.enum(["system", "light", "dark"]).optional(),
  haptics: z.boolean().optional(),
  keepAwake: z.boolean().optional(),
  defaultAgent: AgentId.optional(),
  defaultRuntimeMode: RuntimeMode.optional(),
  errorReporting: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
});
export type CloudSettings = z.infer<typeof CloudSettings>;

/**
 * The relay link as `GET /v1/remote` reports it. `connected` false with no `error` means the
 * daemon is dialing (or waiting to redial); `error` names what stops it from dialing at all
 * ("not signed in", "remote access is off", no relay for this API origin, a bad URL). `lastError`
 * is the most recent socket failure and survives a reconnect, so a flapping link is visible.
 */
export const RelayStatus = z.object({
  connected: z.boolean(),
  /** The relay in use (or wanted): the setting, else the default derived from the API origin. Empty when none is known. */
  url: z.string(),
  /** When `connected` last changed (ISO). */
  since: z.string().optional(),
  error: z.string().optional(),
  lastError: z.string().optional(),
});
export type RelayStatus = z.infer<typeof RelayStatus>;

/** `GET /v1/remote`: what the listener is really bound to, the setting behind it, and the addresses a phone would be offered. */
export const RemoteStatus = z.object({
  enabled: z.boolean(),
  host: z.string().optional(),
  port: z.number().optional(),
  setting: Settings.shape.remote,
  /** Ordered as the pairing URL would list them, `default` on the first. Empty when nothing is reachable. */
  endpoints: z.array(CoreEndpoint),
  /** `null` without a Tailscale CLI; absent from daemons that predate it. */
  tailscale: TailscaleState.nullable().optional(),
  /** The relay link (`apps/relay`): `null` when `remote.relay` is `off`; absent from older daemons. */
  relay: RelayStatus.nullable().optional(),
});
export type RemoteStatus = z.infer<typeof RemoteStatus>;

/** Where the relay link stands: connected, or dialing, or blocked (with `error` saying why). */
export const RelayPhase = z.enum(["connected", "connecting", "off"]);
export type RelayPhase = z.infer<typeof RelayPhase>;

/** `GET /health`: unauthenticated, so it carries nothing a stranger could use. */
export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  pid: z.number().int(),
  channel: z.enum(["public", "internal"]),
  authMode: z.enum(["fabplane", "local"]),
  uptimeMs: z.number(),
  mcpSessions: z.number().int(),
  /** Stable daemon identity, minted once (docs/mobile-notifications.md §4.4). */
  coreId: z.string(),
  /** The relay link, without the URL or the reason (this route is unauthenticated). Absent from older daemons. */
  relay: RelayPhase.optional(),
});
export type Health = z.infer<typeof Health>;

export const Me = z.object({
  principal: Principal.nullable(),
  mode: z.enum(["fabplane", "local"]),
});
export type Me = z.infer<typeof Me>;

export const StartFinishIt = z.object({
  threadId: z.string().optional(),
  agentId: AgentId.optional(),
  model: z.string().optional(),
});
export type StartFinishIt = z.infer<typeof StartFinishIt>;
