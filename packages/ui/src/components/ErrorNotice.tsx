import { DisclosureSummary } from "./DisclosureSummary";
import { errorHelp, errorPayload, type ErrorContext } from "@fabdesk/client-core";
import { createContext, useContext } from "react";
import { useUiStore } from "../stores/ui";
import { Button } from "./ui";
import { Icon } from "./Icon";

export const ErrorAgentContext = createContext<string | undefined>(undefined);

/** Plain-English explanation first; the original failure remains available for support. */
export function ErrorNotice({ error, agentId }: { error: unknown; agentId?: string }) {
  const inheritedAgent = useContext(ErrorAgentContext);
  const selectedAgent = agentId ?? inheritedAgent;
  const context: ErrorContext = selectedAgent ? { agentId: selectedAgent } : {};
  const help = errorHelp(error, context);
  const raw = errorPayload(error).raw;
  const setProjectPickerOpen = useUiStore((s) => s.setProjectPickerOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setAgentPickerOpen = useUiStore((s) => s.setAgentPickerOpen);
  const action = help.action;
  const warning = help.severity === "warning";
  return <div role={warning ? "status" : "alert"} className="fd-feedback my-2 text-sm" data-tone={warning ? "warning" : "error"} data-testid="error-notice" data-severity={warning ? "warning" : "error"}>
    <div className="flex items-center gap-2.5 font-semibold"><span className="fd-feedback-icon" aria-hidden="true"><Icon name="warning" width={20} height={20} /></span>{help.title}</div>
    <p className="mt-1 text-fg">{help.message}</p>
    {help.command && <p className="mt-2 text-xs">Open a terminal and run <code className="select-all rounded bg-panel-2 px-1 py-0.5">{help.command}</code>, then finish signing in in your browser.</p>}
    {action && <Button size="sm" className="mt-2" onClick={() => {
      if (action === "projects") setProjectPickerOpen(true);
      else if (action === "models") setAgentPickerOpen(true);
      else setSettingsOpen(true, action);
    }}>{action === "projects" ? "Choose project" : action === "models" ? "Choose model" : action === "agents" ? "Agent settings" : action === "auth" ? "Account settings" : "KiCad settings"}</Button>}
    {raw && <details className="mt-2 text-xs text-muted">
      <DisclosureSummary icon="terminal" label="Technical details" variant="compact" />
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words select-text">{raw}</pre>
    </details>}
  </div>;
}
