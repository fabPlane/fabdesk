import { useQueryClient } from "@tanstack/react-query";
import { dashboardUrlFor } from "@fabdesk/protocol";
import { useCloudStatus, useCore, usePatchSettings } from "@fabdesk/client-core";
import { Button, Select } from "../components/ui";

/** fabplane dashboard link and the org whose shopping lists and inventory fabdesk uses. */
export function CloudAccount({ dashboardUrl }: { dashboardUrl: string | undefined }) {
  const { host } = useCore();
  const qc = useQueryClient();
  const status = useCloudStatus();
  const patch = usePatchSettings();
  const url =
    status.data?.dashboardUrl ?? dashboardUrl ?? dashboardUrlFor("https://api.fabplane.com");
  const orgs = status.data?.orgs ?? [];
  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="cloud-account">
      <div className="flex items-center gap-2">
        <span className="font-medium">fabplane dashboard</span>
        <Button
          size="sm"
          className="ml-auto"
          onClick={() => void host.openExternal(url)}
          data-testid="open-dashboard"
        >
          Open fabplane dashboard &#8599;
        </Button>
      </div>
      {orgs.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="shrink-0">Active org</span>
          <Select
            className="min-w-0 flex-1"
            value={status.data?.activeOrgId ?? ""}
            disabled={patch.isPending}
            onChange={(e) => {
              const org = orgs.find((o) => o.id === e.target.value);
              patch.mutate(
                { cloudOrgId: org && !org.personal ? org.id : null },
                { onSuccess: () => void qc.invalidateQueries({ queryKey: ["cloud"] }) },
              );
            }}
            data-testid="cloud-org"
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.personal ? `${o.name} (personal)` : o.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      <div className="text-muted">
        Shopping lists and inventory use this org. Manage members, invites and carts in the
        dashboard.
      </div>
      {status.data?.error && <div className="text-danger">{status.data.error}</div>}
    </div>
  );
}
