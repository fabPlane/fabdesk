import { DisclosureSummary } from "./DisclosureSummary";
import { CoreHttpError, errorHelp, errorPayload, type ErrorContext } from "@fabdesk/client-core";
import { createContext, useContext } from "react";
import { useUiStore } from "../stores/ui";
import { Button } from "./ui";
import { Icon } from "./Icon";

export const ErrorAgentContext = createContext<string | undefined>(undefined);
export const ErrorRetryContext = createContext<(() => void) | undefined>(undefined);

/** Plain-English explanation first; the original failure remains available for support. */
export function ErrorNotice({ error, agentId, title, description, diagnostics, tone, onRetry, onRestart, onDismiss }: {
  error: unknown; agentId?: string; title?: string; description?: string; diagnostics?: string; tone?: "warning" | "error";
  onRetry?: () => void; onRestart?: () => void; onDismiss?: () => void;
}) {
  const inheritedAgent = useContext(ErrorAgentContext);
  const reviewPrompt = useContext(ErrorRetryContext);
  const selectedAgent = agentId ?? inheritedAgent;
  const context: ErrorContext = selectedAgent ? { agentId: selectedAgent } : {};
  const help = errorHelp(error, context);
  const raw = errorPayload(error).raw;
  const setProjectPickerOpen = useUiStore((s) => s.setProjectPickerOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setAgentPickerOpen = useUiStore((s) => s.setAgentPickerOpen);
  const action = title ? undefined : help.action;
  const warning = (tone ?? help.severity) === "warning";
  return <div role={warning ? "status" : "alert"} className="fd-feedback fd-error-notice my-2 text-sm" data-tone={warning ? "warning" : "error"} data-testid="error-notice" data-severity={warning ? "warning" : "error"}>
    <div className="fd-error-summary"><Icon name="warning" width={17} height={17} aria-hidden="true" /><strong>{title ?? help.title}</strong>
    {onRetry && <Button size="sm" onClick={onRetry}>Retry</Button>}
    {onRestart && <Button size="sm" onClick={onRestart}>Restart core</Button>}
    {action && <Button size="sm" onClick={() => {
      if (action === "projects") setProjectPickerOpen(true);
      else if (action === "models" || action === "agents") setAgentPickerOpen(true);
      else setSettingsOpen(true, action);
    }}>{action === "projects" ? "Choose project" : action === "models" ? "Choose model" : action === "agents" ? "Switch agent" : action === "auth" ? "Account settings" : "KiCad settings"}</Button>}
    {reviewPrompt && (action === "agents" || action === "models") && <Button size="sm" onClick={reviewPrompt}>Review prompt</Button>}
    <details className="fd-error-details text-xs text-muted">
      <DisclosureSummary icon="info" label="Details" variant="compact" />
      <p>{description ?? help.message}</p>
      {help.command && <p>Sign in with <code className="select-all rounded bg-panel-2 px-1 py-0.5">{help.command}</code> in your terminal.</p>}
      {action === "agents" && <Button size="sm" onClick={() => setSettingsOpen(true, "agents")}>Agent settings</Button>}
      {diagnostics && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words select-text">{diagnostics}</pre>}
      {raw && (description || !help.message.includes(raw)) && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words select-text">{error instanceof CoreHttpError ? `HTTP ${error.status} ${error.path}\n` : ""}{raw}</pre>}
    </details>
    {onDismiss && <button type="button" className="fd-error-dismiss" aria-label="Dismiss error notice" onClick={onDismiss}><Icon name="close" width={15} height={15} /></button>}
    </div>
  </div>;
}
