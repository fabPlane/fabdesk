import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../util";
import { Icon, type IconName } from "./Icon";
import { tabDestination, tabStopIndices } from "./keyboard";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg font-semibold hover:brightness-105 border-transparent shadow-sm",
  secondary: "bg-panel-2/70 text-fg hover:bg-panel-2 border-border",
  ghost: "bg-transparent text-muted hover:text-fg hover:bg-panel-2/70 border-transparent",
  danger: "bg-danger/10 text-danger hover:bg-danger/20 border-danger/20",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-[13px] gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-md border font-medium transition-[background-color,color,border-color,filter,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40 disabled:saturate-50 disabled:pointer-events-none select-none whitespace-nowrap",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
});

export function IconButton({ className, title, size = "md", style, ...rest }: Omit<ButtonProps, "size"> & { title: string; size?: "xs" | "sm" | "md" }) {
  const pixels = { xs: 24, sm: 28, md: 36 }[size];
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("fd-icon-button shrink-0 text-fg/75 hover:text-fg", className)}
      style={{ width: pixels, height: pixels, padding: 0, ...style }}
      title={title}
      aria-label={title}
      {...rest}
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 min-w-0 w-full rounded-md border border-border bg-bg/50 px-3 text-[13px] text-fg placeholder:text-muted outline-none transition-colors focus:border-accent",
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full resize-none rounded-md border border-border bg-bg/50 px-3 py-2 text-sm text-fg placeholder:text-muted outline-none transition-colors focus:border-accent",
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-9 min-w-0 max-w-full rounded-md border border-border bg-bg/50 px-2.5 text-[13px] text-fg outline-none transition-colors focus:border-accent",
        className,
      )}
      {...rest}
    />
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn("fd-spin inline-block h-3.5 w-3.5 rounded-full border-2 border-muted border-t-transparent", className)}
      aria-label="loading"
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
  title?: string;
}) {
  const tones = {
    neutral: "bg-transparent text-fg/85 border-border font-semibold",
    accent: "bg-accent/15 text-accent border-accent/30",
    success: "bg-success/15 text-success border-success/30",
    warning: "bg-warning/15 text-warning border-warning/30",
    danger: "bg-danger/15 text-danger border-danger/30",
  };
  return (
    <span
      title={title}
      className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tracking-[0.01em]", tones[tone], className)}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-border bg-panel-2/60 px-1.5 py-0.5 font-mono text-[10px] text-muted">{children}</kbd>
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Use when an in-flight action cannot be dismissed or cancelled by closing. */
  closeDisabled?: boolean;
  title?: ReactNode;
  headerActions?: ReactNode;
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  /** Skip the padded panel chrome (used by the sketch pad). */
  bare?: boolean;
  /** Where focus goes on close when the element that had it before opening is gone. */
  fallbackFocus?: () => HTMLElement | null | undefined;
}

export function Dialog({ open, onClose, closeDisabled = false, title, headerActions, ariaLabel, children, className, bare, fallbackFocus }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const fallbackFocusRef = useRef(fallbackFocus);
  fallbackFocusRef.current = fallbackFocus;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(document.activeElement)) {
        (dialog.querySelector<HTMLElement>("[autofocus], input:not([type=hidden]):not([type=radio]):not([disabled]), textarea:not([disabled]), select:not([disabled])")
          ?? dialog.querySelector<HTMLElement>("button:not([disabled])") ?? dialog).focus();
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
      else fallbackFocusRef.current?.()?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialogRef.current) return;
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        const candidates = Array.from(dialog?.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]") ?? []);
        const items = tabStopIndices(candidates.map((element) => ({
          disabled: element.matches(":disabled") || !!element.closest("[inert]"),
          tabIndex: element.tabIndex,
          visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
          radioGroup: element instanceof HTMLInputElement && element.type === "radio" ? element.name : "",
          checked: element instanceof HTMLInputElement && element.checked,
        }))).map((index) => candidates[index]!);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first) { e.preventDefault(); dialog?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!closeDisabled) onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, closeDisabled]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[3px]" onMouseDown={() => { if (!closeDisabled) onClose(); }} role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={closeDisabled || undefined}
        aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
        className={cn(
          "fd-elevated flex max-h-full flex-col overflow-hidden rounded-2xl border border-border bg-panel text-left",
          bare ? "" : /(?:^|\s)!?w-/.test(className ?? "") ? "max-w-full" : "w-[640px] max-w-full",
          className,
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex min-h-13 items-center justify-between border-b border-border px-5 py-3">
            <div className="min-w-0 break-words text-[15px] font-semibold tracking-[-0.01em]">{title}</div>
            <div className="flex shrink-0 items-center gap-1">{headerActions}<IconButton title={closeDisabled ? "Wait for the current action to finish" : "Close"} disabled={closeDisabled} onClick={onClose}>
              <Icon name="close" />
            </IconButton></div>
          </div>
        )}
        <div className={cn("min-h-0 flex-1 overflow-auto", bare ? "" : "p-5")}>{children}</div>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  variant = "pills",
  iconOnly = false,
}: {
  tabs: Array<{ id: T; label: string; hint?: string; icon?: IconName }>;
  value: T;
  onChange: (t: T) => void;
  className?: string;
  variant?: "pills" | "underline";
  iconOnly?: boolean;
}) {
  // A secondary tool can own the current workspace while its primary view tabs remain visible.
  // Keep one keyboard entry point without falsely marking that view as selected.
  const focusableTab = tabs.some(tab => tab.id === value) ? value : tabs[0]?.id;
  return (
      <div className={cn("flex items-center overflow-x-auto", variant === "underline" ? "fd-tabs-underline" : "gap-1", iconOnly && "fd-icon-tabs", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          aria-label={iconOnly ? t.label : undefined}
          tabIndex={t.id === focusableTab ? 0 : -1}
          onKeyDown={(e) => {
            const index = tabs.findIndex((tab) => tab.id === t.id);
            const next = tabDestination(e.key, index, tabs.length);
            if (next === null) return;
            e.preventDefault();
            const tab = tabs[next];
            if (tab) { onChange(tab.id); (e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus(); }
          }}
          title={t.hint}
          data-testid={`tab-${t.id}`}
          onClick={() => onChange(t.id)}
          className={cn(
            "px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
            variant === "underline"
              ? "fd-underline-tab"
              : cn("h-8 rounded-md", t.id === value ? "bg-panel-2 text-fg shadow-sm" : "text-muted hover:text-fg hover:bg-panel-2/60"),
          )}
        >
          {t.icon ? <><Icon name={t.icon} width={18} height={18} aria-hidden="true" />{iconOnly ? <span className="fd-canvas-tool-label" aria-hidden="true">{t.label}</span> : <span>{t.label}</span>}</> : t.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action, icon }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="fd-empty-state flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {icon && <div className="mb-3 text-muted" aria-hidden="true">{icon}</div>}
      <div className="text-[15px] font-semibold tracking-[-0.01em]">{title}</div>
      {children && <div className="max-w-sm text-[13px] leading-5 text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function LoadError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return <EmptyState title={title} action={<Button onClick={onRetry}>Try again</Button>}><span role="alert">We couldn’t load this content. Check the connection and try again.</span></EmptyState>;
}

export function MenuItem({ children, onClick, danger }: { children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      className={cn(
        "flex min-h-9 w-full items-center rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-panel-2",
        danger ? "text-danger" : "text-fg",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rect = menu?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(8, Math.min(x, innerWidth - rect.width - 8)), top: Math.max(8, Math.min(y, innerHeight - rect.height - 8)) });
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (menu?.contains(document.activeElement) && previous?.isConnected) previous.focus(); };
  }, [x, y]);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") close();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={menuRef}
      className="fd-elevated fixed z-50 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] min-w-44 overflow-auto rounded-xl border border-border bg-panel p-1.5"
      style={position}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {children}
    </div>
  );
}
