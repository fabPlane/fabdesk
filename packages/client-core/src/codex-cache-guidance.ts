import type { AgentInfo } from "@fabdesk/protocol";

export const CODEX_CACHE_ISSUE_URL = "https://github.com/openai/codex/issues/62312";
export const CODEX_INSTRUCTION_INPUT_RELEASE_URL =
  "https://github.com/openai/codex/releases/tag/rust-v0.162.0";

/**
 * Guidance only; never rewrite instructions, select a model, or update the external CLI.
 * Upstream #51156 moved base instructions into input for ordinary Responses in 0.162.0,
 * outside the Responses Lite/model gate. A comparable version is not proof of caching:
 * https://github.com/openai/codex/pull/51156
 */
export function codexCacheGuidance(
  agent: Pick<AgentInfo, "id" | "installed" | "path" | "version" | "models"> | undefined,
  model: string,
) {
  if (
    agent?.id !== "codex" ||
    !agent.installed ||
    !["gpt-6.2-sol", "gpt-6.2-astra"].includes(model)
  )
    return;

  // Doctor's version belongs to its resolved path, including a Settings override.
  // Keep partial, prerelease, custom, and future-major versions explicitly unknown.
  const version = agent.path ? agent.version : undefined;
  const stable = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? "");
  const minor = stable ? Number(stable[1]) : NaN;
  const patch = stable ? Number(stable[2]) : NaN;
  const status =
    !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)
      ? "unknown"
      : minor < 162
        ? "older"
        : "at-or-above";
  const message =
    status === "older"
      ? `Codex ${version} predates the upstream instruction-format change. For the reported GPT-6.2 cache/usage issue, update that external Codex installation to stable 0.162.0 or later.`
      : status === "at-or-above"
        ? `Codex ${version} is at or above 0.162.0, which introduced the upstream instruction-format change. This version check does not verify caching or usage savings.`
        : "The resolved Codex CLI path or version could not be compared with stable releases. Check that installation; stable 0.162.0 introduced the upstream instruction-format change.";
  return {
    status,
    message,
    path: agent.path,
    offerManualGpt61: status !== "at-or-above" && agent.models.includes("gpt-6.1-sol"),
  };
}
