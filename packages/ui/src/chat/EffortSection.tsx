import type { ReasoningEffort } from "@fabdesk/protocol";
import { useId, useLayoutEffect, useRef } from "react";
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

export interface EffortSectionProps {
  levels: ReasoningEffort[];
  value: ReasoningEffort | null;
  agentName: string;
  disabled: boolean;
  saving: boolean;
  onChange: (effort: ReasoningEffort | null) => Promise<boolean>;
}

/** Inline accordion inside the agent/model menu; its parent owns keyboard navigation. */
export function EffortSection({ levels, value, agentName, disabled, saving, onChange, open, onToggle }: EffortSectionProps & {
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const id = useId();
  const available = levels.length > 0;
  const label = value ? LABELS[value] : "Auto";
  useLayoutEffect(() => {
    if (restoreFocus.current && !open && !saving) { restoreFocus.current = false; anchor.current?.focus(); }
  }, [open, saving]);
  const choose = async (effort: ReasoningEffort | null) => {
    if (saving || disabled) return;
    if (await onChange(effort)) { restoreFocus.current = true; onToggle(false); }
  };
  return <div className="mt-1 border-t border-border pt-1">
    <button ref={anchor} type="button" role="menuitem" data-testid="agent-effort"
      disabled={disabled || !available || saving} aria-label={`Reasoning effort: ${label}`}
      title={available ? `Remembered for ${agentName} across chats` : "This agent or model has not reported effort controls"}
      aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); onToggle(event.key === "ArrowRight"); }
      }}
      className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium text-fg hover:bg-panel-2 focus-visible:bg-panel-2 disabled:opacity-50">
      <span className="flex-1">Reasoning effort</span>
      <span className="text-xs font-normal text-muted">{saving ? "Saving…" : label}</span>
      <Icon name={open ? "chevronDown" : "chevronRight"} width={15} height={15} className="shrink-0 text-muted" />
    </button>
    {open && <div id={id} role="group" aria-label="Agent effort" aria-busy={saving} data-testid="agent-effort-menu" className="mb-1 ml-3 border-l border-border pl-2">
      <p className="px-2.5 py-2 text-xs text-muted">Saved for {agentName} across chats. Higher effort can take more time and tokens.</p>
      {([null, ...levels] as const).map((effort) => <button key={effort ?? "auto"} type="button" role="menuitemradio" aria-checked={value === effort}
        disabled={saving || disabled} data-effort={effort ?? "auto"} onClick={() => void choose(effort)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-panel-2 focus-visible:bg-panel-2 disabled:opacity-50">
        <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{effort ? LABELS[effort] : "Agent default"}</span>
          <span className="mt-0.5 block text-xs text-muted">{effort ? DETAILS[effort] : "Let the agent use its own effort setting."}</span></span>
        {value === effort && <Icon name="check" width={15} height={15} className="shrink-0 text-accent" />}
      </button>)}
    </div>}
  </div>;
}
