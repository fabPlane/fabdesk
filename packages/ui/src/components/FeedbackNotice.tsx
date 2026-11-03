import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { cn } from "../util";

export type FeedbackTone = "success" | "info" | "warning" | "error" | "progress";

/** Persistent by default. Put problems and actionable results beside their task. */
export function FeedbackNotice({ tone = "info", title, children, actions, onDismiss, className }: {
  tone?: FeedbackTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return <div className={cn("fd-feedback", className)} data-tone={tone}>
    <div className="fd-feedback-announcement" role={tone === "error" ? "alert" : "status"} aria-atomic="true">
      <span className="fd-feedback-icon" aria-hidden="true"><Icon name={tone === "success" ? "checkCircle" : tone === "error" || tone === "warning" ? "warning" : tone === "progress" ? "refresh" : "info"} width={20} height={20} /></span>
      <div className="fd-feedback-copy"><strong>{title}</strong>{children && <div className="fd-feedback-detail">{children}</div>}</div>
    </div>
    {actions && <div className="fd-feedback-actions">{actions}</div>}
    {onDismiss && <button type="button" className="fd-feedback-dismiss" aria-label={`Dismiss ${title}`} onClick={onDismiss}><Icon name="close" width={16} height={16} aria-hidden="true" /></button>}
  </div>;
}

/** Only redundant confirmations may expire: the saved state remains in the task.
 * Never use this for warnings, failures, progress, Undo or a required next step. */
export function ConfirmationToast({ title, children, onDismiss }: {
  title: string;
  children?: ReactNode;
  onDismiss: () => void;
}) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const remaining = useRef(6000), dismiss = useRef(onDismiss);
  const region = useRef<HTMLDivElement>(null);
  const origin = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  dismiss.current = onDismiss;
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (hovered || focused || hidden) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss.current(), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [hovered, focused, hidden]);
  const dismissFromControl = () => {
    const restoreFocus = region.current?.contains(document.activeElement);
    onDismiss();
    if (restoreFocus) requestAnimationFrame(() => { if (origin.current?.isConnected) origin.current.focus({ preventScroll: true }); });
  };
  return <div ref={region} className="fd-confirmation-toast" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <FeedbackNotice tone="success" title={title} onDismiss={dismissFromControl}>{children}</FeedbackNotice>
  </div>;
}
