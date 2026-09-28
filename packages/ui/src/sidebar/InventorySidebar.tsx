import { useCloudStatus } from "@fabdesk/client-core";

/** Sidebar body for the Inventory tab; the list itself is the center pane (InventoryView). */
export function InventorySidebar() {
  const status = useCloudStatus();
  const org = status.data?.orgs.find((o) => o.id === status.data?.activeOrgId);
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 text-xs text-muted" data-testid="inventory-sidebar">
      <div>
        Parts your team has on hand, stored on fabplane.com
        {org ? (
          <>
            {" "}
            in <span className="font-medium text-fg">{org.name}</span>
          </>
        ) : null}
        .
      </div>
      <div>Switch orgs in Settings → Account. Agents can search and add items with the inventory tools.</div>
    </div>
  );
}
