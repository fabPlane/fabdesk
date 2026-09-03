/** Control API DTOs shared by core routes and the renderer client. */
import { z } from "zod/v4";
import { AgentId, JobStatus, MessagePart, Principal } from "./events";

export const ProjectId = z.string().min(1);

/** Routing rules a board import carries over (KiCad netclass "Default"); all in millimetres. */
export const BoardRules = z.object({
  traceWidthMm: z.number().positive().optional(),
  clearanceMm: z.number().nonnegative().optional(),
  viaDrillMm: z.number().positive().optional(),
  viaDiameterMm: z.number().positive().optional(),
});
export type BoardRules = z.infer<typeof BoardRules>;

export const BoardSettings = z.object({
  layers: z.number().int().min(1).max(8).default(2),
  widthMm: z.number().positive().optional(),
  heightMm: z.number().positive().optional(),
  rules: BoardRules.optional(),
});

export const ProjectManifest = z.object({
  schema: z.literal(1),
  id: ProjectId,
  name: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  board: BoardSettings,
  router: z.enum(["capacity", "freerouting"]).default("capacity"),
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
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const FileEntry = z.object({
  path: z.string(),
  size: z.number().int(),
  mtime: z.string(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const ProjectDetail = ProjectSummary.extend({
  manifest: ProjectManifest,
  files: z.array(FileEntry),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

export const CreateProject = z.object({ name: z.string().min(1).max(80) });

export const Thread = z.object({
  id: z.string(),
  projectId: ProjectId.nullable(),
  folderId: z.string().nullable(),
  title: z.string(),
  pinned: z.boolean(),
  archived: z.boolean(),
  agentId: AgentId,
  model: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  branchFromMessageId: z.string().nullable(),
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
});

export const PatchThread = z.object({
  title: z.string().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  folderId: z.string().nullable().optional(),
  agentId: AgentId.optional(),
  model: z.string().nullable().optional(),
});

export const Message = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  contentMd: z.string(),
  parts: z.array(MessagePart),
  runId: z.string().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

export const Attachment = z.object({ path: z.string(), mime: z.string() });

export const SendMessage = z.object({
  content: z.string().min(1),
  attachments: z.array(Attachment).default([]),
  agentId: AgentId.optional(),
  model: z.string().optional(),
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

export const AgentInfo = z.object({
  id: AgentId,
  displayName: z.string(),
  installed: z.boolean(),
  version: z.string().optional(),
  path: z.string().optional(),
  installHint: z.string(),
  models: z.array(z.string()),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const DoctorReport = z.object({
  version: z.string(),
  channel: z.enum(["public", "internal"]),
  bun: z.string(),
  platform: z.string(),
  kicad: z.object({ found: z.boolean(), path: z.string().optional(), version: z.string().optional() }),
  ngspice: z.object({ found: z.boolean(), path: z.string().optional() }),
  routers: z.array(z.object({ id: z.string(), present: z.boolean(), ready: z.boolean(), detail: z.string() })),
  agents: z.array(AgentInfo),
  warnings: z.array(z.string()),
});
export type DoctorReport = z.infer<typeof DoctorReport>;

export const Settings = z.object({
  kicadCliPath: z.string().nullable().default(null),
  ngspicePath: z.string().nullable().default(null),
  router: z.enum(["capacity", "freerouting"]).default("capacity"),
  defaultAgent: AgentId.default("claude"),
  agents: z
    .record(
      z.string(),
      z.object({
        binaryPath: z.string().nullable().default(null),
        model: z.string().nullable().default(null),
        permissionMode: z.enum(["acceptEdits", "auto", "bypass"]).default("acceptEdits"),
        extraAllowedTools: z.array(z.string()).default([]),
        /** Models offered in the composer's agent/model dropdown; empty shows the adapter's first three. */
        pickerModels: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  keepCoreRunning: z.boolean().default(false),
  webmcpWriteTools: z.boolean().default(false),
  /** Send crash/error reports to Sentry (only when a DSN is configured; see docs/sentry.md). */
  errorReporting: z.boolean().default(true),
  theme: z.enum(["system", "light", "dark"]).default("system"),
});
export type Settings = z.infer<typeof Settings>;

export const Me = z.object({ principal: Principal.nullable(), mode: z.enum(["fabplane", "local"]) });
export type Me = z.infer<typeof Me>;
