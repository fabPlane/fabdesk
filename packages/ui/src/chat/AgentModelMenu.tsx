import type { AgentId, AgentInfo } from "@fabdesk/protocol";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../util";
import { pickerModelChoices } from "@fabdesk/client-core";

export interface AgentModelMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
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
export function AgentModelMenu({ open, anchorRef, onClose, agents, agentId, model, defaultModel, configuredModels, onSelect, onOpenSettings }: AgentModelMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 300 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const above = anchor.top - 12;
      const below = innerHeight - anchor.bottom - 12;
      const maxHeight = Math.max(80, Math.min(440, Math.max(above, below)));
      const height = Math.min(ref.current?.scrollHeight ?? maxHeight, maxHeight);
      setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - 280 - 8)), top: above >= below ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6, maxHeight });
    };
    place();
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      anchorRef.current?.focus();
    };
  }, [open, anchorRef]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        e.preventDefault();
        e.stopPropagation();
        items[next]?.focus();
      }
      if (e.key === "Tab") onClose();
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
  }, [open, onClose, anchorRef]);
  if (!open) return null;

  const choose = (id: AgentId, m: string) => {
    onSelect(id, m);
    onClose();
  };

  return createPortal(
    <div ref={ref} role="menu" aria-label="Agent and model" style={position} className="fd-elevated fixed z-40 w-[280px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-panel p-1.5" data-testid="agent-model-menu">
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
    </div>, document.body
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
