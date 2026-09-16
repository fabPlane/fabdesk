import { CloudSettings } from "@fabdesk/protocol";
import { AuthHttpError, normalizeOrigin } from "./device-flow";

export type { CloudSettings };

export type CloudSettingsGet =
  | { ok: true; settings: CloudSettings | null }
  | { ok: false; status: number; error: string };

export type CloudSettingsPut =
  | { ok: true; settings: CloudSettings }
  | { ok: false; status: number; error: string };

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function parseSettings(body: unknown): CloudSettings | null {
  const parsed = CloudSettings.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/**
 * `GET /v1/private/settings`. A 404 means the account has nothing stored yet *or* the API
 * has not shipped the route — both are treated as empty so older backends stay usable.
 * 401/403 are `ok: false` so the caller can sign out.
 */
export async function fetchCloudSettings(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  token: string,
  signal?: AbortSignal,
): Promise<CloudSettingsGet> {
  const path = "/v1/private/settings";
  const res = await fetchImpl(`${normalizeOrigin(apiOrigin)}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, error: "unauthorized" };
  }
  if (res.status === 404) return { ok: true, settings: null };
  if (!res.ok) throw new AuthHttpError(res.status, path, await bodyText(res));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: true, settings: null };
  }
  return { ok: true, settings: parseSettings(body) };
}

/** `PUT /v1/private/settings`. 404 = route not deployed yet; caller keeps the local copy. */
export async function putCloudSettings(
  fetchImpl: typeof fetch,
  apiOrigin: string,
  token: string,
  settings: CloudSettings,
  signal?: AbortSignal,
): Promise<CloudSettingsPut> {
  const path = "/v1/private/settings";
  const res = await fetchImpl(`${normalizeOrigin(apiOrigin)}${path}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(settings),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, error: "unauthorized" };
  }
  if (res.status === 404) return { ok: false, status: 404, error: "not_found" };
  if (!res.ok) throw new AuthHttpError(res.status, path, await bodyText(res));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: true, settings };
  }
  return { ok: true, settings: parseSettings(body) ?? settings };
}

/** Last-write-wins by `updatedAt`. Equal timestamps keep local and skip the network. */
export function mergeCloudSettings(
  local: CloudSettings,
  remote: CloudSettings | null,
): { next: CloudSettings; push: boolean; apply: boolean } {
  if (!remote) return { next: local, push: true, apply: false };
  if (remote.updatedAt > local.updatedAt) return { next: remote, push: false, apply: true };
  if (local.updatedAt > remote.updatedAt) return { next: local, push: true, apply: false };
  return { next: local, push: false, apply: false };
}

/**
 * Phone and daemon each own a subset of the document. Overlay defined fields from `patch`
 * onto `base` so a PUT cannot wipe the other client's keys.
 */
export function overlayCloudSettings(base: CloudSettings | null, patch: CloudSettings): CloudSettings {
  if (!base) return patch;
  const appearance = patch.appearance ?? base.appearance;
  const haptics = patch.haptics ?? base.haptics;
  const keepAwake = patch.keepAwake ?? base.keepAwake;
  const defaultAgent = patch.defaultAgent ?? base.defaultAgent;
  const defaultRuntimeMode = patch.defaultRuntimeMode ?? base.defaultRuntimeMode;
  const errorReporting = patch.errorReporting ?? base.errorReporting;
  const notificationsEnabled = patch.notificationsEnabled ?? base.notificationsEnabled;
  return {
    schema: 1,
    updatedAt: Math.max(base.updatedAt, patch.updatedAt),
    ...(appearance ? { appearance } : {}),
    ...(typeof haptics === "boolean" ? { haptics } : {}),
    ...(typeof keepAwake === "boolean" ? { keepAwake } : {}),
    ...(defaultAgent ? { defaultAgent } : {}),
    ...(defaultRuntimeMode ? { defaultRuntimeMode } : {}),
    ...(typeof errorReporting === "boolean" ? { errorReporting } : {}),
    ...(typeof notificationsEnabled === "boolean" ? { notificationsEnabled } : {}),
  };
}
