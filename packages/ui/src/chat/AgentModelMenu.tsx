import type { AgentId, AgentInfo } from "@fabdesk/protocol";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../util";
import { Icon } from "../components/Icon";
import { modelDisplayName } from "./model-display-name";

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
  /** Configured models appear first; all adapter models remain available. */
  configuredModels: (id: AgentId) => string[];
  onSelect: (agentId: AgentId, model: string) => void;
  onOpenSettings: () => void;
}

/** Agent-first accordion: expanding a provider never changes the selected model. */
export function AgentModelMenu({ open, anchorRef, onClose, agents, agentId, model, defaultModel, configuredModels, onSelect, onOpenSettings }: AgentModelMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<AgentId | null>(null);
  useEffect(() => { if (!open) setExpanded(null); }, [open]);
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
      const width = ref.current?.getBoundingClientRect().width ?? 280;
      setPosition({ left: Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8)), top: above >= below ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, expanded, agents]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>(`[data-agent="${agentId}"]`)?.focus();
    return () => { anchorRef.current?.focus(); };
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
  const order: AgentId[] = ["codex", "claude", "grok", "cursor"];
  const ordered = [...agents].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return createPortal(
    <div ref={ref} role="menu" aria-label="Agent and model" style={position} className="fd-elevated fixed z-40 w-[310px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-panel p-1.5 font-sans" data-testid="agent-model-menu">
      <div className="px-2.5 py-2 text-xs text-muted">Agent &amp; model</div>
      {ordered.map((agent) => {
        const isOpen = expanded === agent.id;
        const selected = agent.id === agentId;
        const fallback = defaultModel(agent.id);
        const defaultLabel = fallback || agent.defaultModel || "";
        const choices = [...new Set([...configuredModels(agent.id), ...agent.models, ...(selected && model ? [model] : [])])].filter(Boolean);
        return <div key={agent.id}>
          <button type="button" role="menuitem" aria-expanded={isOpen} aria-controls={`agent-models-${agent.id}`} data-agent={agent.id}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-fg hover:bg-panel-2 focus-visible:bg-panel-2"
            onClick={() => setExpanded(isOpen ? null : agent.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setExpanded(event.key === "ArrowRight" ? agent.id : null); }
            }}>
            <span>{agent.displayName}</span>
            {selected && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="Selected agent" />}
            {!agent.installed && <span className="ml-auto text-[11px] font-normal text-muted">Not installed</span>}
            <Icon name={isOpen ? "chevronDown" : "chevronRight"} className="ml-auto shrink-0 text-muted" width={15} height={15} />
          </button>
          {isOpen && <div id={`agent-models-${agent.id}`} role="group" aria-label={`${agent.displayName} models`} className="mb-1 ml-3 border-l border-border pl-2">
            <Item selected={selected && (!model || model === fallback)} onClick={() => choose(agent.id, fallback)} title={defaultLabel || "Use the agent's default model"}>
              <span className="min-w-0"><span className="block truncate">{defaultLabel ? modelDisplayName(defaultLabel, agent.modelAliases) : "Default model"}</span><span className="block text-[11px] font-normal text-muted">{defaultLabel ? "Default" : "Version provided by agent at runtime"}</span></span>
            </Item>
            {choices.filter((id) => id !== fallback).map((id) => <Item key={id} selected={selected && model === id} onClick={() => choose(agent.id, id)} title={agent.modelAliases?.[id] ?? id}>
              <span className="min-w-0"><span className="block truncate">{modelDisplayName(id, agent.modelAliases)}</span>
                {/^(fable|opus|sonnet|haiku)(\[1m\])?$/.test(id) && !agent.modelAliases?.[id] && <span className="block text-[11px] font-normal text-muted">Version not reported by agent</span>}
              </span>
            </Item>)}
          </div>}
        </div>;
      })}
      <div className="mt-1 border-t border-border pt-1">
        <Item onClick={() => { onClose(); onOpenSettings(); }}><Icon name="settings" width={15} height={15} /><span className="text-muted">Model settings</span></Item>
      </div>
    </div>, document.body
  );
}

function Item({ selected, onClick, title, children }: { selected?: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role={selected === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={selected}
      title={title}
      className={cn(
        "flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium hover:bg-panel-2 focus-visible:bg-panel-2",
        selected ? "bg-panel-2 text-fg" : "text-fg",
      )}
      onClick={onClick}
    >
      {children}
      {selected && <Icon name="check" className="ml-auto shrink-0 text-accent" width={16} height={16} />}
    </button>
  );
}
