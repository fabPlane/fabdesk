/**
 * fabplane.com carts and inventory for the daemon: builds the `CloudService` the `/cloud` routes
 * and the `shopping` tools share. The API client comes from `fabplane-cli`.
 */
import type { Settings } from "@fabdesk/protocol";
import { CloudService, type CloudApiFactory } from "@fabdesk/tools";

/**
 * Injection point for the fabplane API client. With `vendor/fabplane-cli` as a workspace:
 *   export const cloudApiFactory: CloudApiFactory | null = (o) => new FabplaneClient(o);
 * Null means this build has no client: `/cloud/status` reports `available: false`.
 */
export const cloudApiFactory: CloudApiFactory | null = null;

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
