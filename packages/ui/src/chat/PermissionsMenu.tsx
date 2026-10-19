import type { Thread } from "@fabdesk/protocol";
import { useDoctor, useSetRuntimeMode } from "@fabdesk/client-core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui";

const OPTIONS = [
  { mode: "supervised", icon: "shield", tone: "text-success", label: "Ask for approval", description: "Pause supported writes for your approval." },
  { mode: "full", icon: "warning", tone: "text-warning", label: "Run without approval", description: "Let the agent run without approval pauses." },
] as const;

/** Changes the existing chat setting; the daemon still validates agent support. */
export function PermissionsMenu({ thread }: { thread: Thread }) {
  const updateMode = useSetRuntimeMode();
  const doctor = useDoctor();
  const supportsApproval = doctor.data?.agents.find((agent) => agent.id === thread.agentId)?.supportsSupervised === true;
  const approvalDescription = supportsApproval ? OPTIONS[0].description : doctor.isPending
    ? "Checking whether this agent supports approval pauses…"
    : "Approval pauses are not available for this agent yet. Your selected agent and model will stay unchanged.";
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 300 });
  const mode = thread.runtimeMode ?? "full";
  const selected = OPTIONS.find((item) => item.mode === mode)!;
  const label = selected.label;
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) anchor.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = anchor.current?.getBoundingClientRect();
      const popup = menu.current;
      if (!button || !popup) return;
      const above = button.top - 14;
      const below = innerHeight - button.bottom - 14;
      const maxHeight = Math.max(80, Math.min(360, Math.max(above, below)));
      const height = Math.min(popup.scrollHeight, maxHeight);
      const width = popup.getBoundingClientRect().width;
      setPosition({ left: Math.max(8, Math.min(button.left, innerWidth - width - 8)), top: above >= below ? Math.max(8, button.top - height - 6) : button.bottom + 6, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, error, pending]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (event.key === "Tab") {
        // Return to the trigger before the browser advances to the next/previous control.
        close();
      } else if (menu.current?.contains(document.activeElement) && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", key, true); };
  }, [open]);

  const select = async (runtimeMode: "supervised" | "full") => {
    if (saving.current || (runtimeMode === "supervised" && !supportsApproval)) return;
    if (runtimeMode === mode) { close(); return; }
    saving.current = true;
    setPending(true); setError(null);
    try {
      await updateMode.mutateAsync({ threadId: thread.id, runtimeMode });
      close(!!menu.current?.contains(document.activeElement));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update permissions. Try again.");
    } finally {
      saving.current = false; setPending(false);
    }
  };

  return <>
    <Button ref={anchor} variant="ghost" size="sm" className="fd-permissions-button"
      title={`Permissions: ${label}`} aria-label={`Permissions: ${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      data-testid="runtime-mode-toggle" onClick={() => setOpen(!open)}>
      <Icon name={selected.icon} width={16} height={16} className={selected.tone} />
      <span className="fd-permissions-label">{label}</span>
      <Icon name="chevronDown" width={12} height={12} className="fd-permissions-chevron" />
    </Button>
    {open && createPortal(<div id={id} ref={menu} role="menu" aria-label="Chat permissions" aria-busy={pending} style={position}
      className="fd-elevated fixed z-40 w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-panel p-2 font-sans" data-testid="permissions-menu">
      <div className="px-3 pt-2 pb-1 text-[13px] font-semibold text-fg">How should actions be approved?</div>
      <div className="px-3 pb-2 text-xs text-muted">Changes apply to the next run.</div>
      {OPTIONS.map((item) => <button key={item.mode} type="button" role="menuitemradio" aria-checked={mode === item.mode} aria-disabled={pending || (item.mode === "supervised" && !supportsApproval)}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-fg hover:bg-panel-2 focus-visible:bg-panel-2 aria-disabled:opacity-50"
        onClick={() => void select(item.mode)}>
        <Icon name={item.icon} width={20} height={20} className={`shrink-0 ${item.tone}`} />
        <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{item.label}</span><span className="mt-1 block text-xs leading-5 text-muted">{item.mode === "supervised" ? approvalDescription : item.description}</span></span>
        {mode === item.mode && <Icon name="check" width={16} height={16} className={`shrink-0 ${item.tone}`} />}
      </button>)}
      {pending && <div role="status" className="px-3 py-2 text-xs text-muted">Saving permissions…</div>}
      {error && <div role="alert" className="flex items-start gap-2 px-3 py-2 text-xs leading-5 text-danger"><Icon name="warning" width={16} height={16} className="mt-0.5 shrink-0" /><span>{error}</span></div>}
    </div>, document.body)}
  </>;
}
