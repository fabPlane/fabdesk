import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentAttachment, AgentSession } from "../types";
import { TOKEN_ENV } from "../types";

/** Environment for the agent process: inherited, session overrides, then the MCP token. */
export function agentEnv(session: AgentSession): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows environment names are case-insensitive, unlike keys in this object.
  const key = (name: string) => process.platform === "win32" ? name.toUpperCase() : name;
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[key(k)] = v;
  for (const [k, v] of Object.entries(session.env ?? {})) env[key(k)] = v;
  env[TOKEN_ENV] = session.mcp.token;
  return env;
}

export function isImage(a: AgentAttachment): boolean {
  return a.mime.startsWith("image/");
}

export type ImageSupport = "native" | "read" | "none";

function attachmentNote(a: AgentAttachment): string {
  if (!isImage(a)) return `Attachment (${a.mime}): ${a.path}`;
  return a.role === "markup" ? `Marked view: ${a.path}` : `Sketch: ${a.path}`;
}

/**
 * Appends a path per attachment so CLIs without an image flag still receive the user-provided file.
 */
export function promptWithAttachments(
  prompt: string,
  attachments: AgentAttachment[],
  opts: { skipImages?: boolean } = {},
): string {
  const notes = attachments
    .filter((a) => !(opts.skipImages && isImage(a)))
    .map(attachmentNote);
  if (notes.length === 0) return prompt;
  return `${prompt}\n\n${notes.join("\n")}`;
}

const IMAGE_UNSUPPORTED_NOTE =
  "Marked view image was not sent because this agent does not accept images. Use the markup text context (view, viewport, and nearby objects).";

/** Drop image attachments for CLIs that cannot take them, and say so in the prompt. */
export function applyImagePolicy(
  support: ImageSupport,
  prompt: string,
  attachments: AgentAttachment[],
): { prompt: string; attachments: AgentAttachment[] } {
  if (support !== "none") return { prompt, attachments };
  const images = attachments.filter(isImage);
  if (images.length === 0) return { prompt, attachments };
  const kept = attachments.filter((a) => !isImage(a));
  const note = images.some((a) => a.role === "markup")
    ? IMAGE_UNSUPPORTED_NOTE
    : "Image attachments were not sent because this agent does not accept images.";
  return { prompt: `${prompt}\n\n${note}`, attachments: kept };
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
