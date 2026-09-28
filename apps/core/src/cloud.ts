/**
 * fabplane.com carts and inventory for the daemon: builds the `CloudService` the `/cloud` routes
 * and the `shopping` tools share. The API client comes from `fabplane-cli`.
 */
import type { Settings } from "@fabdesk/protocol";
import { CloudService, type CloudApiFactory } from "@fabdesk/tools";
import { FabplaneClient } from "fabplane-cli";

/** The fabplane API client (`vendor/fabplane-cli`). Tests pass `api` to swap in a fake. */
export const cloudApiFactory: CloudApiFactory = (o) => new FabplaneClient(o);

export function createCloudService(o: {
  apiOrigin: string;
  token: () => string | null;
  settings: () => Settings;
  api?: CloudApiFactory | null;
}): CloudService {
  return new CloudService({
    apiOrigin: o.apiOrigin,
    token: o.token,
    orgSetting: () => o.settings().cloudOrgId,
    api: o.api === undefined ? cloudApiFactory : o.api,
  });
}
