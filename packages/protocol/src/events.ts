import { SchematicFocus } from "./schematic-focus";
/** Event bus topics shared by core, renderer and CLI. Topic names are dotted; subscriptions glob. */
import { WorkspaceContext } from "./workspace-context";
import { z } from "zod/v4";
import { FinishItMilestoneId, FinishItSession } from "./finish-it";
import { RouteFrame, RouteMeta, RouteResult, RouteStatic } from "./route-frames";

export const AgentId = z.enum(["claude", "codex", "cursor", "grok"]);
export type AgentId = z.infer<typeof AgentId>;

export const MessagePart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace_context"), context: WorkspaceContext }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string(),
    output: z.unknown(),
    isError: z.boolean().optional(),
  }),
  z.object({ type: z.literal("image"), path: z.string(), mime: z.string() }),
  /**
   * Supervised runtime mode: a tool call the daemon paused for a human decision, and a question
   * the agent asked. Both are appended to the assistant message when requested and patched in
   * place when resolved, so the timeline shows them after a reload too.
   */
  z.object({
    type: z.literal("approval"),
    requestId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    summary: z.string(),
    decision: z.enum(["pending", "approve", "deny"]),
    /** Who settled it, once decided — the phone's card says "approved on desktop". */
    by: z.enum(["desktop", "device", "timeout"]).optional(),
  }),
  z.object({
    type: z.literal("question"),
    requestId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    answer: z.string().nullable(),
  }),
]);
export type MessagePart = z.infer<typeof MessagePart>;
export type ApprovalPart = Extract<MessagePart, { type: "approval" }>;
export type QuestionPart = Extract<MessagePart, { type: "question" }>;

export const ApprovalDecision = z.enum(["approve", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
/** Who settled an approval: a desktop/daemon-token client, a paired device, or the 30-minute timeout. */
export const ApprovalResolvedBy = z.enum(["desktop", "device", "timeout"]);
export type ApprovalResolvedBy = z.infer<typeof ApprovalResolvedBy>;

export const AuthMode = z.enum(["fabplane", "local"]);
export const AuthStatus = z.enum(["signed_out", "pending", "signed_in", "error"]);
export const Principal = z.object({
  subject: z.string(),
  handle: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().optional(),
});
export type Principal = z.infer<typeof Principal>;

export const AuthState = z.object({
  mode: AuthMode,
  status: AuthStatus,
  principal: Principal.optional(),
  pending: z
    .object({
      userCode: z.string(),
      verificationUri: z.string(),
      verificationUriComplete: z.string(),
      expiresAt: z.string(),
    })
    .optional(),
  error: z.string().optional(),
  /** fabplane dashboard root for the core's API origin (`https://app.fabplane.com/dashboard`). */
  dashboardUrl: z.string().optional(),
});
export type AuthState = z.infer<typeof AuthState>;

export const JobStatus = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

const base = { ts: z.number() };

export const CoreEvent = z.discriminatedUnion("topic", [
  z.object({ ...base, topic: z.literal("project.schematic_focus"), focus: SchematicFocus }),
  z.object({
    ...base,
    topic: z.literal("agent.started"),
    runId: z.string(),
    threadId: z.string(),
    agentId: AgentId,
  }),
  z.object({
    ...base,
    topic: z.literal("agent.delta"),
    runId: z.string(),
    messageId: z.string(),
    part: z.enum(["text", "thinking"]),
    delta: z.string(),
  }),
  z.object({
    ...base,
    topic: z.literal("agent.tool_use"),
    runId: z.string(),
    messageId: z.string(),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    topic: z.literal("agent.tool_result"),
    runId: z.string(),
    messageId: z.string(),
    id: z.string(),
    output: z.unknown(),
    isError: z.boolean().optional(),
  }),
  z.object({
    ...base,
    topic: z.literal("agent.usage"),
    runId: z.string(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  z.object({
    ...base,
    topic: z.literal("agent.done"),
    runId: z.string(),
    threadId: z.string(),
    status: z.enum(["completed", "aborted", "failed"]),
    sessionId: z.string().optional(),
    exitCode: z.number().optional(),
  }),
  z.object({ ...base, topic: z.literal("agent.error"), runId: z.string(), message: z.string() }),
  /**
   * Supervised runtime mode. `summary` is one line fit for a push notification. A request that
   * nobody answers within 30 minutes resolves as `deny` with `by: "timeout"`.
   */
  z.object({
    ...base,
    topic: z.literal("agent.approval_requested"),
    runId: z.string(),
    threadId: z.string(),
    requestId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    summary: z.string(),
  }),
  z.object({
    ...base,
    topic: z.literal("agent.approval_resolved"),
    runId: z.string(),
    threadId: z.string(),
    requestId: z.string(),
    decision: ApprovalDecision,
    by: ApprovalResolvedBy,
  }),
  z.object({
    ...base,
    topic: z.literal("agent.input_requested"),
    runId: z.string(),
    threadId: z.string(),
    requestId: z.string(),
    question: z.string(),
    /** Absent = free text. */
    options: z.array(z.string()).optional(),
  }),
  z.object({
    ...base,
    topic: z.literal("agent.input_resolved"),
    runId: z.string(),
    threadId: z.string(),
    requestId: z.string(),
    answer: z.string(),
  }),
  z.object({
    ...base,
    topic: z.literal("job.started"),
    jobId: z.string(),
    kind: z.string(),
    projectId: z.string().optional(),
  }),
  z.object({
    ...base,
    topic: z.literal("job.progress"),
    jobId: z.string(),
    progress: z.number().min(0).max(1).optional(),
    note: z.string().optional(),
  }),
  z.object({ ...base, topic: z.literal("job.done"), jobId: z.string(), result: z.unknown() }),
  z.object({ ...base, topic: z.literal("job.failed"), jobId: z.string(), error: z.string() }),
  z.object({ ...base, topic: z.literal("job.cancelled"), jobId: z.string() }),
  z.object({ ...base, topic: z.literal("route.meta"), meta: RouteMeta }),
  z.object({ ...base, topic: z.literal("route.static"), static: RouteStatic }),
  z.object({ ...base, topic: z.literal("route.frame"), frame: RouteFrame }),
  z.object({ ...base, topic: z.literal("route.done"), result: RouteResult }),
  z.object({
    ...base,
    topic: z.literal("project.changed"),
    projectId: z.string(),
    paths: z.array(z.string()),
  }),
  /**
   * Thread lifecycle. Every client keeps its own thread list, so each mutation the daemon makes —
   * including the ones it makes on its own, like auto-titling a "New chat" — is announced here.
   * `thread.updated` carries `title` only when the title is what changed, so a client can patch
   * it into its caches before the refetch lands.
   */
  z.object({
    ...base,
    topic: z.literal("thread.created"),
    threadId: z.string(),
    projectId: z.string().nullable(),
  }),
  z.object({
    ...base,
    topic: z.literal("thread.updated"),
    threadId: z.string(),
    title: z.string().optional(),
  }),
  z.object({ ...base, topic: z.literal("thread.deleted"), threadId: z.string() }),
  z.object({ ...base, topic: z.literal("auth.state"), state: AuthState }),
  z.object({ ...base, topic: z.literal("device.paired"), deviceId: z.string(), label: z.string() }),
  z.object({ ...base, topic: z.literal("device.revoked"), deviceId: z.string() }),
  z.object({
    ...base,
    topic: z.literal("remote.state"),
    enabled: z.boolean(),
    host: z.string().optional(),
    port: z.number().optional(),
    error: z.string().optional(),
  }),
  /** The relay link came up or went down (`apps/core/src/relay.ts`); `error` says why when it went down. */
  z.object({
    ...base,
    topic: z.literal("remote.relay"),
    connected: z.boolean(),
    url: z.string(),
    error: z.string().optional(),
  }),
  z.object({ ...base, topic: z.literal("core.shutdown"), reason: z.string() }),
  z.object({
    ...base,
    topic: z.literal("finish_it.started"),
    session: FinishItSession,
  }),
  z.object({
    ...base,
    topic: z.literal("finish_it.progress"),
    session: FinishItSession,
    note: z.string().optional(),
  }),
  z.object({
    ...base,
    topic: z.literal("finish_it.milestone"),
    session: FinishItSession,
    milestone: FinishItMilestoneId,
    commitSha: z.string().optional(),
  }),
  z.object({
    ...base,
    topic: z.literal("finish_it.stopped"),
    session: FinishItSession,
  }),
  z.object({
    ...base,
    topic: z.literal("finish_it.done"),
    session: FinishItSession,
  }),
  z.object({
    ...base,
    topic: z.literal("finish_it.failed"),
    session: FinishItSession,
    error: z.string(),
  }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;
export type CoreTopic = CoreEvent["topic"];
export type ApprovalRequestedEvent = Extract<CoreEvent, { topic: "agent.approval_requested" }>;
export type InputRequestedEvent = Extract<CoreEvent, { topic: "agent.input_requested" }>;

/** `agent.*` matches every agent topic; `*` matches all. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*" || pattern === topic) return true;
  if (pattern.endsWith(".*")) return topic.startsWith(pattern.slice(0, -1));
  return false;
}
