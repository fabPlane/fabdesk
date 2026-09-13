/**
 * Structured logging. Every line is one JSON object; peer identifiers are hashed before they
 * reach the sink, so the sink (stdout, a log shipper, a test) never sees a `coreId` or `userId`.
 */
import { shortHash } from "./hash";

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;
export type Logger = LogSink;

/** Fields whose values are replaced by a short hash under a different key. */
const HASHED: Record<string, string> = { coreId: "core", userId: "user" };

export function redact(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!data) return out;
  for (const [k, v] of Object.entries(data)) {
    const hashedKey = HASHED[k];
    if (hashedKey) {
      if (typeof v === "string" && v) out[hashedKey] = shortHash(v);
    } else out[k] = v;
  }
  return out;
}

/** Wraps a sink so callers can pass raw identifiers and still never leak them. */
export function createLogger(sink: LogSink): Logger {
  return (level, msg, data) => sink(level, msg, redact(data));
}

/** The default sink: one JSON line per event, info on stdout, warn/error on stderr. */
export const jsonStdoutSink: LogSink = (level, msg, data) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
  (level === "info" ? process.stdout : process.stderr).write(line + "\n");
};
