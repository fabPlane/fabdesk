import type { OrderVendorId } from "@fabdesk/protocol";
import { useState } from "react";
import { Button } from "../components/ui";
import { useCore } from "../core/CoreProvider";
import { useProjectOrder, useStartOrder } from "../hooks/queries";
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
  const order = useProjectOrder(projectId);
  const start = useStartOrder();
  const { host } = useCore();
  const [vendor, setVendor] = useState<OrderVendorId | null>(null);
  const session = start.data;
  const vendors = order.data?.vendors ?? [];

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg" data-testid="order-flow">
      <div className="flex h-10 items-center justify-between border-b border-border px-4">
        <div className="text-sm font-medium">Order now</div>
        <Button size="sm" onClick={() => setOrderFlowOpen(false)}>
          Back
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <h1 className="text-xl font-semibold">Where should we fabricate this?</h1>
        <p className="mt-2 max-w-lg text-sm text-muted">
          Pick a fab house. Laser and CNC are listed so the path is obvious; they are disabled for now.
        </p>
        <div className="mt-5 grid max-w-xl grid-cols-2 gap-2">
          {vendors.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={!item.enabled}
              onClick={() => {
                setVendor(item.id);
                if (projectId && item.enabled) void start.mutateAsync({ projectId, vendor: item.id });
              }}
              className={cn(
                "rounded-lg border px-3 py-3 text-left",
                vendor === item.id ? "border-accent bg-accent/10" : "border-border hover:bg-panel-2",
                !item.enabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
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
