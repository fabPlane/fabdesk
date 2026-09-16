import type { AgentId, AgentInfo } from "@fabdesk/protocol";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../util";
import { pickerModelChoices } from "@fabdesk/client-core";

export interface AgentModelMenuProps {
  open: boolean;
  onClose: () => void;
  agents: AgentInfo[];
  agentId: AgentId;
  /** Empty string means the agent's own default model. */
  model: string;
  /** Default model configured for an agent in Settings (empty when none). */
  defaultModel: (id: AgentId) => string;
  /** Models configured for the dropdown in Settings (empty means the adapter's first three). */
  configuredModels: (id: AgentId) => string[];
  onSelect: (agentId: AgentId, model: string) => void;
  onOpenSettings: () => void;
}

/**
 * Dropdown above the composer's agent button: one list with each CLI and up to three of its models.
 * Clicking the CLI name picks it with its default model; the Settings link widens the model list.
 */
export function AgentModelMenu({ open, onClose, agents, agentId, model, defaultModel, configuredModels, onSelect, onOpenSettings }: AgentModelMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);
  if (!open) return null;

  const choose = (id: AgentId, m: string) => {
    onSelect(id, m);
    onClose();
  };

  return (
    <div ref={ref} role="menu" className="absolute bottom-full left-0 z-40 mb-1 w-60 rounded-lg border border-border bg-panel p-1 shadow-xl" data-testid="agent-model-menu">
      {agents.map((a) => {
        const fallback = defaultModel(a.id);
        const active = a.id === agentId;
        const models = pickerModelChoices(a.models, configuredModels(a.id), active ? model : "").filter((m) => m !== fallback);
        const onDefault = active && (model === "" || model === fallback);
        return (
          <div key={a.id} className="py-0.5">
            <Item selected={onDefault} onClick={() => choose(a.id, fallback)} title={a.installed ? `${a.displayName}, default model${fallback ? ` (${fallback})` : ""}` : a.installHint}>
              <span className={cn("font-medium", a.installed ? "" : "text-muted")}>{a.displayName}</span>
              {!a.installed && <span className="ml-auto text-[10px] text-warning">not installed</span>}
            </Item>
            {models.map((m) => (
              <Item key={m} selected={active && model === m} onClick={() => choose(a.id, m)} indent>
                <span className="truncate font-mono">{m}</span>
              </Item>
            ))}
          </div>
        );
      })}
      <div className="mt-0.5 border-t border-border pt-0.5">
        <Item selected={false} onClick={() => { onClose(); onOpenSettings(); }}>
          <span className="text-muted">More models in Settings…</span>
        </Item>
      </div>
    </div>
  );
}

function Item({ selected, onClick, indent, title, children }: { selected: boolean; onClick: () => void; indent?: boolean; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 rounded-md py-1 pr-2 text-left text-xs hover:bg-panel-2",
        indent ? "pl-6" : "pl-2",
        selected ? "bg-panel-2 text-fg" : "text-fg",
      )}
      onClick={onClick}
    >
      <span className={cn("w-3 shrink-0 text-accent", selected ? "" : "invisible")}>&#10003;</span>
      {children}
    </button>
  );
}
