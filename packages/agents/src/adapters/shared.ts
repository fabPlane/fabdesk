import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAttachment, AgentSession } from "../types";
import { TOKEN_ENV } from "../types";

/** Environment for the agent process: inherited, session overrides, then the MCP token. */
export function agentEnv(session: AgentSession): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  for (const [k, v] of Object.entries(session.env ?? {})) env[k] = v;
  env[TOKEN_ENV] = session.mcp.token;
  return env;
}

export function isImage(a: AgentAttachment): boolean {
  return a.mime.startsWith("image/");
}

/**
 * Appends a note per attachment so CLIs without an image flag still find the file. Agents read
 * images through their file-reading tool (Claude's `Read` renders PNG/JPEG).
 */
export function promptWithAttachments(
  prompt: string,
  attachments: AgentAttachment[],
  opts: { skipImages?: boolean } = {},
): string {
  const notes = attachments
    .filter((a) => !(opts.skipImages && isImage(a)))
    .map((a) =>
      isImage(a)
        ? `Sketch: ${a.path} — read it with the Read tool.`
        : `Attachment (${a.mime}): ${a.path}`,
    );
  if (notes.length === 0) return prompt;
  return `${prompt}\n\n${notes.join("\n")}`;
}

/** Writes a file, creating parent directories. */
export function writeFileEnsuringDir(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode !== undefined ? { mode } : {});
}

export function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Replaces (or appends) the block between `startMarker` and `endMarker` in `existing`, keeping
 * everything else — used for per-run MCP config files that a user may also edit by hand.
 */
export function replaceMarkedBlock(
  existing: string | undefined,
  startMarker: string,
  endMarker: string,
  block: string,
): string {
  const generated = `${startMarker}\n${block.trimEnd()}\n${endMarker}\n`;
  if (existing === undefined || existing.trim() === "") return generated;
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker, start >= 0 ? start : 0);
  if (start >= 0 && end >= 0) {
    const after = existing.slice(end + endMarker.length).replace(/^\r?\n/, "");
    return `${existing.slice(0, start)}${generated}${after}`;
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${generated}`;
}

/** TOML basic string literal (JSON escaping is a subset of TOML's). */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}
