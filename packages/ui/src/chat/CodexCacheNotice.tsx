import type { AgentInfo } from "@fabdesk/protocol";
import {
  codexCacheGuidance,
  CODEX_CACHE_ISSUE_URL,
  CODEX_INSTRUCTION_INPUT_RELEASE_URL,
  useCore,
} from "@fabdesk/client-core";
import { FeedbackNotice } from "../components/FeedbackNotice";
import { modelDisplayName } from "./model-display-name";

/** Informational only. It never selects a replacement model or updates an installation. */
export function CodexCacheNotice({
  agent,
  model,
  inMenu = false,
}: {
  agent: AgentInfo | undefined;
  model: string;
  inMenu?: boolean;
}) {
  const { host } = useCore();
  const guidance = codexCacheGuidance(agent, model);
  if (!guidance) return null;
  const linkClass =
    "rounded px-1 text-xs text-accent underline underline-offset-4 focus-visible:outline focus-visible:outline-accent";
  return (
    <div data-codex-cache-notice className="my-2">
      <FeedbackNotice
        tone={guidance.status === "older" ? "warning" : "info"}
        title={`${modelDisplayName(model)} cache usage`}
        actions={
          <>
            <button
              type="button"
              role={inMenu ? "menuitem" : undefined}
              className={linkClass}
              onClick={() => void host.openExternal(CODEX_CACHE_ISSUE_URL)}
            >
              Upstream cache report
            </button>
            {guidance.status !== "at-or-above" && (
              <button
                type="button"
                role={inMenu ? "menuitem" : undefined}
                className={linkClass}
                onClick={() => void host.openExternal(CODEX_INSTRUCTION_INPUT_RELEASE_URL)}
              >
                Codex 0.162.0 release
              </button>
            )}
          </>
        }
      >
        <p>{guidance.message}</p>
        {guidance.path && (
          <p className="break-all">
            Detected CLI: <code>{guidance.path}</code>
          </p>
        )}
        {guidance.status !== "at-or-above" && (
          <p>Caching and usage savings have not been verified by fabPlane.</p>
        )}
        {guidance.offerManualGpt61 && (
          <p>You can also choose GPT-6.1 Sol manually from the available models.</p>
        )}
      </FeedbackNotice>
    </div>
  );
}
