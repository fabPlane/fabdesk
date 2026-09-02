/** stderr logger; stdout is reserved for the ReadyLine / stdio MCP transport. */
export type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = (process.env["FABDESK_LOG"] as Level | undefined) ?? "info";

export function setLogLevel(level: Level): void {
  threshold = level;
}

export function log(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (order[level] < order[threshold]) return;
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${data ? " " + safeJson(data) : ""}\n`;
  process.stderr.write(line);
}

export const logger = {
  debug: (m: string, d?: Record<string, unknown>) => log("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => log("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => log("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => log("error", m, d),
};

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
