import { errorHelp, errorPayload, type ErrorContext } from "@fabdesk/client-core";
import { createContext, useContext } from "react";
import { useUiStore } from "../stores/ui";
import { Button } from "./ui";

export const ErrorAgentContext = createContext<string | undefined>(undefined);

/** Plain-English explanation first; the original failure remains available for support. */
export function ErrorNotice({ error, agentId }: { error: unknown; agentId?: string }) {
  const inheritedAgent = useContext(ErrorAgentContext);
  const selectedAgent = agentId ?? inheritedAgent;
  const context: ErrorContext = selectedAgent ? { agentId: selectedAgent } : {};
  const help = errorHelp(error, context);
  const raw = errorPayload(error).raw;
  const ui = useUiStore();
  const action = help.action;
  const warning = help.severity === "warning";
  return <div role={warning ? "status" : "alert"} className={`my-2 rounded-lg border px-3 py-2 text-sm ${warning ? "border-warning/25 bg-warning/5" : "border-danger/25 bg-danger/5"}`} data-testid="error-notice" data-severity={warning ? "warning" : "error"}>
    <div className={`font-semibold ${warning ? "text-warning" : "text-danger"}`}>{help.title}</div>
    <p className="mt-1 text-fg">{help.message}</p>
    {help.command && <p className="mt-2 text-xs">Open a terminal and run <code className="select-all rounded bg-panel-2 px-1 py-0.5">{help.command}</code>, then finish signing in in your browser.</p>}
    {action && <Button size="sm" className="mt-2" onClick={() => {
      if (action === "projects") ui.setProjectPickerOpen(true);
      else ui.setSettingsOpen(true, action);
    }}>{action === "projects" ? "Choose project" : action === "agents" ? "Agent settings" : action === "auth" ? "Account settings" : "KiCad settings"}</Button>}
    {raw && <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer">Technical details</summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words select-text">{raw}</pre>
    </details>}
  </div>;
}
