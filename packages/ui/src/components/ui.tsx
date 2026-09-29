import { forwardRef, useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../util";
import { Icon } from "./Icon";

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
        "inline-flex items-center justify-center rounded-md border font-medium transition-[background-color,color,border-color,filter,box-shadow] duration-150 disabled:opacity-45 disabled:pointer-events-none select-none whitespace-nowrap",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
});

export function IconButton({ className, title, ...rest }: ButtonProps & { title: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("fd-icon-button h-9 w-9 shrink-0 text-fg/75 hover:text-fg", className)}
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
        "h-9 w-full rounded-md border border-border bg-bg/50 px-3 text-[13px] text-fg placeholder:text-muted outline-none transition-colors focus:border-accent",
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
        "h-9 rounded-md border border-border bg-bg/50 px-2.5 text-[13px] text-fg outline-none transition-colors focus:border-accent",
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
      className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tracking-[0.01em]", tones[tone], className)}
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
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Skip the padded panel chrome (used by the sketch pad). */
  bare?: boolean;
}

export function Dialog({ open, onClose, title, children, className, bare }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[3px]" onMouseDown={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "fd-elevated flex max-h-full flex-col overflow-hidden rounded-2xl border border-border bg-panel",
          bare ? "" : "w-[640px] max-w-full",
          className,
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex min-h-13 items-center justify-between border-b border-border px-5 py-3">
            <div className="text-[15px] font-semibold tracking-[-0.01em]">{title}</div>
            <IconButton title="Close" onClick={onClose}>
              <Icon name="close" />
            </IconButton>
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
}: {
  tabs: Array<{ id: T; label: string; hint?: string }>;
  value: T;
  onChange: (t: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1 overflow-x-auto", className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          title={t.hint}
          data-testid={`tab-${t.id}`}
          onClick={() => onChange(t.id)}
          className={cn(
            "h-8 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
            t.id === value ? "bg-panel-2 text-fg shadow-sm" : "text-muted hover:text-fg hover:bg-panel-2/60",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-[15px] font-semibold tracking-[-0.01em]">{title}</div>
      {children && <div className="max-w-sm text-[13px] leading-5 text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
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
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);
  return (
    <div
      className="fd-elevated fixed z-50 min-w-44 rounded-xl border border-border bg-panel p-1.5"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {children}
    </div>
  );
}
