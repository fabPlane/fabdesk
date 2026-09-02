/** Event bus topics shared by core, renderer and CLI. Topic names are dotted; subscriptions glob. */
import { z } from "zod/v4";
import { RouteFrame, RouteMeta, RouteResult, RouteStatic } from "./route-frames";

export const AgentId = z.enum(["claude", "codex", "cursor", "grok"]);
export type AgentId = z.infer<typeof AgentId>;

export const MessagePart = z.discriminatedUnion("type", [
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
]);
export type MessagePart = z.infer<typeof MessagePart>;

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
});
export type AuthState = z.infer<typeof AuthState>;

export const JobStatus = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

const base = { ts: z.number() };

export const CoreEvent = z.discriminatedUnion("topic", [
  z.object({ ...base, topic: z.literal("agent.started"), runId: z.string(), threadId: z.string(), agentId: AgentId }),
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
  z.object({ ...base, topic: z.literal("job.started"), jobId: z.string(), kind: z.string(), projectId: z.string().optional() }),
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
  z.object({ ...base, topic: z.literal("project.changed"), projectId: z.string(), paths: z.array(z.string()) }),
  z.object({ ...base, topic: z.literal("thread.updated"), threadId: z.string() }),
  z.object({ ...base, topic: z.literal("auth.state"), state: AuthState }),
  z.object({ ...base, topic: z.literal("core.shutdown"), reason: z.string() }),
]);
export type CoreEvent = z.infer<typeof CoreEvent>;
export type CoreTopic = CoreEvent["topic"];

/** `agent.*` matches every agent topic; `*` matches all. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*" || pattern === topic) return true;
  if (pattern.endsWith(".*")) return topic.startsWith(pattern.slice(0, -1));
  return false;
}
