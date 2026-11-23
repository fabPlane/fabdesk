import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { Icon } from "../components/Icon";
import type { OrderVendorId } from "@fabdesk/protocol";
import { useState } from "react";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useProjectOrder, useStartOrder } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";
import { useI18n } from "../i18n";

const VENDOR_COPY: Record<OrderVendorId, { blurb: string }> = {
  jlcpcb: { blurb: "Upload a fabrication zip and walk through JLCPCB's quote." },
  pcbway: { blurb: "Upload a fabrication zip and walk through PCBWay's order form." },
  laser: { blurb: "Laser-cut boards will land here later." },
  cnc: { blurb: "CNC isolation milling will land here later." },
};

export function OrderFlow() {
  const { t } = useI18n();
  const projectId = useUiStore((s) => s.activeProjectId);
  const setOrderFlowOpen = useUiStore((s) => s.setOrderFlowOpen);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const order = useProjectOrder(projectId);
  const start = useStartOrder();
  const { host } = useCore();
  const [vendor, setVendor] = useState<OrderVendorId | null>(null);
  const session = start.data;
  const vendors = (order.data?.vendors ?? []).filter(item => item.enabled);
  const ready = order.data?.ready === true;
  const assistantSurface = projectId ? { projectId, scope: "order" as const, label: "Manufacturing / Order review", priority: 10, details: JSON.stringify({ loading: order.isPending, readinessCheckFailed: order.isError, ready, blockers: order.data?.reasons, warnings: order.data?.warnings, selectedVendor: vendor, preparingVendorInstructions: start.isPending, vendorInstructionsAvailable: !!session, instruction: "This screen prepares vendor instructions. It does not confirm an order, quote, upload or payment. Review the saved manufacturing outputs and readiness before ordering." }) } : null;
  useAssistantSurface(assistantSurface);

  if (!projectId) return <EmptyState title="Choose a project before ordering" action={<Button onClick={() => useUiStore.getState().setProjectPickerOpen(true)}>Choose project</Button>} />;
  if (order.isPending || order.isError) return <div className="flex h-full min-h-0 flex-col"><div className="p-3"><Button size="sm" onClick={() => setOrderFlowOpen(false)}>Back to project</Button></div>{order.isPending ? <div className="flex flex-1 items-center justify-center gap-2" role="status"><Spinner />Checking ordering requirements…</div> : <LoadError title="Could not check ordering requirements" onRetry={() => void order.refetch()} />}</div>;

  return (
    <div className="fd-order-review flex h-full min-w-0 flex-col" data-testid="order-flow">
      <div className="fd-order-toolbar"><Button size="sm" variant="ghost" onClick={() => setOrderFlowOpen(false)}><Icon name="chevronLeft" width={16} height={16} />Back to project</Button><span>Manufacturing</span></div>
      <div className="fd-order-scroll min-h-0 flex-1 overflow-y-auto"><div className="fd-order-content">
        <header><div><h1>Order review</h1><p>Prepare your files, review the design, then continue with a manufacturer.</p></div><CanvasToolButton icon="sparkles" label="Ask about preparing this order" onClick={() => { if (assistantSurface) askAboutSurface(assistantSurface, "Help me understand what remains before ordering this board. Review the saved check blockers and explain the manufacturing and assembly files, quantities and sourcing approvals I need. Do not upload files, place an order or make a payment."); }} /></header>
        <section className="fd-order-preparation" aria-label="Manufacturing preparation"><div><Icon name="checklist" width={22} height={22} /><h2>Review the design</h2><p>Resolve check failures and review warnings after the final PCB and schematic changes.</p></div><div><Icon name="fileLayers" width={22} height={22} /><h2>Prepare manufacturing files</h2><p>Gerbers and drills describe the bare PCB. Assembly also needs a BOM and placement list in your manufacturer’s format.</p></div><div><Icon name="pcb" width={22} height={22} /><h2>Confirm assembly parts</h2><p>Check supplier IDs, immediate assembly stock for your board quantity, polarity and rotations. Review any required sourcing exceptions.</p></div></section>
        <div className="fd-order-file-actions"><Button size="sm" onClick={() => { setOrderFlowOpen(false); useUiStore.getState().setWorkspaceArea("outputs"); useUiStore.getState().setWorkspaceTab("files"); }}>Open export files</Button><Button size="sm" variant="ghost" onClick={() => { setOrderFlowOpen(false); setBoardTab("bom"); }}>Review Parts & BOM</Button></div>
        {order.data && !ready && (
          <div
            className="mt-5 max-w-xl rounded-lg border border-danger/40 bg-danger/5 p-4"
            data-testid="order-blockers"
          >
            <div className="text-sm font-semibold text-danger">{t("order.blockers")}</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {order.data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <Button
              className="mt-3"
              size="sm"
              onClick={() => {
                setBoardTab("drc");
                setOrderFlowOpen(false);
              }}
            >
              {t("order.openDrc")}
            </Button>
          </div>
        )}
        {order.data && order.data.warnings.length > 0 && (
          <ul className="mt-4 max-w-xl list-disc space-y-1 pl-5 text-sm text-muted" data-testid="order-warnings">
            {order.data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <h2 className="fd-order-vendor-heading">Choose a manufacturer</h2><p className="fd-order-vendor-help">This prepares instructions for the manufacturer’s website. Nothing is uploaded or ordered here; no payment is made.</p>
        <div className="fd-order-vendors mt-5 grid grid-cols-2 gap-3">
          {vendors.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={!ready || start.isPending}
              onClick={() => {
                setVendor(item.id);
                if (projectId && item.enabled && ready && !start.isPending) void start.mutateAsync({ projectId, vendor: item.id }).catch(() => {}); // Error is shown below.
              }}
              className={cn(
                "rounded-lg border px-3 py-3 text-left",
                vendor === item.id ? "border-accent bg-accent/10" : "border-border hover:bg-panel-2",
                (!item.enabled || !ready) && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
              data-testid={`order-vendor-${item.id}`}
            >
              <div className="text-sm font-semibold">{item.label}</div>
              <div className="mt-1 text-[12px] text-muted">{VENDOR_COPY[item.id].blurb}</div>
              {!item.enabled && <div className="mt-2 text-[11px] font-medium text-muted">Coming later</div>}
            </button>
          ))}
        </div>
        {session && session.enabled && (
          <ol className="mt-6 max-w-xl list-decimal space-y-3 pl-5 text-sm">
            {session.steps.map((step) => (
              <li key={step.title}>
                <div className="font-medium">{step.title}</div>
                <div className="text-muted">{step.body}</div>
              </li>
            ))}
          </ol>
        )}
        {session?.orderUrl && (
          <Button
            className="mt-5"
            variant="primary"
            onClick={() => void host.openExternal(session.orderUrl!)}
          >
            Open {session.label}
          </Button>
        )}
        {start.isError && <div className="mt-4 text-xs text-danger">{(start.error as Error).message}</div>}
      </div></div>
    </div>
  );
}
