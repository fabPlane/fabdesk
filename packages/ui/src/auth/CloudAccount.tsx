import { useQueryClient } from "@tanstack/react-query";
import { dashboardUrlFor } from "@fabdesk/protocol";
import { errorPayload, useCloudStatus, useCore, usePatchSettings } from "@fabdesk/client-core";
import { Button, Select, Spinner } from "../components/ui";

/** fabplane dashboard link and the org whose shopping lists and inventory fabdesk uses. */
export function CloudAccount({ dashboardUrl }: { dashboardUrl: string | undefined }) {
  const { host } = useCore();
  const qc = useQueryClient();
  const status = useCloudStatus();
  const patch = usePatchSettings();
  const url =
    status.data?.dashboardUrl ?? dashboardUrl ?? dashboardUrlFor("https://api.fabplane.com");
  const orgs = status.isError ? [] : status.data?.orgs ?? [];
  const statusError = status.isError ? errorPayload(status.error).message : status.data?.error;
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
      {status.isPending && <p role="status"><Spinner /> Loading organization details…</p>}
      {statusError && <div role="alert" className="text-danger">
        Could not load organization details. {statusError}{" "}
        <Button size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>Retry</Button>
      </div>}
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
      {patch.isError && <p role="alert" className="text-danger">
        Could not change organization. {errorPayload(patch.error).message}
      </p>}
    </div>
  );
}
