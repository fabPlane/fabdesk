import { Button, type ButtonProps } from "./ui";
import { Icon, type IconName } from "./Icon";

/** Stable icon target; its name remains available to keyboard and assistive technology. */
export function CanvasToolButton({ label, icon, active, className = "", ...props }: Omit<ButtonProps, "children"> & { label: string; icon: IconName; active?: boolean }) {
  return <span className="fd-canvas-tool">
    <Button {...props} size="sm" variant={active ? "secondary" : props.variant ?? "ghost"} className={`fd-canvas-tool-button ${className}`} aria-label={label} aria-pressed={active}>
      <Icon name={icon} width={18} height={18} aria-hidden="true" />
    </Button>
    <span className="fd-canvas-tool-label" aria-hidden="true">{label}</span>
  </span>;
}
