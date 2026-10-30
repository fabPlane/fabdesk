import { useAssistantSurface } from "../chat/useAssistantSurface";
import type { OrderVendorId } from "@fabdesk/protocol";
import { useState } from "react";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useCore } from "@fabdesk/client-core";
import { useProjectOrder, useStartOrder } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";

const VENDOR_COPY: Record<OrderVendorId, { blurb: string }> = {
  jlcpcb: { blurb: "Upload a fabrication zip and walk through JLCPCB's quote." },
  pcbway: { blurb: "Upload a fabrication zip and walk through PCBWay's order form." },
  laser: { blurb: "Laser-cut boards will land here later." },
  cnc: { blurb: "CNC isolation milling will land here later." },
};

export function OrderFlow() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const setOrderFlowOpen = useUiStore((s) => s.setOrderFlowOpen);
  const boardOpen = useUiStore((s) => s.boardOpen);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const order = useProjectOrder(projectId);
  const start = useStartOrder();
  const { host } = useCore();
  const [vendor, setVendor] = useState<OrderVendorId | null>(null);
  const session = start.data;
  const vendors = (order.data?.vendors ?? []).filter(item => item.enabled);
  const ready = order.data?.ready === true;
  useAssistantSurface(projectId ? { projectId, scope: "order", label: "Manufacturing / Order review", priority: 10, details: JSON.stringify({ loading: order.isPending, readinessCheckFailed: order.isError, ready, blockers: order.data?.reasons, warnings: order.data?.warnings, selectedVendor: vendor, preparingVendorInstructions: start.isPending, vendorInstructionsAvailable: !!session, instruction: "This screen prepares vendor instructions. It does not confirm an order, quote, upload or payment. Review the saved manufacturing outputs and readiness before ordering." }) } : null);

  if (!projectId) return <EmptyState title="Choose a project before ordering" action={<Button onClick={() => useUiStore.getState().setProjectPickerOpen(true)}>Choose project</Button>} />;
  if (order.isPending || order.isError) return <div className="flex h-full min-h-0 flex-col"><div className="p-3"><Button size="sm" onClick={() => setOrderFlowOpen(false)}>Back to project</Button></div>{order.isPending ? <div className="flex flex-1 items-center justify-center gap-2" role="status"><Spinner />Checking ordering requirements…</div> : <LoadError title="Could not check ordering requirements" onRetry={() => void order.refetch()} />}</div>;

  return (
    <div className="fd-content-pane flex h-full min-w-0 flex-col bg-bg" data-testid="order-flow">
      <div className={cn("fd-screen-header flex items-center justify-between border-b border-border pl-4", boardOpen ? "pr-4" : "pr-[52px]")}>
        <div className="text-sm font-medium">Order now</div>
        <Button size="sm" onClick={() => setOrderFlowOpen(false)}>
          Back
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-xl font-semibold">Where should we fabricate this?</h1>
        <p className="mt-2 max-w-lg text-sm text-muted">
          Choose a supported board manufacturer. For your own fabrication process, use the project’s export files.
        </p>
        <Button className="mt-4" size="sm" onClick={() => { setOrderFlowOpen(false); useUiStore.getState().setWorkspaceArea("outputs"); useUiStore.getState().setWorkspaceTab("files"); }}>Open export files</Button>
        {order.data && !ready && (
          <div
            className="mt-5 max-w-xl rounded-lg border border-danger/40 bg-danger/5 p-4"
            data-testid="order-blockers"
          >
            <div className="text-sm font-semibold text-danger">Board checks must pass before ordering</div>
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
              Review board checks
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
        <div className="fd-order-vendors mt-5 grid max-w-xl grid-cols-2 gap-3">
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
      </div>
    </div>
  );
}
