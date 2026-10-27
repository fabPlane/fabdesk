import type { ReasoningEffort } from "@fabdesk/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

const LABELS: Record<ReasoningEffort, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra",
};
const DETAILS: Record<ReasoningEffort, string> = {
  none: "Skip reasoning when the model supports it.",
  minimal: "Very light reasoning for simple requests.",
  low: "Quick edits and straightforward questions.",
  medium: "A balance of speed and reasoning depth.",
  high: "More reasoning for complex changes.",
  xhigh: "Deeper reasoning for difficult problems.",
  max: "Extensive reasoning; may take more time and tokens.",
  ultra: "Deepest effort; may use more time, tokens, and delegated work.",
};

export function EffortMenu({ levels, value, agentName, disabled, saving, onChange }: {
  levels: ReasoningEffort[];
  value: ReasoningEffort | null;
  agentName: string;
  disabled: boolean;
  saving: boolean;
  onChange: (effort: ReasoningEffort | null) => Promise<boolean>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 360 });
  const available = levels.length > 0;
  const label = value ? LABELS[value] : "Agent default";
  const close = () => { setOpen(false); anchor.current?.focus(); };

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = anchor.current?.getBoundingClientRect();
      const popup = menu.current;
      if (!button || !popup) return;
      const above = button.top - 14, below = innerHeight - button.bottom - 14;
      const maxHeight = Math.max(80, Math.min(560, Math.max(above, below)));
      const height = Math.min(popup.scrollHeight, maxHeight);
      setPosition({ left: Math.max(8, Math.min(button.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8)), top: above >= below ? Math.max(8, button.top - height - 6) : button.bottom + 6, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, levels, saving]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === "Tab") close();
      else if (menu.current?.contains(document.activeElement) && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", key, true); };
  }, [open]);

  const choose = async (effort: ReasoningEffort | null) => {
    if (saving || disabled) return;
    if (await onChange(effort)) close();
  };
  return <>
    <Button ref={anchor} variant="ghost" size="sm" className="h-8 shrink-0 whitespace-nowrap font-medium"
      data-testid="agent-effort" disabled={disabled || !available || saving} aria-label={`Agent effort: ${label}`}
      title={available ? "Reasoning effort — remembered for this agent across chats" : "This agent or model has not reported effort controls"}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <span>{saving ? "Saving…" : `Effort: ${value ? LABELS[value] : "Auto"}`}</span>
      <Icon name="chevronDown" width={12} height={12} />
    </Button>
    {open && createPortal(<div id={id} ref={menu} role="menu" aria-label="Agent effort" aria-busy={saving} style={position}
      className="fd-elevated fixed z-40 w-[290px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-panel p-2 font-sans" data-testid="agent-effort-menu">
      <div className="px-3 pt-2 text-[13px] font-semibold">Reasoning effort</div>
      <div className="px-3 py-2 text-xs text-muted">Saved for {agentName} across chats. Applies to the next run. Higher effort can take more time and tokens.</div>
      {([null, ...levels] as const).map((effort) => <button key={effort ?? "auto"} type="button" role="menuitemradio" aria-checked={value === effort}
        aria-disabled={saving} data-effort={effort ?? "auto"} onClick={() => void choose(effort)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-panel-2 focus-visible:bg-panel-2 aria-disabled:opacity-50">
        <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{effort ? LABELS[effort] : "Agent default"}</span>
          <span className="mt-0.5 block text-xs text-muted">{effort ? DETAILS[effort] : "Let the agent use its own effort setting."}</span></span>
        {value === effort && <Icon name="check" width={15} height={15} className="shrink-0 text-accent" />}
      </button>)}
    </div>, document.body)}
  </>;
}
