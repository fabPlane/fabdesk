import type { OrderReadiness } from "@fabdesk/protocol";
import { useProjectOrder } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** Saved-file release evidence is useful here, but does not verify stock or assembly mapping. */
export function ManufacturingHandoff({ projectId, disabled, onChecks, onOrder }: {
  projectId: string; disabled: boolean; onChecks: () => void; onOrder: () => void;
}) {
  const order = useProjectOrder(projectId);
  return <ManufacturingHandoffView readiness={order.data} checking={order.isFetching || order.isPending} failed={order.isError}
    disabled={disabled} onChecks={onChecks} onOrder={onOrder} onRetry={() => void order.refetch()} />;
}

export function ManufacturingHandoffView({ readiness, checking, failed, disabled, onChecks, onOrder, onRetry }: {
  readiness: OrderReadiness | undefined; checking: boolean; failed: boolean; disabled: boolean;
  onChecks: () => void; onOrder: () => void; onRetry: () => void;
}) {
  const verified = !checking && !failed && !!readiness;
  const blocked = verified && !readiness.ready;
  return <section className="fd-manufacturing-handoff" aria-label="Before ordering" data-blocked={blocked}>
    <div className="fd-manufacturing-heading"><Icon name={blocked ? "warning" : "checklist"} width={19} height={19} />
      <h2>{checking ? "Checking saved design readiness…" : failed || !readiness ? "Order readiness unavailable" : blocked ? "Not ready to order" : "Review before ordering"}</h2>
    </div>
    {verified && blocked && <ul>{readiness.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    {verified && !blocked && <p>The saved-file order gate allows review. Confirm component stock, assembly mapping and the manufacturer’s preview separately.</p>}
    <p>You can export draft files now. Creating an export does not approve the design for manufacture.</p>
    <div className="fd-manufacturing-actions"><Button size="sm" disabled={disabled} onClick={onChecks}>Review design checks</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={onOrder}>Order review</Button>
      {failed && <Button size="sm" variant="ghost" disabled={disabled || checking} onClick={onRetry}>Retry readiness check</Button>}
    </div>
  </section>;
}
