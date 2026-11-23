/**
 * HTTP fallback for project-link sharing when the vendored fabplane client
 * has not yet grown those methods. Paths match the fabplane.com share API.
 */
import { isCloudApiError, type CloudApi, type CloudApiErrorLike } from "./api";

class ShareHttpError extends Error implements CloudApiErrorLike {
  readonly status: number;
  readonly code: string;
  readonly body?: unknown;
  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = "FabplaneApiError";
    this.status = status;
    this.code = code;
    if (body !== undefined) this.body = body;
  }
}

function sharePath(projectId: string): string {
  return `/v1/private/projects/${encodeURIComponent(projectId)}/share`;
}

async function shareRequest(origin: string, token: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers: Record<string, string> = { ...(init.body ? { "content-type": "application/json" } : {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${new URL(origin).origin}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!response.ok) {
    const rec = body && typeof body === "object" ? (body as { error?: string; code?: string; message?: string }) : {};
    throw new ShareHttpError(
      response.status,
      rec.error ?? rec.code ?? `http_${response.status}`,
      rec.message ?? text ?? response.statusText,
      body,
    );
  }
  if (response.status === 204 || text === "") return undefined;
  return body;
}

type ProjectShareHttp = {
  getProjectShare: NonNullable<CloudApi["getProjectShare"]>;
  publishProjectShare: NonNullable<CloudApi["publishProjectShare"]>;
  disableProjectShare: NonNullable<CloudApi["disableProjectShare"]>;
  getSharedProject: NonNullable<CloudApi["getSharedProject"]>;
  getSharedProjectStatus: NonNullable<CloudApi["getSharedProjectStatus"]>;
};

export function projectShareHttp(o: { origin: string; token: string }): ProjectShareHttp {
  return {
    getProjectShare: (projectId) => shareRequest(o.origin, o.token, sharePath(projectId)),
    publishProjectShare: (projectId, snapshot, visibility, options) => {
      const query = new URLSearchParams();
      if (visibility) query.set("visibility", visibility);
      if (options?.updateOnly) query.set("updateOnly", "true");
      const suffix = query.size ? `?${query}` : "";
      return shareRequest(o.origin, o.token, `${sharePath(projectId)}${suffix}`, {
        method: "PUT",
        body: JSON.stringify({ snapshot }),
      });
    },
    disableProjectShare: (projectId) =>
      shareRequest(o.origin, o.token, sharePath(projectId), { method: "DELETE" }),
    getSharedProject: (shareId) =>
      shareRequest(o.origin, o.token, `/v1/public/shared-projects/${encodeURIComponent(shareId)}`),
    getSharedProjectStatus: (shareId) =>
      shareRequest(o.origin, o.token, `/v1/public/shared-projects/${encodeURIComponent(shareId)}/status`),
  };
}

/** Fill missing share methods on an older fabplane client. */
export function withProjectShareHttp(api: CloudApi, o: { origin: string; token: string }): CloudApi {
  if (
    api.getProjectShare &&
    api.publishProjectShare &&
    api.disableProjectShare &&
    api.getSharedProject &&
    api.getSharedProjectStatus
  )
    return api;
  const http = projectShareHttp(o);
  const next = Object.assign(
    Object.create(Object.getPrototypeOf(api) ?? Object.prototype) as CloudApi,
    api,
  );
  next.getProjectShare ??= http.getProjectShare;
  next.publishProjectShare ??= http.publishProjectShare;
  next.disableProjectShare ??= http.disableProjectShare;
  next.getSharedProject ??= http.getSharedProject;
  next.getSharedProjectStatus ??= http.getSharedProjectStatus;
  return next;
}

export function isShareHttpError(error: unknown): error is CloudApiErrorLike {
  return isCloudApiError(error);
}
