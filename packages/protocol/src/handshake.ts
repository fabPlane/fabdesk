/** `daemon.json`: how a running fabdesk-core is found by Electron, the CLI and `fabdesk-core mcp`. */
import { z } from "zod/v4";

export const DaemonHandshake = z.object({
  version: z.string(),
  pid: z.number().int(),
  port: z.number().int(),
  host: z.string().default("127.0.0.1"),
  token: z.string().min(16),
  startedAt: z.string(),
  channel: z.enum(["public", "internal"]),
  authMode: z.enum(["fabplane", "local"]),
  runtimeId: z.string().min(16).optional(),
});
export type DaemonHandshake = z.infer<typeof DaemonHandshake>;

/** First line `fabdesk-core serve` prints to stdout once it is listening. */
export const ReadyLine = z.object({
  ok: z.literal(true),
  port: z.number().int(),
  pid: z.number().int(),
  version: z.string(),
  runtimeId: z.string().min(16).optional(),
});
export type ReadyLine = z.infer<typeof ReadyLine>;
