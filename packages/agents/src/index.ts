import type { AgentId, AgentInfo, Settings } from "@fabdesk/protocol";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import { cursorAdapter } from "./adapters/cursor";
import { grokAdapter } from "./adapters/grok";
import type { AgentAdapter } from "./types";

export type {
  AgentAdapter,
  AgentAttachment,
  AgentEvent,
  AgentPermission,
  AgentRun,
  AgentSession,
  DetectResult,
} from "./types";
export { MCP_SERVER_NAME, TOKEN_ENV } from "./types";
export { readJsonl, parseJsonlLine } from "./jsonl";
export { runAgentProcess, killTree } from "./process";
export { detectBinary, resolveBinary, readVersion } from "./detect";
export { MessagesStreamParser } from "./parsers/messages";
export { CodexStreamParser } from "./parsers/codex";
export { CursorStreamParser } from "./parsers/cursor";
export { claudeAdapter, claudeArgs, claudeMcpConfig } from "./adapters/claude";
export { codexAdapter, codexArgs } from "./adapters/codex";
export {
  grokAdapter,
  grokArgs,
  grokMcpToml,
  writeGrokConfig,
  grokConfigPath,
} from "./adapters/grok";
export { cursorAdapter, cursorArgs, writeCursorMcp, cursorMcpPath } from "./adapters/cursor";
export {
  renderAgentsMd,
  writeAgentDocs,
  extractUserSection,
  USER_START,
  USER_END,
} from "./agents-md";
export type { AgentDocsContext } from "./agents-md";

export const adapters: Record<AgentId, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  grok: grokAdapter,
};

export const agentIds: AgentId[] = ["claude", "codex", "grok", "cursor"];

/** Detects every adapter (in parallel), honoring `settings.agents[id].binaryPath`. */
export async function detectAgents(settings?: Settings): Promise<AgentInfo[]> {
  return Promise.all(
    agentIds.map(async (id): Promise<AgentInfo> => {
      const adapter = adapters[id];
      const configured = settings?.agents[id]?.binaryPath ?? null;
      const result = await adapter.detect(configured ?? undefined);
      return {
        id,
        displayName: adapter.displayName,
        installed: result.installed,
        ...(result.version ? { version: result.version } : {}),
        ...(result.path ? { path: result.path } : {}),
        installHint: adapter.installHint,
        models: adapter.models(),
      };
    }),
  );
}
