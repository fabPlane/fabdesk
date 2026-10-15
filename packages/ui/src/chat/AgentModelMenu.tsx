import type { AgentId, AgentInfo } from "@fabdesk/protocol";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../util";
import { pickerModelChoices } from "@fabdesk/client-core";
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
  /** Models configured for the dropdown in Settings (empty means the adapter's first three). */
  configuredModels: (id: AgentId) => string[];
  onSelect: (agentId: AgentId, model: string) => void;
  onOpenSettings: () => void;
}

/** A compact model list, with a separate view for switching agents. */
export function AgentModelMenu({ open, anchorRef, onClose, agents, agentId, model, defaultModel, configuredModels, onSelect, onOpenSettings }: AgentModelMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"models" | "agents">("models");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { if (!open) { setView("models"); setShowAll(false); } }, [open]);
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
    (ref.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? ref.current?.querySelector<HTMLElement>("button"))?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      anchorRef.current?.focus();
    };
  }, [open, anchorRef, view, showAll]);
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
  const active = agents.find((a) => a.id === agentId);
  const fallback = defaultModel(agentId);
  const favorites = pickerModelChoices(active?.models ?? [], configuredModels(agentId), model).filter((m) => m !== fallback);
  const all = [...new Set([...favorites, ...(active?.models ?? [])])].filter((m) => m !== fallback);

  return createPortal(
    <div ref={ref} role="menu" aria-label="Agent and model" style={position} className="fd-elevated fixed z-40 w-[280px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-panel p-1.5 font-sans" data-testid="agent-model-menu">
      <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs text-muted">
        <span>{view === "models" ? "Model" : "Choose agent"}</span>
        <span className="truncate font-medium text-fg">{active?.displayName ?? agentId}</span>
      </div>
      {view === "models" ? <>
        <Item selected={!model || model === fallback} onClick={() => choose(agentId, fallback)} title={fallback || "Use the agent's default model"}>
          <span>Default</span>{fallback && <span className="truncate text-xs text-muted">{modelDisplayName(fallback)}</span>}
        </Item>
        {(showAll ? all : favorites).map((m) => <Item key={m} selected={model === m} onClick={() => choose(agentId, m)} title={m}>
          <span className="truncate">{modelDisplayName(m)}</span>
        </Item>)}
        {!showAll && all.length > favorites.length && <Item onClick={() => setShowAll(true)}><span>More models</span><Icon name="chevronRight" className="ml-auto" width={15} height={15} /></Item>}
        <div className="my-1 border-t border-border" />
        <Item onClick={() => setView("agents")}><span>Change agent</span><Icon name="chevronRight" className="ml-auto" width={15} height={15} /></Item>
      </> : <>
        <Item onClick={() => setView("models")}><Icon name="chevronLeft" width={15} height={15} /><span>Back to models</span></Item>
        {[...agents].sort((a, b) => Number(b.installed) - Number(a.installed)).map((a) => <Item key={a.id} selected={a.id === agentId} onClick={() => choose(a.id, defaultModel(a.id))} title={a.installed ? a.displayName : a.installHint}>
          <span>{a.displayName}</span>{!a.installed && <span className="ml-auto text-[11px] text-muted">Not installed</span>}
        </Item>)}
      </>}
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
