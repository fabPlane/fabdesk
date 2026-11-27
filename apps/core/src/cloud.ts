/**
 * fabplane.com carts and inventory for the daemon: builds the `CloudService` the `/cloud` routes
 * and the `shopping` tools share. The API client comes from `fabplane-cli`.
 */
import { readCredentials } from "@fabdesk/auth-client";
import type { Settings } from "@fabdesk/protocol";
import { CloudService, withProjectShareHttp, type CloudApi, type CloudApiFactory } from "@fabdesk/tools";
import { FabplaneClient } from "fabplane-cli";

/** The fabplane API client (`vendor/fabplane-cli`). Tests pass `api` to swap in a fake. */
export const cloudApiFactory: CloudApiFactory = (o) =>
  withProjectShareHttp(new FabplaneClient(o) as CloudApi, o);

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

const STORED_TOKEN_REFRESH_MS = 15_000;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Local auth mode never signs the daemon in to fabplane, but `fabdesk-core login` may have left
 * credentials in the same home. Carts and inventory use them when they are for this API origin and
 * unexpired. Reads are cached and refreshed in the background, since `token()` is synchronous.
 */
export function storedCredentialToken(o: {
  home: string;
  apiOrigin: string;
  now?: () => number;
  read?: typeof readCredentials;
}): () => string | null {
  const now = o.now ?? Date.now;
  const read = o.read ?? readCredentials;
  let token: string | null = null;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  const refresh = (): Promise<void> =>
    (inFlight ??= read(o.home)
      .then((creds) => {
        token =
          creds && sameOrigin(creds.apiOrigin, o.apiOrigin) && Date.parse(creds.expiresAt) > now() ? creds.token : null;
      })
      .catch(() => {
        token = null;
      })
      .finally(() => {
        checkedAt = now();
        inFlight = null;
      }));
  void refresh();
  return () => {
    if (now() - checkedAt > STORED_TOKEN_REFRESH_MS) void refresh();
    return token;
  };
}
