import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import "./disclosure.css";

/** Shared presentation only: the parent details retains native keyboard/toggle behavior. */
export function DisclosureSummary({ label, icon, badge, warning = false, variant = "section" }: {
  label: ReactNode;
  icon: IconName;
  badge?: ReactNode;
  warning?: boolean;
  variant?: "section" | "compact";
}) {
  return <summary className="fd-disclosure-summary" data-variant={variant}>
    <Icon name={icon} className="fd-disclosure-icon" width={18} height={18} />
    <span className="fd-disclosure-label">{label}</span>
    {badge != null && <span className="fd-disclosure-badge" data-warning={warning}>{badge}</span>}
    <Icon name="chevronRight" className="fd-disclosure-chevron" width={16} height={16} />
  </summary>;
}
