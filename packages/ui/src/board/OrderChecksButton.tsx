import type { OrderReadiness } from "@fabdesk/protocol";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

export function OrderChecksButton({ order, unavailable = false, onClick, onReviewChecks }: {
  order: OrderReadiness;
  unavailable?: boolean;
  onClick: () => void;
  /** Canvas navigation can take an explicit failed/stale check straight to its report. */
  onReviewChecks?: () => void;
}) {
  const checks = [order.checks.drc, order.checks.erc];
  // Permission to order is not proof of passed checks: skipped/non-applicable
  // checks can be non-blocking, and a Gerber-only project may have no checks.
  const review = !unavailable && (order.warnings.length > 0 || checks.some((s) => s === "fail" || s === "stale" || s === "not_applicable"));
  const passed = !unavailable && !review && order.ready && checks.includes("pass") && checks.every((s) => s === "pass" || s === "not_required");
  const reviewChecks = !unavailable && !!onReviewChecks && checks.some(state => state === "fail" || state === "stale" || state === "not_applicable");
  const status = review ? "review" : passed ? "passed" : "unchecked";
  const label = review ? "Review issues" : passed ? "Checks passed" : "Order checks";
  const title = unavailable ? "Could not refresh order checks. Open to review." : passed
    ? "Current required board checks passed. Open order options."
    : [...order.reasons, ...order.warnings].join(" ") || "Review board checks before ordering.";
  return <Button
    size="sm"
    variant="ghost"
    className="fd-order-checks"
    data-status={status}
    data-testid="order-now"
    title={reviewChecks ? `Open design checks. ${title}` : title}
    onClick={reviewChecks ? onReviewChecks : onClick}
  >
    <Icon name={review ? "warning" : passed ? "check" : "checklist"} width={16} height={16} />
    {label}
  </Button>;
}
